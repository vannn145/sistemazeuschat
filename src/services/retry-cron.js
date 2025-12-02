const db = require('./database');
const whatsappBusiness = require('./whatsapp-business');
const { formatClinicDate, formatClinicTime } = require('../utils/datetime');

class RetryCronService {
    constructor() {
        this.enabled = String(process.env.RETRY_CRON_ENABLED || 'false').toLowerCase() === 'true';
        this.intervalMs = Number(process.env.RETRY_CRON_INTERVAL_MS || 300000);
        this.batchSize = Number(process.env.RETRY_CRON_BATCH_SIZE || 20);
        this.maxAttempts = Number(process.env.RETRY_CRON_MAX_ATTEMPTS || 3);
        this.backoffBaseSeconds = Number(process.env.RETRY_CRON_BACKOFF_BASE_SECONDS || 90);
        this.retryStatuses = this.parseList(process.env.RETRY_CRON_STATUSES, ['failed', 'error']);
        this.retryTypes = this.parseList(process.env.RETRY_CRON_TYPES, ['template', 'reminder']);
        this.stateSyncEnabled = String(process.env.RETRY_CRON_SYNC_STATES || 'true').toLowerCase() === 'true';
        this.stateBatchSize = Number(process.env.RETRY_CRON_STATE_BATCH_SIZE || 20);
        this.stateLookbackMinutes = Number(process.env.RETRY_CRON_STATE_LOOKBACK_MINUTES || 1440);
        this.resendTemplates = String(process.env.RETRY_CRON_RESEND_TEMPLATES || 'false').toLowerCase() === 'true';
        this.timer = null;
        this.running = false;
        this.lastRun = null;
        this.lastResult = null;
    }

    parseList(value, fallback) {
        if (!value) {
            return fallback;
        }
        if (Array.isArray(value)) {
            return value;
        }
        return String(value)
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    }

    isEnabled() {
        return this.enabled;
    }

    computeBackoff(attemptNumber) {
        const base = Number.isFinite(this.backoffBaseSeconds) && this.backoffBaseSeconds > 0
            ? this.backoffBaseSeconds
            : 90;
        const multiplier = Math.max(0, Number(attemptNumber) - 1);
        const delayMs = base * Math.pow(2, multiplier) * 1000;
        return new Date(Date.now() + delayMs);
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
                console.error('⚠️  RetryCron runOnce falhou:', err?.message || err);
            });
        }, this.intervalMs);
        this.runOnce().catch((err) => {
            console.error('⚠️  RetryCron primeira execução falhou:', err?.message || err);
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
            retried: 0,
            succeeded: 0,
            failed: 0,
            skipped: 0,
            synced: 0,
            items: []
        };

        try {
            if (this.resendTemplates) {
                const retryLogs = await db.getMessageLogsForRetry({
                    limit: this.batchSize,
                    statuses: this.retryStatuses,
                    types: this.retryTypes,
                    maxRetryCount: this.maxAttempts
                });

                for (const log of retryLogs) {
                    await this.retryTemplateSend(log, summary);
                }
            } else if (summary) {
                summary.notes = summary.notes || [];
                summary.notes.push('template_resend_disabled');
            }

            if (this.stateSyncEnabled) {
                await this.syncConfirmationAndCancellation(summary);
            }
        } catch (err) {
            summary.error = err?.message || String(err);
            console.error('❌ Erro no RetryCron:', err);
        } finally {
            this.running = false;
            const finishedAt = new Date();
            summary.finishedAt = finishedAt;
            this.lastRun = finishedAt;
            this.lastResult = summary;
        }

        return summary;
    }

    buildTemplateComponents(appointment, templateName) {
        if (!appointment) {
            return [];
        }

        const normalizedTemplate = templateName || process.env.DEFAULT_CONFIRM_TEMPLATE_NAME || 'confirmacao_personalizada';
        if (normalizedTemplate === 'confirmao_de_agendamento') {
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

    async retryTemplateSend(log, summary) {
        const attemptNumber = Number(log.retry_count || 0) + 1;
        summary.retried++;
        await db.updateMessageLogById(log.id, {
            status: 'retrying',
            retry_count: attemptNumber,
            next_retry_at: null,
            last_attempt_at: new Date()
        });

        try {
            const scheduleId = log.appointment_id ? Number(log.appointment_id) : null;
            let appointment = null;
            if (scheduleId) {
                try {
                    appointment = await db.getAppointmentById(scheduleId);
                } catch (lookupError) {
                    console.log('⚠️  RetryCron falhou ao carregar agendamento:', lookupError.message);
                }
            }

            if (!appointment) {
                await db.updateMessageLogById(log.id, {
                    status: 'discarded',
                    error_details: 'Agendamento não encontrado para retentativa',
                    next_retry_at: null
                });
                summary.skipped++;
                summary.items.push({ id: log.id, type: log.type, success: false, error: 'missing_appointment' });
                return;
            }

            const phone = log.phone || appointment.patient_contacts || null;
            if (!phone) {
                await db.updateMessageLogById(log.id, {
                    status: 'failed',
                    error_details: 'Telefone ausente para retentativa',
                    next_retry_at: this.computeBackoff(attemptNumber)
                });
                summary.failed++;
                summary.items.push({ id: log.id, type: log.type, success: false, error: 'missing_phone' });
                return;
            }

            const templateName = log.template_name || process.env.DEFAULT_CONFIRM_TEMPLATE_NAME || 'confirmacao_personalizada';
            const language = process.env.DEFAULT_CONFIRM_TEMPLATE_LOCALE || 'pt_BR';
            const components = this.buildTemplateComponents(appointment, templateName);
            const sendResult = await whatsappBusiness.sendTemplateMessage(
                phone,
                templateName,
                language,
                components,
                { scheduleId: appointment.id }
            );

            await db.updateMessageLogById(log.id, {
                status: 'sent',
                message_id: sendResult?.messageId || log.message_id,
                error_details: null,
                next_retry_at: null
            });

            if (appointment?.id) {
                try {
                    await db.updateLatestLogStatus(appointment.id, 'sent');
                } catch (updateErr) {
                    console.log('⚠️  RetryCron não conseguiu atualizar latest status:', updateErr.message);
                }
            }

            summary.succeeded++;
            summary.items.push({ id: log.id, type: log.type, success: true, messageId: sendResult?.messageId || null });
        } catch (err) {
            const nextRetryAt = this.computeBackoff(attemptNumber);
            const errorDetails = err?.response?.data || err?.message || String(err);
            await db.updateMessageLogById(log.id, {
                status: 'failed',
                error_details: errorDetails,
                next_retry_at: nextRetryAt
            });
            summary.failed++;
            summary.items.push({ id: log.id, type: log.type, success: false, error: errorDetails });
        }
    }

    async syncConfirmationAndCancellation(summary) {
        const candidates = await db.getRecentLogsByType({
            types: ['confirmation', 'cancellation'],
            statuses: ['confirmed', 'cancelled'],
            limit: this.stateBatchSize,
            lookbackMinutes: this.stateLookbackMinutes
        });

        for (const log of candidates) {
            const scheduleId = log.appointment_id ? Number(log.appointment_id) : null;
            if (!scheduleId || Number.isNaN(scheduleId)) {
                await db.updateMessageLogById(log.id, {
                    status: `${log.status}_synced`,
                    next_retry_at: null
                });
                summary.synced++;
                continue;
            }

            let appointment = null;
            try {
                appointment = await db.getAppointmentById(scheduleId);
            } catch (err) {
                console.log('⚠️  RetryCron falhou ao buscar agendamento para sync:', err.message);
            }

            if (log.type === 'confirmation') {
                await this.syncConfirmationLog(log, appointment, summary);
            } else if (log.type === 'cancellation') {
                await this.syncCancellationLog(log, appointment, summary);
            }
        }
    }

    async syncConfirmationLog(log, appointment, summary) {
        const scheduleId = Number(log.appointment_id);
        const alreadyConfirmed = Boolean(appointment?.confirmed);

        if (alreadyConfirmed) {
            await db.updateMessageLogById(log.id, {
                status: 'confirmed_synced',
                next_retry_at: null
            });
            summary.synced++;
            summary.items.push({ id: log.id, type: log.type, success: true, reason: 'already_confirmed' });
            return;
        }

        const attemptNumber = Number(log.retry_count || 0) + 1;

        try {
            await db.confirmAppointment(scheduleId);
            await db.updateMessageLogById(log.id, {
                status: 'confirmed_synced',
                retry_count: attemptNumber,
                next_retry_at: null
            });
            summary.synced++;
            summary.items.push({ id: log.id, type: log.type, success: true, reason: 'confirmed_again' });
        } catch (err) {
            const nextRetryAt = this.computeBackoff(attemptNumber);
            await db.updateMessageLogById(log.id, {
                status: 'confirmed',
                retry_count: attemptNumber,
                next_retry_at: nextRetryAt,
                error_details: err?.message || String(err)
            });
            summary.failed++;
            summary.items.push({ id: log.id, type: log.type, success: false, error: err?.message || String(err) });
        }
    }

    async syncCancellationLog(log, appointment, summary) {
        const scheduleId = Number(log.appointment_id);
        const activeFlag = appointment && Object.prototype.hasOwnProperty.call(appointment, 'active')
            ? appointment.active
            : null;
        const maybeAlreadyCancelled = !appointment || activeFlag === false;

        if (maybeAlreadyCancelled) {
            await db.updateMessageLogById(log.id, {
                status: 'cancelled_synced',
                next_retry_at: null,
                error_details: null
            });
            summary.synced++;
            summary.items.push({ id: log.id, type: log.type, success: true, reason: 'already_cancelled' });
            return;
        }

        const attemptNumber = Number(log.retry_count || 0) + 1;

        try {
            await db.cancelAppointment(scheduleId, {
                phone: appointment?.patient_contacts || log.phone || null,
                messageBody: 'Cancelamento reforçado automaticamente.',
                cancelledBy: 'retry-cron',
                source: 'retry-cron'
            });
            await db.updateMessageLogById(log.id, {
                status: 'cancelled_synced',
                retry_count: attemptNumber,
                next_retry_at: null,
                error_details: null
            });
            summary.synced++;
            summary.items.push({ id: log.id, type: log.type, success: true, reason: 'cancelled_again' });
        } catch (err) {
            const nextRetryAt = this.computeBackoff(attemptNumber);
            const errorDetails = err?.message || String(err);
            await db.updateMessageLogById(log.id, {
                status: 'cancelled',
                retry_count: attemptNumber,
                next_retry_at: nextRetryAt,
                error_details: errorDetails
            });
            summary.failed++;
            summary.items.push({ id: log.id, type: log.type, success: false, error: errorDetails });
        }
    }

    getStatus() {
        return {
            enabled: this.enabled,
            running: this.running,
            intervalMs: this.intervalMs,
            batchSize: this.batchSize,
            lastRun: this.lastRun,
            lastResult: this.lastResult
        };
    }
}

module.exports = new RetryCronService();
