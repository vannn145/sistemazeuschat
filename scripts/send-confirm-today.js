// scripts/send-confirm-today.js
const axios = require('axios');

// Endpoint correto do backend
const API_URL = 'http://localhost:3000/api/messages/confirm/';

// Exemplo: lista de telefones reais disparados hoje (substitua por busca dinâmica do banco)
const phones = [
  '5511999999999',
  '5511888888888'
];

async function confirmPhones(phones) {
  for (const phone of phones) {
    try {
      const res = await axios.post(`${API_URL}${phone}`);
      console.log(`✅ Confirmação enviada para ${phone}:`, res.data);
    } catch (err) {
      console.error(`❌ Erro ao confirmar ${phone}:`, err.response?.data || err.message);
    }
  }
}

confirmPhones(phones);
