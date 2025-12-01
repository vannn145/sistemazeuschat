#!/usr/bin/env node
require('dotenv').config({ override: true });
const db = require('../src/services/database');
const waba = require('../src/services/whatsapp-business');
const { formatClinicDate, formatClinicTime } = require('../src/utils/datetime');

function pickFirstPhone(raw) {
  if (!raw) {
    return null;
  }

  const parts = String(raw).split(/[;|,\n\r\t]/g);
  for (const part of parts) {
    const digits = (part.match(/\d+/g) || []).join('');
    if (!digits) {
      continue;
    }

    let normalized = digits;
    if (!normalized.startsWith('55') && normalized.length >= 10 && normalized.length <= 11) {
      normalized = `55${normalized}`;
    }

    if (normalized.length >= 12 && normalized.length <= 13) {
      return `+${normalized}`;
    }
  }

  return null;
}

async function main() {
  const [dateArg, limitArg] = process.argv.slice(2);
  if (!dateArg) {
    console.error('Uso: node scripts/send-confirmations-by-date.js YYYY-MM-DD [limit]');
    process.exit(1);
  }

  const limit = Number.parseInt(limitArg || '0', 10) || 0;
  const templateName = process.env.DEFAULT_CONFIRM_TEMPLATE_NAME || 'confirmacao_personalizada';
  const locale = process.env.DEFAULT_CONFIRM_TEMPLATE_LOCALE || 'pt_BR';

  try {
    await db.testConnection();
  } catch (err) {
    console.error('Erro ao conectar no banco:', err.message);
    process.exit(1);
  }

  const all = await db.getUnconfirmedAppointments(dateArg);
  const targets = limit > 0 ? all.slice(0, limit) : all;

  const summary = {
    date: dateArg,
    total: targets.length,
    sent: 0,
    failed: 0,
    items: []
  };

  for (let index = 0; index < targets.length; index++) {
    const appointment = targets[index];
    const phone = pickFirstPhone(appointment.patient_contacts) || appointment.patient_contacts;

    if (!phone) {
      summary.failed += 1;
      summary.items.push({ id: appointment.id, patient: appointment.patient_name, success: false, error: 'no_phone' });
      continue;
    }

    const dateText = formatClinicDate(appointment.tratamento_date);
    const timeText = formatClinicTime(appointment.tratamento_date);
    const procedureText = appointment.main_procedure_term || 'Consulta';

    const components = [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: appointment.patient_name },
          { type: 'text', text: dateText },
          { type: 'text', text: timeText },
          { type: 'text', text: procedureText }
        ]
      }
    ];

    try {
      const response = await waba.sendTemplateMessage(phone, templateName, locale, components, { scheduleId: appointment.id });
      const messageId = response?.messageId || response?.response?.messages?.[0]?.id || null;

      if (messageId) {
        try {
          await db.logOutboundMessage({
            appointmentId: appointment.id,
            phone,
            messageId,
            type: 'template',
            templateName,
            status: 'sent'
          });
        } catch (logErr) {
          console.warn('[warn] Falha ao registrar log do envio:', logErr.message);
        }
      }

      summary.sent += 1;
      summary.items.push({ id: appointment.id, patient: appointment.patient_name, phone, success: true, messageId });
    } catch (err) {
      const reason = err?.response?.data || err?.message || String(err);
      summary.failed += 1;
      summary.items.push({ id: appointment.id, patient: appointment.patient_name, phone, success: false, error: reason });
    }

    if (index < targets.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 900));
    }
  }

  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch(err => {
    console.error('Erro geral:', err?.message || err);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await db.pool.end();
    } catch (_) {}
  });
