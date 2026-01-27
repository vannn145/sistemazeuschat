#!/usr/bin/env node
const axios = require('axios');
require('dotenv').config({ override: true });

async function main() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v21.0';
  const to = (process.argv[2] || '+5511998420069').replace(/\D/g, '');
  const templateName = process.argv[3] || process.env.DEFAULT_CONFIRM_TEMPLATE_NAME || 'confirmacao_personalizada';
  const languageCode = process.argv[4] || process.env.DEFAULT_CONFIRM_TEMPLATE_LOCALE || 'pt_BR';
  if (!token || !phoneId) {
    console.error('Defina WHATSAPP_ACCESS_TOKEN e WHATSAPP_PHONE_NUMBER_ID no .env');
    process.exit(1);
  }
  const url = `https://graph.facebook.com/${apiVersion}/${phoneId}/messages`;
  const bodyParams = (process.argv[5] || '').split('|');
  const components = [
    {
      type: 'body',
      parameters: bodyParams
        .filter(Boolean)
        .map(text => ({ type: 'text', text }))
    }
  ];
  if (components[0].parameters.length === 0) {
    components.length = 0;
  }
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components: components.length ? components : undefined
    }
  };
  try {
    const { data } = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(JSON.stringify(e.response?.data || e.message, null, 2));
    process.exit(1);
  }
}

main();
