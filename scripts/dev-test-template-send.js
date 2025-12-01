#!/usr/bin/env node
const path = require('path');
const modulePath = path.join(__dirname, '../src/services/whatsapp-business');
process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
process.env.WHATSAPP_API_VERSION = 'v19.0';
process.env.DEFAULT_CONFIRM_TEMPLATE_NAME = 'confirmacao_personalizada';
process.env.DEFAULT_CONFIRM_TEMPLATE_LOCALE = 'pt_BR';

const axios = require('axios');
axios.post = async (url, payload) => {
  console.log('Captured request payload:', JSON.stringify(payload, null, 2));
  return { data: { messages: [{ id: 'wamid.TEST123' }] } };
};

const waba = require(modulePath);

(async () => {
  const result = await waba.sendTemplateMessage('+55 (34) 99999-0000', null, null, [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: 'Paciente Teste' },
        { type: 'text', text: '01/12/2025' },
        { type: 'text', text: '10:00' },
        { type: 'text', text: 'Exame' }
      ]
    }
  ], { scheduleId: 321 });

  console.log('sendTemplateMessage returned:', result);
})();
