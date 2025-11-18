require('dotenv').config({ override: true });
const { Pool } = require('pg');

async function main(dateArg) {
    const pool = new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT || 5432,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: process.env.DB_SSL === 'true'
    });

    const schema = process.env.DB_SCHEMA || 'public';

    const targetDate = dateArg
        ? new Date(`${dateArg}T00:00:00`)
        : new Date();

    if (Number.isNaN(targetDate.getTime())) {
        throw new Error(`Data inválida: ${dateArg}`);
    }

    const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    const startEpoch = Math.floor(startOfDay.getTime() / 1000);
    const endEpoch = Math.floor(endOfDay.getTime() / 1000);

    const query = `
        SELECT
            wm.whatsapp_message_id,
            wm.whatsapp_message_body,
            wm.whatsapp_message_phone,
            wm.whatsapp_message_time,
            wm.whatsapp_message_description,
            sv.schedule_id AS appointment_id,
            sv.patient_name,
            sv.main_procedure_term
        FROM ${schema}.whatsapp_message wm
        JOIN ${schema}.whatsapp_message_has_treatment wmht ON wmht.whatsapp_message_id = wm.whatsapp_message_id
        JOIN ${schema}.schedule_v sv ON sv.treatment_id = wmht.treatment_id
        WHERE wm.whatsapp_status_id = 3
          AND wm.whatsapp_message_time >= $1
          AND wm.whatsapp_message_time < $2
        ORDER BY wm.whatsapp_message_time DESC
    `;

    try {
        const { rows } = await pool.query(query, [startEpoch, endEpoch]);

        const formatted = rows.map(row => ({
            appointmentId: row.appointment_id,
            patientName: row.patient_name,
            procedure: row.main_procedure_term,
            phone: row.whatsapp_message_phone,
            confirmedAt: new Date(row.whatsapp_message_time * 1000).toISOString(),
            description: row.whatsapp_message_description,
            message: row.whatsapp_message_body
        }));

        console.log(JSON.stringify({
            date: startOfDay.toISOString().slice(0, 10),
            total: formatted.length,
            confirmations: formatted
        }, null, 2));
    } finally {
        await pool.end();
    }
}

main(process.argv[2]).catch(err => {
    console.error('Erro ao listar confirmações:', err.message);
    process.exitCode = 1;
});
