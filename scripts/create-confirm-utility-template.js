#!/usr/bin/env node
// Cria um novo template de confirmacao classificado como Utility
const axios = require('axios');
require('dotenv').config({ override: true });

(async () => {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v21.0';

  if (!token || !wabaId) {
    console.error('Defina WHATSAPP_ACCESS_TOKEN e WHATSAPP_BUSINESS_ACCOUNT_ID no .env');
    process.exit(1);
  }

  const templateName = process.argv[2] || 'confirmacao_utilidade_cdcenter';

  const url = `https://graph.facebook.com/${apiVersion}/${wabaId}/message_templates`;
  const payload = {
    name: templateName,
    category: 'UTILITY',
    language: 'pt_BR',
    components: [
      {
        type: 'HEADER',
        format: 'TEXT',
        text: 'Confirmacao de agendamento'
      },
      {
        type: 'BODY',
        text: 'Ola, {{1}}. Seu atendimento esta agendado no CD Center Uberaba para {{2}} as {{3}}. Procedimento: {{4}}. Confirme ou cancele pelo botao.',
        example: {
          body_text: [[
            'MARIANA MORLIM DE CARVALHO',
            '05/11/2025',
            '10:00',
            'ECODOPPLERCARDIOGRAMA TRANSTORACICO'
          ]]
        }
      },
      {
        type: 'FOOTER',
        text: 'Confirme ou cancele no botao abaixo'
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Confirmar' },
          { type: 'QUICK_REPLY', text: 'Cancelar' }
        ]
      }
    ]
  };

  try {
    const { data } = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(JSON.stringify(e.response?.data || e.message, null, 2));
    process.exit(1);
  }
})();
