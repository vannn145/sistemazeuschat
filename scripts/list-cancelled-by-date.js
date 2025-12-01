#!/usr/bin/env node
require('dotenv').config({ override: true });
const db = require('../src/services/database');

(async () => {
  try {
    const date = process.argv[2];
    if (!date) {
      console.error('Uso: node scripts/list-cancelled-by-date.js YYYY-MM-DD [limit]');
      process.exit(1);
    }

    const limit = parseInt(process.argv[3] || '0', 10) || 0;
    await db.testConnection();
    const cancellations = await db.getCancelledAppointments(date);

    const results = Array.isArray(cancellations) ? cancellations : [];
    const trimmed = limit > 0 ? results.slice(0, limit) : results;

    const formatted = trimmed.map(item => ({
      id: item.id,
      patientName: item.patient_name || item.patientName,
      phone: item.patient_contacts || item.phone,
      procedure: item.main_procedure_term || item.procedure,
      tratamentoDate: item.tratamento_date,
      confirmed: item.confirmed,
      active: item.active,
      cancelledAt: item.cancelled_at,
      latestLog: item.latest_log
    }));

    console.log(JSON.stringify({ date, total: results.length, sampleCount: formatted.length, results: formatted }, null, 2));
    process.exit(0);
  } catch (error) {
    console.error('Erro ao listar cancelados:', error.message);
    process.exit(1);
  }
})();
