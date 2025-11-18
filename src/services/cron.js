const db = require('./database');
const waba = require('./whatsapp-business');

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
    this.timer = null;
    this.running = false;
    this.lastRun = null;
    this.lastResult = null;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      running: this.running,
      intervalMs: this.intervalMs,
      lookbackDays: this.lookbackDays,
      lookaheadDays: this.lookaheadDays,
      batchSize: this.batchSize,
      lastRun: this.lastRun,
      lastResult: this.lastResult,
    };
  }

  async runOnce() {
    if (this.running) return { skipped: true, reason: 'already_running' };
    this.running = true;
    const startedAt = new Date();
    const summary = { startedAt, attempted: 0, sent: 0, failed: 0, items: [] };
    try {
      // Garante que a tabela de logs existe
      try { await db.initMessageLogs?.(); } catch {}

      // Buscar pendentes na janela e sem template enviado previamente
      const appts = await db.getPendingInWindowNoTemplate(
        this.lookbackDays,
        this.lookaheadDays,
        this.batchSize
      );
      summary.attempted = appts.length;
      if (appts.length === 0) {
        this.lastRun = new Date();
        this.lastResult = { ...summary, finishedAt: new Date() };
        this.running = false;
        return this.lastResult;
      }

      const templateName = process.env.DEFAULT_CONFIRM_TEMPLATE_NAME || 'confirmacao_personalizada';
      const locale = process.env.DEFAULT_CONFIRM_TEMPLATE_LOCALE || 'pt_BR';

      for (let i = 0; i < appts.length; i++) {
        const a = appts[i];
        try {
          const date = new Date(a.tratamento_date);
          const dateBR = date.toLocaleDateString('pt-BR');
          const timeBR = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
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

          const result = await waba.sendTemplateMessage(phone, templateName, locale, components);
          if (result?.messageId) {
            await db.logOutboundMessage({ appointmentId: a.id, phone, messageId: result.messageId, type: 'template', templateName, status: 'sent' });
          }
          summary.sent++;
          summary.items.push({ id: a.id, success: true, phone, messageId: result?.messageId || null });

          // backoff leve para evitar rate limit
          if (i < appts.length - 1) {
            await new Promise(r => setTimeout(r, 800));
          }
        } catch (err) {
          const details = err?.response?.data || err?.message || String(err);
          summary.failed++;
          summary.items.push({ id: a.id, success: false, error: details });
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
