#!/usr/bin/env node
require('dotenv').config({ override: true });
const db = require('../src/services/database');

(async () => {
  try {
    const idArg = process.argv[2];
    const scheduleId = Number(idArg);
    if (!scheduleId) {
      console.error('Uso: node scripts/unconfirm-appointment.js <schedule_id>');
      process.exit(1);
    }

    await db.ensureInitialized();
    const schema = db.schema || 'public';
    const updatedAt = db.getEpochSeconds();

    const unsetSql = `UPDATE ${schema}.schedule SET confirmed = false, updated_at = $2 WHERE schedule_id = $1`;
    const resultMain = await db.pool.query(unsetSql, [scheduleId, updatedAt]);

    let resultMirror = null;
    try {
      const unsetMirrorSql = `UPDATE ${schema}.schedule_mv SET confirmed = false, updated_at = $2 WHERE schedule_id = $1`;
      resultMirror = await db.pool.query(unsetMirrorSql, [scheduleId, updatedAt]);
    } catch (mirrorError) {
      console.warn('Aviso: não foi possível atualizar schedule_mv:', mirrorError.message);
    }

    console.log(JSON.stringify({
      scheduleId,
      updatedAt,
      rowsAffected: {
        schedule: resultMain.rowCount,
        schedule_mv: resultMirror ? resultMirror.rowCount : 0
      }
    }, null, 2));
    process.exit(0);
  } catch (error) {
    console.error('Erro ao desfazer confirmação:', error.message);
    process.exit(1);
  }
})();
