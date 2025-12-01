#!/usr/bin/env node
require('dotenv').config({ override: true });
const { Pool } = require('pg');

function toTimeZone(date, tz) {
    if (!(date instanceof Date)) {
        return null;
    }
    return new Date(date.toLocaleString('en-US', { timeZone: tz }));
}

async function run() {
    const tz = process.env.CLINIC_TIMEZONE || 'America/Sao_Paulo';
    const start = toTimeZone(new Date(), tz);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

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
    const query = `
        SELECT appointment_id, phone, message_id, template_name, status, error_details, created_at
        FROM ${schema}.message_logs
        WHERE created_at >= $1 AND created_at < $2 AND type = 'template'
        ORDER BY created_at DESC
    `;

    try {
        const { rows } = await pool.query(query, [start, end]);
        const failed = rows.filter(r => (r.status || '').toLowerCase() === 'failed');

        const errorCodes = {};
        const samples = failed.slice(0, 20).map(row => {
            let info = null;
            if (row.error_details) {
                try {
                    const parsed = JSON.parse(row.error_details);
                    info = Array.isArray(parsed) ? parsed[0] : parsed;
                    if (info && info.code) {
                        errorCodes[info.code] = (errorCodes[info.code] || 0) + 1;
                    }
                } catch (e) {
                    errorCodes.parse_error = (errorCodes.parse_error || 0) + 1;
                }
            }
            return {
                appointmentId: row.appointment_id,
                phone: row.phone,
                messageId: row.message_id,
                code: info?.code || null,
                title: info?.title || null,
                detail: info?.error_data?.details || info?.message || null,
                createdAt: row.created_at,
            };
        });

        // contabilizar códigos para o restante da lista (além das amostras)
        failed.slice(20).forEach(row => {
            if (!row.error_details) {
                return;
            }
            try {
                const parsed = JSON.parse(row.error_details);
                const info = Array.isArray(parsed) ? parsed[0] : parsed;
                if (info && info.code) {
                    errorCodes[info.code] = (errorCodes[info.code] || 0) + 1;
                }
            } catch (e) {
                errorCodes.parse_error = (errorCodes.parse_error || 0) + 1;
            }
        });

        const result = {
            date: start.toISOString().slice(0, 10),
            totalTemplateLogs: rows.length,
            failedCount: failed.length,
            deliveredOrSent: rows.length - failed.length,
            errorCodes,
            sample: samples,
        };

        console.log(JSON.stringify(result, null, 2));
    } catch (err) {
        console.error('Erro na consulta:', err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

run();
