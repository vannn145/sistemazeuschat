require('dotenv').config({ override: true });
const db = require('../src/services/database');

async function run(phoneOrName) {
    if (!phoneOrName) {
        console.error('Uso: node scripts/debug-appointment-by-phone.js <telefone|nome>');
        process.exit(1);
    }

    await db.testConnection();

    const phoneDigits = db.sanitizePhone(phoneOrName);
    let byPhone = null;
    if (phoneDigits) {
        byPhone = await db.getLatestPendingAppointmentByPhone(phoneDigits);
    }

    let byName = null;
    if (!byPhone) {
        byName = await db.getAppointmentByPatientName(phoneOrName);
    }

    console.log(JSON.stringify({
        input: phoneOrName,
        phoneDigits,
        byPhone,
        byName
    }, null, 2));
}

run(process.argv[2]).catch(err => {
    console.error('Erro:', err.message);
    process.exitCode = 1;
});
