#!/usr/bin/env node
require('dotenv').config({ override: true });
const { Pool } = require('pg');

async function main() {
    const targetDate = process.argv[2] || (() => {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        return tomorrow.toISOString().slice(0, 10);
    })();
    const nameFilter = process.argv[3] ? process.argv.slice(3).join(' ') : null;

    const pool = new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT || 5432,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: process.env.DB_SSL === 'true'
    });

    const schema = process.env.DB_SCHEMA || 'public';

    try {
        const params = [targetDate];
        let filterClause = '';
        if (nameFilter) {
            params.push(`%${nameFilter}%`);
            filterClause = 'AND UPPER(sv.patient_name) LIKE UPPER($2)';
        }

        const query = `
            SELECT
                sv.schedule_id AS appointment_id,
                sv.patient_name,
                sv.patient_contacts,
                sv.main_procedure_term,
                sv.confirmed,
                to_char(to_timestamp(sv."when") AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24:MI:SS') AS appointment_at,
                to_char(to_timestamp(wm.whatsapp_message_time) AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24:MI:SS') AS webhook_at,
                wm.whatsapp_message_body,
                wm.whatsapp_message_description,
                wm.whatsapp_message_phone
            FROM ${schema}.whatsapp_message wm
            JOIN ${schema}.whatsapp_message_has_treatment wmht ON wmht.whatsapp_message_id = wm.whatsapp_message_id
            JOIN ${schema}.schedule_v sv ON sv.treatment_id = wmht.treatment_id
            WHERE wm.whatsapp_status_id = 3
              AND to_timestamp(sv."when")::date = $1::date
              ${filterClause}
            ORDER BY wm.whatsapp_message_time DESC
        `;

        const { rows } = await pool.query(query, params);

        console.log(JSON.stringify({
            date: targetDate,
            nameFilter: nameFilter || null,
            total: rows.length,
            items: rows
        }, null, 2));
    } catch (error) {
        console.error(JSON.stringify({ error: error.message }, null, 2));
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

main();
