require('dotenv').config({ override: true });
const { Pool } = require('pg');

async function main(targetDate) {
  if (!targetDate) {
    console.error('Uso: node scripts/list-status-by-date.js <YYYY-MM-DD>');
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

  const start = Math.floor(new Date(`${targetDate}T00:00:00-03:00`).getTime() / 1000);
  const end = Math.floor(new Date(`${targetDate}T00:00:00-03:00`).getTime() / 1000 + 86400);

  const query = `
    SELECT
      wm.whatsapp_status_id,
      wm.whatsapp_message_time,
      wm.whatsapp_message_body,
      wm.whatsapp_message_description,
      sv.schedule_id AS appointment_id,
      sv.patient_name,
      sv.main_procedure_term,
      sv.patient_contacts
    FROM ${schema}.whatsapp_message wm
    JOIN ${schema}.whatsapp_message_has_treatment wmht ON wmht.whatsapp_message_id = wm.whatsapp_message_id
    JOIN ${schema}.schedule_v sv ON sv.treatment_id = wmht.treatment_id
    WHERE wm.whatsapp_message_time >= $1
      AND wm.whatsapp_message_time < $2
      AND wm.whatsapp_status_id IN (2, 3)
    ORDER BY wm.whatsapp_message_time ASC
  `;

  try {
    const { rows } = await pool.query(query, [start, end]);
    const mapped = rows.map(row => ({
      type: row.whatsapp_status_id === 3 ? 'confirmed' : 'cancelled',
      appointmentId: row.appointment_id,
      patientName: row.patient_name,
      procedure: row.main_procedure_term,
      phone: row.patient_contacts,
      message: row.whatsapp_message_body,
      description: row.whatsapp_message_description,
      occurredAt: new Date(row.whatsapp_message_time * 1000).toISOString()
    }));

    console.log(JSON.stringify({ date: targetDate, total: mapped.length, statuses: mapped }, null, 2));
  } catch (err) {
    console.error('Erro ao consultar:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main(process.argv[2]);
