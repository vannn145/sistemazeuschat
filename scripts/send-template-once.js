#!/usr/bin/env node
require('dotenv').config({ override: true });
const db = require('../src/services/database');
const whatsappBusiness = require('../src/services/whatsapp-business');
const { formatClinicDate, formatClinicTime } = require('../src/utils/datetime');

(async () => {
  const appointmentIdRaw = process.argv[2];
  const appointmentId = appointmentIdRaw ? Number(appointmentIdRaw) : NaN;
  if (!Number.isFinite(appointmentId) || appointmentId <= 0) {
    console.error('Uso: node scripts/send-template-once.js <appointmentId>');
    process.exit(1);
  }
  try {
    await db.testConnection();
    const appointment = await db.getAppointmentById(appointmentId);
    if (!appointment) {
      console.error(`Agendamento ${appointmentId} não encontrado.`);
      process.exit(1);
    }
    const phoneDigits = db.phoneDigitsForWhatsapp(appointment.patient_contacts);
    if (!phoneDigits) {
      console.error('Telefone inválido para o agendamento.');
      process.exit(1);
    }
    const phone = `+${phoneDigits}`;
    const templateName = process.env.DEFAULT_CONFIRM_TEMPLATE_NAME || 'confirmacao_personalizada';
    const lang = process.env.DEFAULT_CONFIRM_TEMPLATE_LOCALE || 'pt_BR';
    let components = [];
    if (templateName !== 'confirmao_de_agendamento') {
      components = [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: appointment.patient_name || 'Paciente' },
            { type: 'text', text: formatClinicDate(appointment.tratamento_date) },
            { type: 'text', text: formatClinicTime(appointment.tratamento_date) },
            { type: 'text', text: appointment.main_procedure_term || 'Procedimento' }
          ]
        }
      ];
    }
    const result = await whatsappBusiness.sendTemplateMessage(phone, templateName, lang, components, { scheduleId: appointment.id });
    console.log('Envio concluído com sucesso:');
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Falha no envio:', err.response?.data || err.message || err);
    process.exit(1);
  }
})();
