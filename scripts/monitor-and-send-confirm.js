#!/usr/bin/env node
// Monitora a aprovação do template confirmacao_personalizada e, ao aprovar, envia para o paciente informado
const axios = require('axios');
require('dotenv').config({ override: true });
const db = require('../src/services/database');
const waba = require('../src/services/whatsapp-business');
const { formatClinicDate, formatClinicTime } = require('../src/utils/datetime');

const TEMPLATE_NAME = process.env.CONFIRM_TEMPLATE_NAME || 'confirmacao_personalizada';
const LANGUAGE = 'pt_BR';

async function getTemplateStatus(name) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v21.0';
  const url = `https://graph.facebook.com/${apiVersion}/${wabaId}/message_templates`;
  const { data } = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    params: { limit: 100 }
  });
  const items = data?.data || [];
  return items.find(t => t.name === name && (t.language === LANGUAGE || !t.language));
}

async function sendByName(patientName, phone) {
  const appt = await db.getAppointmentByPatientName(patientName);
  if (!appt) throw new Error('Nenhum agendamento encontrado para: ' + patientName);
  const dateBR = formatClinicDate(appt.tratamento_date);
  const timeBR = formatClinicTime(appt.tratamento_date);
  const components = [
    { type: 'body', parameters: [
      { type: 'text', text: appt.patient_name },
      { type: 'text', text: dateBR },
      { type: 'text', text: timeBR },
      { type: 'text', text: appt.main_procedure_term }
    ]}
  ];
  return await waba.sendTemplateMessage(phone, TEMPLATE_NAME, LANGUAGE, components, { scheduleId: appt.id });
}

async function main() {
  const args = process.argv.slice(2);
  const patientName = args.length > 1 ? args.slice(0, -1).join(' ') : 'MARIANA MORLIM DE CARVALHO';
  const phone = args.length ? args[args.length - 1] : '+5511998420069';

  console.log(JSON.stringify({ action: 'monitor-start', template: TEMPLATE_NAME, patientName, phone }, null, 2));

  for (let attempt = 1; attempt <= 40; attempt++) { // ~10 minutos se interval=15s
    try {
      const t = await getTemplateStatus(TEMPLATE_NAME);
      const status = t?.status || 'UNKNOWN';
      console.log(JSON.stringify({ attempt, status }, null, 2));
      if (status === 'APPROVED') {
        const result = await sendByName(patientName, phone);
        console.log(JSON.stringify({ success: true, sent: true, result }, null, 2));
        process.exit(0);
      }
    } catch (e) {
      console.error(JSON.stringify({ attempt, error: e.response?.data || e.message }, null, 2));
    }
    await new Promise(r => setTimeout(r, 15000));
  }
  console.log(JSON.stringify({ success: false, sent: false, reason: 'timeout_waiting_approval' }, null, 2));
  process.exit(2);
}

main();
