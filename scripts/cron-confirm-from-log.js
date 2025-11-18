// scripts/cron-confirm-from-log.js
const fs = require('fs');
const axios = require('axios');
const path = require('path');

// Caminho do log (ajuste para o nome do seu log)
const logPath = 'logs/cron-confirm-log.txt'; // Arquivo de log para testes locais

// Endpoint de confirmação (ajuste para o seu backend)
const API_URL = 'http://localhost:3000/api/confirm/'; // exemplo: /api/confirm/:phone

// Função para extrair telefones das confirmações
function getPhonesFromLog(logContent) {
    const regex = /Confirmação recebida de (\d+)/g;
    const phones = [];
    let match;
    while ((match = regex.exec(logContent)) !== null) {
        phones.push(match[1]);
    }
    return [...new Set(phones)]; // remove duplicados
}

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

function main() {
    if (!fs.existsSync(logPath)) {
        console.error('Arquivo de log não encontrado:', logPath);
        return;
    }
    const logContent = fs.readFileSync(logPath, 'utf8');
    const phones = getPhonesFromLog(logContent);
    if (phones.length === 0) {
        console.log('Nenhuma confirmação encontrada no log.');
        return;
    }
    confirmPhones(phones);
}

main();
