#!/usr/bin/env node
require('dotenv').config({ override: true });
const { Pool } = require('pg');

const RAW_ARGS = process.argv.slice(2);

function parseArgs() {
  let date = null;
  let limit = 0;
  let source = null;

  for (const arg of RAW_ARGS) {
    if (arg.startsWith('--source=')) {
      source = arg.split('=')[1] || null;
      continue;
    }
    if (arg === '--webhook') {
      source = 'webhook';
      continue;
    }
    if (arg === '--manual') {
      source = 'manual';
      continue;
    }
    if (!date && !arg.startsWith('--')) {
      date = arg;
      continue;
    }
    if (!limit && !arg.startsWith('--')) {
      limit = parseInt(arg, 10) || 0;
    }
  }

  return { date, limit, source: source ? source.toLowerCase() : null };
}

(async () => {
  try {
    const { date, limit, source } = parseArgs();
    if (!date) {
      console.error('Uso: node scripts/list-confirmed-by-date.js YYYY-MM-DD [limit] [--webhook|--manual|--source=valor]');
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

    const filters = ['sv.confirmed = true', 'to_timestamp(sv."when")::date = $1'];
    const params = [date];

    if (source === 'webhook') {
      filters.push(`wlogs.appointment_id IS NOT NULL`);
    } else if (source === 'manual') {
      filters.push(`wlogs.appointment_id IS NULL`);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const query = `
      WITH latest_logs AS (
        SELECT DISTINCT ON (appointment_id::bigint)
          appointment_id::bigint AS appointment_id,
          status,
          type,
          template_name,
          error_details,
          created_at,
          updated_at
        FROM ${schema}.message_logs
        WHERE appointment_id IS NOT NULL
        ORDER BY appointment_id::bigint, COALESCE(updated_at, created_at) DESC NULLS LAST
      ),
      webhook_logs AS (
        SELECT DISTINCT ON (appointment_id::bigint)
          appointment_id::bigint AS appointment_id,
          status,
          type,
          template_name,
          error_details,
          created_at,
          updated_at
        FROM ${schema}.message_logs
        WHERE appointment_id IS NOT NULL
          AND type = 'confirmation'
          AND LOWER(template_name) = 'paciente'
        ORDER BY appointment_id::bigint, COALESCE(updated_at, created_at) DESC NULLS LAST
      )
      SELECT
        sv.schedule_id AS id,
        sv.patient_name,
        sv.patient_contacts,
        sv.main_procedure_term,
        to_timestamp(sv."when") AS tratamento_date,
        sv.confirmed,
        logs.status AS log_status,
        logs.type AS log_type,
        logs.template_name AS log_template,
        logs.created_at AS log_created_at,
        logs.updated_at AS log_updated_at,
        wlogs.created_at AS webhook_created_at,
        wlogs.updated_at AS webhook_updated_at
      FROM ${schema}.schedule_v sv
      LEFT JOIN latest_logs logs ON logs.appointment_id = sv.schedule_id
      LEFT JOIN webhook_logs wlogs ON wlogs.appointment_id = sv.schedule_id
      ${whereClause}
      ORDER BY sv."when" ASC
    `;

    const { rows } = await pool.query(query, params);
    await pool.end();

    const list = Array.isArray(rows) ? rows : [];
    const trimmed = limit > 0 ? list.slice(0, limit) : list;

    const results = trimmed.map(row => ({
      id: Number(row.id),
      patientName: row.patient_name,
      phone: row.patient_contacts,
      procedure: row.main_procedure_term,
      tratamentoDate: row.tratamento_date,
      confirmed: row.confirmed,
      latestLog: {
        status: row.log_status,
        type: row.log_type,
        templateName: row.log_template,
        createdAt: row.log_created_at,
        updatedAt: row.log_updated_at
      },
      webhookLog: row.webhook_created_at || row.webhook_updated_at ? {
        createdAt: row.webhook_created_at,
        updatedAt: row.webhook_updated_at
      } : null
    }));

    console.log(JSON.stringify({ date, source: source || null, total: list.length, sampleCount: results.length, results }, null, 2));
    process.exit(0);
  } catch (error) {
    console.error('Erro ao listar confirmados:', error.message);
    process.exit(1);
  }
})();
