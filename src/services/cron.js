const db = require('./database');
const waba = require('./whatsapp-business');
const { formatClinicDate, formatClinicTime } = require('../utils/datetime');

function pickFirstPhone(raw) {
  if (!raw) return null;
  const parts = String(raw).split(/[;|,\n\r\t]/g);
  for (const p of parts) {
    const digits = (p.match(/\d+/g) || []).join('');
    if (!digits) continue;
    let n = digits;
    if (!n.startsWith('55')) {
      if (n.length >= 10 && n.length <= 11) n = '55' + n;
    }
    if (n.length >= 12 && n.length <= 13) return `+${n}`;
  }
  return null;
}

class CronService {
  constructor() {
    this.enabled = String(process.env.CRON_ENABLED || 'false').toLowerCase() === 'true';
    this.intervalMs = Number(process.env.CRON_INTERVAL_MS || 60000);
    this.lookbackDays = Number(process.env.CRON_LOOKBACK_DAYS || 1);
    this.lookaheadDays = Number(process.env.CRON_LOOKAHEAD_DAYS || 14);
    this.batchSize = Number(process.env.CRON_BATCH_SIZE || 30);
    this.timeZone = process.env.CRON_TIMEZONE || 'America/Sao_Paulo';
    this.dispatchLeadDays = Number(process.env.CRON_DISPATCH_LEAD_DAYS || 1);
    this.timer = null;
    this.running = false;
    this.lastRun = null;
    this.lastResult = null;
  }

  toTimeZone(date) {
    const source = date instanceof Date ? date : new Date(date);
    const localized = source.toLocaleString('en-US', { timeZone: this.timeZone });
    return new Date(localized);
  }

  nowInTimeZone() {
    return this.toTimeZone(new Date());
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

  dateKey(date) {
    return this.startOfDay(date).toISOString().slice(0, 10);
  }

  getStatus() {
    return {
      enabled: this.enabled,
      running: this.running,
      intervalMs: this.intervalMs,
      lookbackDays: this.lookbackDays,
      lookaheadDays: this.lookaheadDays,
      batchSize: this.batchSize,
      timeZone: this.timeZone,
      dispatchLeadDays: this.dispatchLeadDays,
      lastRun: this.lastRun,
      lastResult: this.lastResult,
    };
  }

  async runOnce() {
    if (this.running) return { skipped: true, reason: 'already_running' };
    this.running = true;
    const startedAt = new Date();
    const summary = {
      startedAt,
      attempted: 0,
      sent: 0,
      failed: 0,
      items: [],
      queued: 0,
      filtered: 0,
      targetDate: null,
      skipped: false
    };
    try {
      // Garante que a tabela de logs existe
      try { await db.initMessageLogs?.(); } catch {}

      const templateName = process.env.DEFAULT_CONFIRM_TEMPLATE_NAME || 'confirmacao_personalizada';
      const locale = process.env.DEFAULT_CONFIRM_TEMPLATE_LOCALE || 'pt_BR';

      const nowTz = this.nowInTimeZone();
      const todayStart = this.startOfDay(nowTz);
      const todayEnd = this.addDays(todayStart, 1);
      const targetStart = this.addDays(todayStart, this.dispatchLeadDays);
      const targetEnd = this.addDays(targetStart, 1);
      const targetKey = this.dateKey(targetStart);
      summary.targetDate = targetKey;

      const alreadySentToday = await db.hasTemplateLogsBetween(todayStart, todayEnd, templateName);
      if (alreadySentToday) {
        summary.skipped = true;
        summary.reason = 'already_sent_today';
        this.lastRun = new Date();
        this.lastResult = { ...summary, finishedAt: new Date() };
        this.running = false;
        return this.lastResult;
      }

      // Buscar pendentes na janela e sem template enviado previamente
      const appts = await db.getPendingInWindowNoTemplate(
        this.lookbackDays,
        this.lookaheadDays,
        this.batchSize
      );
      summary.queued = appts.length;

      const candidates = appts.filter((a) => {
        if (!a?.tratamento_date) return false;
        const apptDate = this.startOfDay(a.tratamento_date);
        return apptDate >= targetStart && apptDate < targetEnd;
      });

      summary.filtered = candidates.length;
      summary.attempted = candidates.length;

      if (candidates.length === 0) {
        this.lastRun = new Date();
        this.lastResult = { ...summary, finishedAt: new Date() };
        this.running = false;
        return this.lastResult;
      }

      for (let i = 0; i < candidates.length; i++) {
        const a = candidates[i];
        try {
          const dateBR = formatClinicDate(a.tratamento_date);
          const timeBR = formatClinicTime(a.tratamento_date);
          const phone = pickFirstPhone(a.patient_contacts) || a.patient_contacts;
          if (!phone) {
            summary.items.push({ id: a.id, success: false, error: 'no_phone' });
            summary.failed++;
            continue;
          }

          let components = [];
          if (templateName !== 'confirmao_de_agendamento') {
            components = [
              { type: 'body', parameters: [
                { type: 'text', text: a.patient_name },
                { type: 'text', text: dateBR },
                { type: 'text', text: timeBR },
                { type: 'text', text: a.main_procedure_term }
              ]}
            ];
          }

          const result = await waba.sendTemplateMessage(phone, templateName, locale, components, { scheduleId: a.id });
          if (result?.messageId) {
            await db.logOutboundMessage({ appointmentId: a.id, phone, messageId: result.messageId, type: 'template', templateName, status: 'sent' });
          }
          summary.sent++;
          summary.items.push({ id: a.id, success: true, phone, messageId: result?.messageId || null });

          // backoff leve para evitar rate limit
          if (i < candidates.length - 1) {
            await new Promise(r => setTimeout(r, 800));
          }
        } catch (err) {
          const details = err?.response?.data || err?.message || String(err);
          summary.failed++;
          summary.items.push({ id: a.id, success: false, error: details });
          try {
            const placeholderId = `failed-${a.id || 'unknown'}-${Date.now()}`;
            await db.logOutboundMessage({
              appointmentId: a.id,
              phone,
              messageId: placeholderId,
              type: 'template',
              templateName,
              status: 'failed',
              errorDetails: details,
              retryCount: 0,
              nextRetryAt: null,
              lastAttemptAt: new Date()
            });
          } catch (logError) {
            console.log('⚠️  Falha ao registrar erro do template:', logError.message);
          }
        }
      }

      this.lastRun = new Date();
      this.lastResult = { ...summary, finishedAt: new Date() };
      this.running = false;
      return this.lastResult;
    } catch (e) {
      this.lastRun = new Date();
      this.lastResult = { ...summary, finishedAt: new Date(), error: e?.message || String(e) };
      this.running = false;
      return this.lastResult;
    }
  }

  start() {
    if (!this.enabled) return false;
    if (this.timer) return true;
    this.timer = setInterval(() => this.runOnce().catch(() => {}), this.intervalMs);
    // disparo imediato na partida
    this.runOnce().catch(() => {});
    return true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }
}

module.exports = new CronService();
