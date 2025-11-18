require('dotenv').config({ override: true });
const db = require('../src/services/database');

async function run(id) {
    if (!id) {
        console.error('Uso: node scripts/manual-confirm.js <schedule_id>');
        process.exit(1);
    }

    try {
        await db.confirmAppointment(Number(id));
        console.log(`Agendamento ${id} confirmado.`);
    } catch (error) {
        console.error('Erro ao confirmar:', error.message);
    }
}

run(process.argv[2]).then(() => process.exit(0));
