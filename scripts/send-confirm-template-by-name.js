#!/usr/bin/env node
// Envia o template confirmacao_personalizada preenchendo variáveis pelo nome do paciente
require('dotenv').config({ override: true });
const db = require('../src/services/database');
const waba = require('../src/services/whatsapp-business');
const { formatClinicDate, formatClinicTime } = require('../src/utils/datetime');

(async () => {
  const patientName = process.argv.slice(2, -1).join(' ') || 'MARIANA MORLIM DE CARVALHO';
  const phone = (process.argv.slice(-1)[0] || '+5511998420069');
  try {
    const appt = await db.getAppointmentByPatientName(patientName);
    if (!appt) {
      console.error(JSON.stringify({ success: false, message: 'Nenhum agendamento encontrado' }));
      process.exit(1);
    }
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
    const result = await waba.sendTemplateMessage(phone, 'confirmacao_personalizada', 'pt_BR', components, { scheduleId: appt.id });
    console.log(JSON.stringify({ success: true, patientName, phone, appointment: appt, components, result }, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ success: false, error: e.response?.data || e.message }, null, 2));
    process.exit(1);
  }
})();
