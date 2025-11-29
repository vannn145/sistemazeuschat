#!/usr/bin/env node
require('dotenv').config({ override: true });
const db = require('../src/services/database');
const whatsappBusiness = require('../src/services/whatsapp-business');
const { formatClinicDate, formatClinicTime } = require('../src/utils/datetime');

function extractPhone(appointment) {
    const raw = appointment?.preferred_phone || appointment?.patient_contacts || appointment?.patient_phones;
    if (!raw) {
        return null;
    }
    const digits = String(raw).replace(/\D/g, '');
    if (!digits) {
        return null;
    }
    const withCountry = digits.startsWith('55') ? digits : `55${digits}`;
    return `+${withCountry}`;
}

(async () => {
    try {
        const id = Number(process.argv[2]);
        if (!id) {
            console.error('Uso: node scripts/send-template-by-id.js <schedule_id>');
            process.exit(1);
        }
        await db.ensureInitialized();
        const appointment = await db.getAppointmentById(id);
        if (!appointment) {
            console.error('Agendamento não encontrado');
            process.exit(1);
        }
        const phone = extractPhone(appointment);
        if (!phone) {
            console.error('Paciente sem telefone válido');
            process.exit(1);
        }

        const templateName = process.env.DEFAULT_CONFIRM_TEMPLATE_NAME || 'confirmacao_personalizada';
        const lang = process.env.DEFAULT_CONFIRM_TEMPLATE_LOCALE || 'pt_BR';
        const dateBR = formatClinicDate(appointment.tratamento_date);
        const timeBR = formatClinicTime(appointment.tratamento_date);
        let components = [];
        if (templateName !== 'confirmao_de_agendamento') {
            components = [
                {
                    type: 'body',
                    parameters: [
                        { type: 'text', text: appointment.patient_name },
                        { type: 'text', text: dateBR },
                        { type: 'text', text: timeBR },
                        { type: 'text', text: appointment.main_procedure_term || 'Procedimento' }
                    ]
                }
            ];
        }

        const result = await whatsappBusiness.sendTemplateMessage(phone, templateName, lang, components, { scheduleId: appointment.id });
        console.log('Envio Business API:', JSON.stringify(result, null, 2));

        if (result?.messageId) {
            await db.logOutboundMessage({
                appointmentId: appointment.id,
                phone,
                messageId: result.messageId,
                type: 'template',
                templateName,
                status: 'sent'
            });
            console.log('Log registrado em message_logs');
        }
    } catch (error) {
        console.error('Erro ao enviar template:', JSON.stringify(error.response?.data || { message: error.message }, null, 2));
        process.exit(1);
    }
})();
