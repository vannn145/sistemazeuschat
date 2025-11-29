#!/usr/bin/env node
// Dispara o template confirmacao_personalizada para todos os agendamentos não confirmados de uma data (YYYY-MM-DD)
require('dotenv').config({ override: true });
const db = require('../src/services/database');
const waba = require('../src/services/whatsapp-business');
const { formatClinicDate, formatClinicTime } = require('../src/utils/datetime');

function pickFirstPhone(raw) {
  if (!raw) return null;
  const parts = String(raw).split(/[;|,\n\r\t]/g);
  for (const p of parts) {
    const digits = (p.match(/\d+/g) || []).join('');
    if (!digits) continue;
    let n = digits;
    if (n.startsWith('55')) {
      // ok
    } else if (n.length >= 10 && n.length <= 11) {
      n = '55' + n;
    }
    if (n.length >= 12 && n.length <= 13) return `+${n}`;
  }
  return null;
}

async function main() {
  const [date, limitArg, opt3] = process.argv.slice(2);
  // Define a data inicial para disparo (exemplo: 2025-11-10)
  const startDate = '2025-11-10';
  console.log('Disparando confirmações para agendamentos a partir de:', startDate);
  // Garantir conexão e tabela de logs
  try {
    await db.testConnection();
  } catch (e) {
    console.error('⚠️  Aviso: não foi possível conectar no banco para registrar logs:', e.message);
  }
  const limit = parseInt(limitArg || '0', 10) || 0;
  const templateOnly = (process.env.TEMPLATE_ONLY === 'true') || (opt3 === '--template-only');
  // Busca todos os agendamentos não confirmados a partir da data inicial
  const appts = await db.getUnconfirmedAppointmentsFromDate(startDate);
  const list = Array.isArray(appts) ? appts : [];
  const targets = limit > 0 ? list.slice(0, limit) : list;
  const results = [];
  const templateName = process.env.DEFAULT_CONFIRM_TEMPLATE_NAME || 'confirmao_de_agendamento';

  for (let i = 0; i < targets.length; i++) {
    const a = targets[i];
    const phone = pickFirstPhone(a.patient_contacts) || a.patient_contacts;
    if (!phone) {
      results.push({ id: a.id, patient_name: a.patient_name, success: false, reason: 'no-phone' });
      continue;
    }
    // Montar componentes apenas se o template exigir variáveis
    let components = [];
    if (templateName !== 'confirmao_de_agendamento') {
      const dateBR = formatClinicDate(a.tratamento_date);
      const timeBR = formatClinicTime(a.tratamento_date);
      components = [
        { type: 'body', parameters: [
          { type: 'text', text: a.patient_name },
          { type: 'text', text: dateBR },
          { type: 'text', text: timeBR },
          { type: 'text', text: a.main_procedure_term }
        ]}
      ];
    }
    try {
      const r = await waba.sendTemplateMessage(phone, templateName, 'pt_BR', components, { scheduleId: a.id });
      const messageId = r.messageId || r.response?.messages?.[0]?.id;
      results.push({ id: a.id, patient_name: a.patient_name, phone, success: true, type: 'template', messageId });
      // Registrar log de saída para exibir status no painel
      try {
        if (messageId) {
          await db.logOutboundMessage({ appointmentId: a.id, phone, messageId, type: 'template', templateName, status: 'sent' });
        }
      } catch (_) {}
    } catch (e) {
      const code = e?.response?.data?.error?.code;
      const details = e?.response?.data?.error?.error_data?.details || e.message;
      if (templateOnly) {
        // Não enviar fallback quando exigido template
        results.push({ id: a.id, patient_name: a.patient_name, phone, success: false, type: 'template-failed', reason: details, code });
      } else {
        // Fallback: enviar texto de prévia se template ainda não for reconhecido
        try {
          const msg = waba.generateMessage(a);
          const r2 = await waba.sendMessage(phone, msg, 'text');
          results.push({ id: a.id, patient_name: a.patient_name, phone, success: true, type: 'text-fallback', reason: details, messageId: r2.messageId });
          try {
            if (r2?.messageId) {
              await db.logOutboundMessage({ appointmentId: a.id, phone, messageId: r2.messageId, type: 'text', templateName: null, status: 'sent' });
            }
          } catch (_) {}
        } catch (e2) {
          results.push({ id: a.id, patient_name: a.patient_name, phone, success: false, type: 'failed', reason: details + ' | ' + (e2.response?.data || e2.message) });
        }
      }
    }
    if (i < targets.length - 1) await new Promise(r => setTimeout(r, 1000));
  }

  console.log(JSON.stringify({ date, total: targets.length, ok: results.filter(r => r.success).length, fail: results.filter(r => !r.success).length, results }, null, 2));
}

main();
