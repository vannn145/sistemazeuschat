require('dotenv').config({ override: true });
const { Pool } = require('pg');

async function run(id) {
    if (!id) {
        console.error('Uso: node scripts/inspect-schedule.js <schedule_id>');
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

    try {
        const schedule = await pool.query(
            `SELECT schedule_id, confirmed, updated_at FROM ${schema}.schedule WHERE schedule_id = $1`,
            [Number(id)]
        );
        const scheduleMv = await pool.query(
            `SELECT schedule_id, confirmed FROM ${schema}.schedule_mv WHERE schedule_id = $1`,
            [Number(id)]
        );

        console.log(JSON.stringify({
            schedule: schedule.rows[0] || null,
            schedule_mv: scheduleMv.rows[0] || null
        }, null, 2));
    } finally {
        await pool.end();
    }
}

run(process.argv[2]).catch(err => {
    console.error('Erro:', err.message);
    process.exitCode = 1;
});
