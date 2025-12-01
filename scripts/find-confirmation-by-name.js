require('dotenv').config({ override: true });
const { Pool } = require('pg');

async function main(searchTerm) {
  if (!searchTerm) {
    console.error('Uso: node scripts/find-confirmation-by-name.js "<nome>"');
    process.exit(1);
  }

  const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true'
  });

  const schema = process.env.DB_SCHEMA || 'public';

  const query = `
    SELECT
      sv.schedule_id AS appointment_id,
      sv.patient_name,
      sv.main_procedure_term,
      sv.confirmed,
      to_timestamp(sv."when") AS treatment_at,
      wm.whatsapp_message_body,
      wm.whatsapp_message_time,
      wm.whatsapp_message_description
    FROM ${schema}.schedule_v sv
    LEFT JOIN ${schema}.whatsapp_message_has_treatment wmht
      ON wmht.treatment_id = sv.treatment_id
    LEFT JOIN ${schema}.whatsapp_message wm
      ON wm.whatsapp_message_id = wmht.whatsapp_message_id
    WHERE sv.patient_name ILIKE $1
    ORDER BY to_timestamp(sv."when") DESC, wm.whatsapp_message_time DESC NULLS LAST
    LIMIT 40
  `;

  try {
    const { rows } = await pool.query(query, [`%${searchTerm}%`]);
    const normalized = rows.map(row => ({
      appointmentId: row.appointment_id,
      patientName: row.patient_name,
      procedure: row.main_procedure_term,
      confirmed: row.confirmed,
      treatmentAt: row.treatment_at,
      whatsappStatus: row.whatsapp_message_description,
      whatsappMessage: row.whatsapp_message_body,
      whatsappTime: row.whatsapp_message_time ? new Date(row.whatsapp_message_time * 1000).toISOString() : null
    }));

    console.log(JSON.stringify({ search: searchTerm, results: normalized }, null, 2));
  } catch (err) {
    console.error('Erro ao consultar:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2).join(' '));
