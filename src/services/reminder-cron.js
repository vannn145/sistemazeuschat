const db = require('./database');
const waba = require('./whatsapp-business');
const { formatClinicDate, formatClinicTime } = require('../utils/datetime');

function pickFirstPhone(raw) {
    if (!raw) {
        return null;
    }
    const parts = String(raw).split(/[;|,\n\r\t]/g);
    for (const piece of parts) {
        const digits = (piece.match(/\d+/g) || []).join('');
        if (!digits) {
            continue;
        }
        let normalized = digits;
        if (!normalized.startsWith('55')) {
            if (normalized.length >= 10 && normalized.length <= 11) {
                normalized = `55${normalized}`;
            }
        }
        if (normalized.length >= 12 && normalized.length <= 13) {
            return `+${normalized}`;
        }
    }
    return null;
}

class ReminderCronService {
    constructor() {
        this.enabled = String(process.env.REMINDER_CRON_ENABLED || 'false').toLowerCase() === 'true';
        this.intervalMs = Number(process.env.REMINDER_CRON_INTERVAL_MS || 300000);
        this.leadDays = Number(process.env.REMINDER_CRON_LEAD_DAYS || 1);
        this.lookbackMinutes = Number(process.env.REMINDER_CRON_LOOKBACK_MINUTES || 60);
        this.batchSize = Number(process.env.REMINDER_CRON_BATCH_SIZE || 40);
        this.requireConfirmed = String(process.env.REMINDER_CRON_REQUIRE_CONFIRMED || 'false').toLowerCase() === 'true';
        this.timeZone = process.env.REMINDER_CRON_TIMEZONE || process.env.CRON_TIMEZONE || 'America/Sao_Paulo';
        this.timer = null;
        this.running = false;
        this.lastRun = null;
        this.lastResult = null;
    }

    isEnabled() {
        return this.enabled;
    }

    toTimeZone(date) {
        const source = date instanceof Date ? date : new Date(date);
        const localized = source.toLocaleString('en-US', { timeZone: this.timeZone });
        return new Date(localized);
    }

    startOfDay(date) {
        const zoned = this.toTimeZone(date);
        zoned.setHours(0, 0, 0, 0);
        return zoned;
    }

    addDays(date, days) {
        const result = new Date(date.getTime());
        result.setDate(result.getDate() + days);
        return result;
    }

    start() {
        if (!this.enabled) {
            return false;
        }
        if (this.timer) {
            return true;
        }
        this.timer = setInterval(() => {
            this.runOnce().catch((err) => {
                console.error('⚠️  ReminderCron runOnce falhou:', err?.message || err);
            });
        }, this.intervalMs);
        this.runOnce().catch((err) => {
            console.error('⚠️  ReminderCron primeira execução falhou:', err?.message || err);
        });
        return true;
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
        }
        this.timer = null;
        this.running = false;
    }

    buildComponents(appointment) {
        if (!appointment) {
            return [];
        }
        const when = appointment.tratamento_date instanceof Date
            ? appointment.tratamento_date
            : (appointment.tratamento_date ? new Date(appointment.tratamento_date) : new Date());
        const patientName = appointment.patient_name || 'Paciente';
        const procedure = appointment.main_procedure_term || 'Procedimento';
        const dateBR = formatClinicDate(when);
        const timeBR = formatClinicTime(when);

        return [
            {
                type: 'body',
                parameters: [
                    { type: 'text', text: patientName },
                    { type: 'text', text: dateBR },
                    { type: 'text', text: timeBR },
                    { type: 'text', text: procedure }
                ]
            }
        ];
    }

    async runOnce() {
        if (!this.enabled) {
            return { skipped: true, reason: 'disabled' };
        }
        if (this.running) {
            return { skipped: true, reason: 'already_running' };
        }

        this.running = true;
        const summary = {
            startedAt: new Date(),
            attempted: 0,
            sent: 0,
            failed: 0,
            skipped: 0,
            items: [],
            targetDate: null
        };

        try {
            const reminderName = process.env.REMINDER_TEMPLATE_NAME || 'lembrete_consulta_cdcenter';
            const reminderLocale = process.env.REMINDER_TEMPLATE_LOCALE || 'pt_BR';
            const nowZoned = this.toTimeZone(new Date());
            const todayStart = this.startOfDay(nowZoned);
            const targetStart = this.addDays(todayStart, this.leadDays);
            const targetEnd = this.addDays(targetStart, 1);
            summary.targetDate = targetStart.toISOString().slice(0, 10);

            const lookbackStart = this.lookbackMinutes && this.lookbackMinutes > 0
                ? new Date(Date.now() - this.lookbackMinutes * 60000)
                : null;

            if (lookbackStart) {
                try {
                    const recentLogs = await db.getRecentLogsByType({
                        types: ['reminder'],
                        limit: this.batchSize,
                        lookbackMinutes: this.lookbackMinutes
                    });
                    if (Array.isArray(recentLogs) && recentLogs.length >= this.batchSize) {
                        summary.skipped = recentLogs.length;
                        summary.reason = 'recent_activity';
                    }
                } catch (error) {
                    if (error.code === 'ZEUS_DB_TIMEOUT') {
                        console.warn('⚠️  ReminderCron ignorou verificação de logs por timeout.');
                        summary.reason = 'recent_activity_timeout';
                    } else {
                        throw error;
                    }
                }
            }

            const appointments = await db.getAppointmentsForReminder({
                startDate: targetStart,
                endDate: targetEnd,
                limit: this.batchSize,
                requireConfirmed: this.requireConfirmed
            });

            summary.attempted = appointments.length;

            if (appointments.length === 0) {
                return summary;
            }

            console.log('🔔 Reminder cron localizado', appointments.length, 'agendamentos para', summary.targetDate);

            for (const appointment of appointments) {
                const phone = pickFirstPhone(appointment.patient_contacts) || appointment.patient_contacts || null;
                if (!phone) {
                    summary.failed++;
                    summary.items.push({ id: appointment.id, success: false, error: 'no_phone' });
                    console.log('⚠️  Reminder cron sem telefone para agendamento', appointment.id);
                    continue;
                }

                try {
                    const components = this.buildComponents(appointment);
                    const result = await waba.sendTemplateMessage(
                        phone,
                        reminderName,
                        reminderLocale,
                        components,
                        { scheduleId: appointment.id }
                    );

                    try {
                        await db.logOutboundMessage({
                            appointmentId: appointment.id,
                            phone,
                            messageId: result?.messageId || null,
                            type: 'reminder',
                            templateName: reminderName,
                            status: 'sent'
                        });
                    } catch (logError) {
                        if (logError.code === 'ZEUS_DB_TIMEOUT') {
                            console.warn('⚠️  ReminderCron não conseguiu registrar envio por timeout.', { appointmentId: appointment.id });
                        } else {
                            throw logError;
                        }
                    }

                    summary.sent++;
                    summary.items.push({ id: appointment.id, success: true, messageId: result?.messageId || null });
                } catch (err) {
                    const errorDetails = err?.response?.data || err?.message || String(err);
                    try {
                        await db.logOutboundMessage({
                            appointmentId: appointment.id,
                            phone,
                            messageId: `reminder-failed-${appointment.id}-${Date.now()}`,
                            type: 'reminder',
                            templateName: reminderName,
                            status: 'failed',
                            errorDetails
                        });
                    } catch (logError) {
                        if (logError.code === 'ZEUS_DB_TIMEOUT') {
                            console.warn('⚠️  ReminderCron não conseguiu registrar falha por timeout.', { appointmentId: appointment.id });
                        } else {
                            console.error('⚠️  ReminderCron erro registrando falha:', logError);
                        }
                    }
                    summary.failed++;
                    summary.items.push({ id: appointment.id, success: false, error: errorDetails });
                }
            }
        } catch (err) {
            summary.error = err?.message || String(err);
            console.error('❌ Erro no ReminderCron:', err);
        } finally {
            this.running = false;
            const finishedAt = new Date();
            summary.finishedAt = finishedAt;
            this.lastRun = finishedAt;
            this.lastResult = summary;
        }

        return summary;
    }

    getStatus() {
        return {
            enabled: this.enabled,
            running: this.running,
            intervalMs: this.intervalMs,
            leadDays: this.leadDays,
            lastRun: this.lastRun,
            lastResult: this.lastResult
        };
    }
}

module.exports = new ReminderCronService();
