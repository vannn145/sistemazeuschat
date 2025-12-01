#!/usr/bin/env node
require('dotenv').config({ override: true });
const { Pool } = require('pg');

async function main() {
  const scheduleId = process.argv[2];
  if (!scheduleId) {
    console.error('Usage: node scripts/show-message-logs-by-id.js <scheduleId>');
    process.exit(1);
  }

  const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true',
    connectionTimeoutMillis: 10000,
  });

  const schema = process.env.DB_SCHEMA || 'public';

  try {
    const { rows } = await pool.query(
      `SELECT appointment_id,
              phone,
              message_id,
              type,
              template_name,
              status,
              error_details,
              created_at,
              updated_at
         FROM ${schema}.message_logs
        WHERE appointment_id = $1
        ORDER BY COALESCE(updated_at, created_at) DESC NULLS LAST
        LIMIT 20`,
      [String(scheduleId)]
    );

    console.log(JSON.stringify({ scheduleId, logs: rows }, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
