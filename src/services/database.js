const { Pool } = require('pg');

class DatabaseService {
    constructor() {
        this.pool = new Pool({
            host: process.env.DB_HOST,
            port: process.env.DB_PORT || 5432,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            ssl: process.env.DB_SSL === 'true',
            connectionTimeoutMillis: 10000,
            idleTimeoutMillis: 30000,
            max: Number(process.env.DB_MAX_POOL || 10)
        });

        console.log('[DatabaseService] Pool config:', {
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            user: process.env.DB_USER,
            database: process.env.DB_NAME,
            ssl: process.env.DB_SSL
        });

        this.schema = process.env.DB_SCHEMA || 'public';
        this.demoMode = false;
        this.isConnected = false;
        this.initPromise = null;
    }

    async ensureInitialized() {
        if (this.initPromise) {
            await this.initPromise;
            return;
        }

        if (this.isConnected) {
            return;
        }

        this.initPromise = (async () => {
            try {
                await this.pool.query('SELECT 1');
                this.isConnected = true;
            } catch (err) {
                this.isConnected = false;
                console.error('[DatabaseService] Erro ao conectar pool:', err);
                throw err;
            } finally {
                this.initPromise = null;
            }
        })();

        await this.initPromise;
    }

    sanitizePhone(phone) {
        if (!phone) {
            return null;
        }

        const digits = String(phone).match(/\d+/g);
        return digits ? digits.join('') : null;
    }

    formatE164(phone) {
        const digits = this.sanitizePhone(phone);
        if (!digits) {
            return null;
        }

        let normalized = digits;
        if (!normalized.startsWith('55') && normalized.length >= 10) {
            normalized = `55${normalized}`;
        }

        if (!normalized.startsWith('55')) {
            return `+${normalized}`;
        }

        return `+${normalized}`;
    }

    phoneDigitsForWhatsapp(phone) {
        const digits = this.sanitizePhone(phone);
        if (!digits) {
            return null;
        }

        if (digits.startsWith('55')) {
            return digits;
        }

        return digits.length >= 10 ? `55${digits}` : digits;
    }

    getEpochSeconds() {
        return Math.floor(Date.now() / 1000);
    }

    mapAppointmentRow(row) {
        if (!row) {
            return null;
        }

        const mapped = { ...row };
        mapped.id = Number(row.id ?? row.schedule_id);

        if (!mapped.tratamento_date && typeof row.when === 'number') {
            mapped.tratamento_date = new Date(row.when * 1000);
        }

        return mapped;
    }

    async updateLatestLogStatus(appointmentId, status, executor = null) {
        if (!appointmentId || !status) {
            return;
        }

        const runner = executor || this.pool;
        const query = `
            WITH last_log AS (
                SELECT id
                FROM ${this.schema}.message_logs
                WHERE appointment_id = $1
                ORDER BY updated_at DESC NULLS LAST, created_at DESC
                LIMIT 1
            )
            UPDATE ${this.schema}.message_logs ml
            SET status = $2,
                updated_at = NOW()
            WHERE ml.id IN (SELECT id FROM last_log)
        `;

        await runner.query(query, [String(appointmentId), status]);
    }

    async initMessageLogs() {
        await this.ensureInitialized();

        const tableQuery = `
            CREATE TABLE IF NOT EXISTS ${this.schema}.message_logs (
                id SERIAL PRIMARY KEY,
                appointment_id TEXT,
                phone TEXT,
                message_id TEXT UNIQUE,
                type TEXT,
                template_name TEXT,
                status TEXT,
                error_details TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `;

        await this.pool.query(tableQuery);
        await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_message_logs_appointment ON ${this.schema}.message_logs (appointment_id)`);
        await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_message_logs_message_id_unique ON ${this.schema}.message_logs (message_id)`);
        await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_message_logs_created_at ON ${this.schema}.message_logs (created_at DESC)`);
    }

    async logOutboundMessage({ appointmentId, phone, messageId, type, templateName, status, errorDetails = null }) {
        if (!messageId) {
            return;
        }

        await this.ensureInitialized();
        await this.initMessageLogs();

        const normalizedPhone = this.formatE164(phone) || phone || null;
        const now = new Date();

        const query = `
            INSERT INTO ${this.schema}.message_logs
                (appointment_id, phone, message_id, type, template_name, status, error_details, created_at, updated_at)
            VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8, $8)
            ON CONFLICT (message_id) DO UPDATE
                SET appointment_id = EXCLUDED.appointment_id,
                    phone = EXCLUDED.phone,
                    type = EXCLUDED.type,
                    template_name = EXCLUDED.template_name,
                    status = EXCLUDED.status,
                    error_details = EXCLUDED.error_details,
                    updated_at = EXCLUDED.updated_at
        `;

        const params = [
            appointmentId ? String(appointmentId) : null,
            normalizedPhone,
            messageId,
            type || null,
            templateName || null,
            status || null,
            errorDetails || null,
            now
        ];

        await this.pool.query(query, params);
    }

    async hasTemplateLogsBetween(startDate, endDate, templateName = null) {
        if (!startDate || !endDate) {
            return false;
        }

        await this.ensureInitialized();
        await this.initMessageLogs();

        const conditions = [`type = 'template'`, 'created_at >= $1', 'created_at < $2'];
        const params = [startDate, endDate];

        if (templateName) {
            conditions.push('template_name = $3');
            params.push(templateName);
        }

        const query = `
            SELECT EXISTS (
                SELECT 1
                FROM ${this.schema}.message_logs
                WHERE ${conditions.join(' AND ')}
                LIMIT 1
            ) AS present
        `;

        const { rows } = await this.pool.query(query, params);
        return Boolean(rows[0]?.present);
    }

    async updateMessageStatus(messageId, status, errorDetails = null) {
        if (!messageId) {
            return;
        }

        await this.ensureInitialized();
        await this.initMessageLogs();

        const now = new Date();

        const updateQuery = `
            UPDATE ${this.schema}.message_logs
            SET status = $2,
                error_details = $3,
                updated_at = $4
            WHERE message_id = $1
        `;

        const result = await this.pool.query(updateQuery, [messageId, status || null, errorDetails || null, now]);

        if (result.rowCount === 0) {
            const insertQuery = `
                INSERT INTO ${this.schema}.message_logs
                    (appointment_id, phone, message_id, type, template_name, status, error_details, created_at, updated_at)
                VALUES
                    (NULL, NULL, $1, 'status', NULL, $2, $3, $4, $4)
            `;

            await this.pool.query(insertQuery, [messageId, status || null, errorDetails || null, now]);
        }
    }

    async getLatestStatusesForAppointments(appointmentIds = []) {
        await this.ensureInitialized();

        if (!Array.isArray(appointmentIds) || appointmentIds.length === 0) {
            return {};
        }

        const ids = appointmentIds.map(id => String(id));

        const query = `
            SELECT DISTINCT ON (appointment_id)
                appointment_id,
                status,
                message_id,
                type,
                template_name,
                error_details,
                updated_at,
                created_at
            FROM ${this.schema}.message_logs
            WHERE appointment_id = ANY($1)
            ORDER BY appointment_id, COALESCE(updated_at, created_at) DESC NULLS LAST
        `;

        const { rows } = await this.pool.query(query, [ids]);
        const map = {};

        for (const row of rows) {
            const key = Number(row.appointment_id);
            map[key] = {
                status: row.status,
                message_id: row.message_id,
                type: row.type || null,
                template_name: row.template_name || null,
                error_details: row.error_details || null,
                updated_at: row.updated_at || row.created_at || null,
                created_at: row.created_at || null
            };
        }

        return map;
    }

    async getUnconfirmedAppointments(date = null) {
        await this.ensureInitialized();

        let query = `
            SELECT sv.*, sv.schedule_id AS id, to_timestamp(sv."when") AS tratamento_date
            FROM ${this.schema}.schedule_v sv
            INNER JOIN ${this.schema}.schedule s ON s.schedule_id = sv.schedule_id
            WHERE sv.confirmed = false
              AND COALESCE(s.active, true) = true
        `;

        const params = [];

        if (date) {
            query += ' AND to_timestamp(sv."when")::date = $1';
            params.push(date);
        }

        query += ' ORDER BY sv."when" ASC';

        const { rows } = await this.pool.query(query, params);
        return rows.map(row => this.mapAppointmentRow(row));
    }

    async getAllAppointments(date = null) {
        await this.ensureInitialized();

        let query = `
            SELECT sv.*, sv.schedule_id AS id, to_timestamp(sv."when") AS tratamento_date
            FROM ${this.schema}.schedule_v sv
        `;

        const params = [];

        if (date) {
            query += ' WHERE to_timestamp(sv."when")::date = $1';
            params.push(date);
        }

        query += ' ORDER BY sv."when" ASC';

        const { rows } = await this.pool.query(query, params);
        return rows.map(row => this.mapAppointmentRow(row));
    }

    async getCancelledAppointments(date = null) {
        await this.ensureInitialized();

        const params = [];
        const conditions = ['COALESCE(s.active, true) = false'];

        if (date) {
            const baseDate = new Date(`${date}T00:00:00-03:00`);
            const startEpoch = Math.floor(baseDate.getTime() / 1000);
            const endEpoch = startEpoch + 86400;

            conditions.push(`s."when" >= $${params.length + 1}`);
            params.push(startEpoch);
            conditions.push(`s."when" < $${params.length + 1}`);
            params.push(endEpoch);
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const scheduleQuery = `
            SELECT s.schedule_id, s."when"
            FROM ${this.schema}.schedule s
            ${whereClause}
            ORDER BY s."when" ASC
        `;

        const { rows: scheduleRows } = await this.pool.query(scheduleQuery, params);

        if (!Array.isArray(scheduleRows) || scheduleRows.length === 0) {
            return [];
        }

        const appointmentIds = scheduleRows.map(row => Number(row.schedule_id));

        const detailsQuery = `
            SELECT sv.*, sv.schedule_id AS id, to_timestamp(sv."when") AS tratamento_date
            FROM ${this.schema}.schedule_v sv
            WHERE sv.schedule_id = ANY($1)
        `;

        const { rows: detailRows } = await this.pool.query(detailsQuery, [appointmentIds]);
        const detailMap = {};
        for (const row of detailRows) {
            const mapped = this.mapAppointmentRow(row);
            if (mapped?.id) {
                detailMap[mapped.id] = mapped;
            }
        }

        const logMap = await this.getLatestStatusesForAppointments(appointmentIds);

        return scheduleRows.map(row => {
            const id = Number(row.schedule_id);
            const appointment = detailMap[id] ? { ...detailMap[id] } : { id, tratamento_date: new Date(row.when * 1000) };

            appointment.active = false;
            appointment.schedule_epoch = Number(row.when);

            const log = logMap[id] || null;
            if (log) {
                appointment.latest_log = log;
                appointment.cancelled_at = log.updated_at ? new Date(log.updated_at) : (log.created_at ? new Date(log.created_at) : null);
            } else {
                appointment.latest_log = null;
                appointment.cancelled_at = null;
            }

            return appointment;
        });
    }

    async getPendingInWindowNoTemplate(lookbackDays = 1, lookaheadDays = 14, limit = 30) {
        await this.ensureInitialized();

                const query = `
                        SELECT sv.*, sv.schedule_id AS id, to_timestamp(sv."when") AS tratamento_date
                        FROM ${this.schema}.schedule_v sv
                        INNER JOIN ${this.schema}.schedule s ON s.schedule_id = sv.schedule_id
                        LEFT JOIN ${this.schema}.message_logs ml
                ON ml.appointment_id::bigint = sv.schedule_id
               AND ml.type = 'template'
               AND ml.status IN ('sent', 'delivered', 'read')
            WHERE sv.confirmed = false
                            AND COALESCE(s.active, true) = true
              AND to_timestamp(sv."when") BETWEEN (NOW() - ($1::int * INTERVAL '1 day')) AND (NOW() + ($2::int * INTERVAL '1 day'))
              AND ml.id IS NULL
            ORDER BY sv."when" ASC
            LIMIT $3
        `;

        const params = [lookbackDays, lookaheadDays, limit];
        const { rows } = await this.pool.query(query, params);
        return rows.map(row => this.mapAppointmentRow(row));
    }

    async getAppointmentById(id) {
        await this.ensureInitialized();

        const query = `
            SELECT sv.*, sv.schedule_id AS id, to_timestamp(sv."when") AS tratamento_date
            FROM ${this.schema}.schedule_v sv
            WHERE sv.schedule_id = $1
            LIMIT 1
        `;

        const { rows } = await this.pool.query(query, [id]);
        return this.mapAppointmentRow(rows[0] || null);
    }

    async getAppointmentByMessageId(messageId) {
        await this.ensureInitialized();

        if (!messageId) {
            return null;
        }

        const query = `
            SELECT ml.appointment_id::bigint AS schedule_id
            FROM ${this.schema}.message_logs ml
            WHERE ml.message_id = $1
            ORDER BY COALESCE(ml.updated_at, ml.created_at) DESC NULLS LAST
            LIMIT 1
        `;

        const { rows } = await this.pool.query(query, [messageId]);
        const scheduleId = rows[0]?.schedule_id;
        if (!scheduleId) {
            return null;
        }

        try {
            return await this.getAppointmentById(Number(scheduleId));
        } catch (err) {
            console.log('[DatabaseService] Falha ao carregar agendamento por message_id:', err.message);
            return null;
        }
    }

    async getAppointmentByPatientName(patientName) {
        await this.ensureInitialized();

        const query = `
            SELECT sv.*, sv.schedule_id AS id, to_timestamp(sv."when") AS tratamento_date
            FROM ${this.schema}.schedule_v sv
            WHERE sv.patient_name ILIKE $1
            ORDER BY sv."when" DESC
            LIMIT 1
        `;

        const { rows } = await this.pool.query(query, [`%${patientName}%`]);
        return this.mapAppointmentRow(rows[0] || null);
    }

    async getLatestPendingAppointmentByPhone(phone) {
        await this.ensureInitialized();

        const digits = this.sanitizePhone(phone);
        if (!digits) {
            return null;
        }

        const variations = new Set();
        variations.add(digits);

        if (digits.startsWith('55')) {
            variations.add(digits.slice(2));
        } else {
            variations.add(`55${digits}`);
        }

        if (digits.length > 11) {
            variations.add(digits.slice(-11));
        }

        if (digits.length > 10) {
            variations.add(digits.slice(-10));
        }

        const variationsArray = Array.from(variations).filter(Boolean);

        if (variationsArray.length === 0) {
            return null;
        }

        const clauses = variationsArray
            .map((_, index) => `REGEXP_REPLACE(sv.patient_contacts, '\D', '', 'g') LIKE '%' || $${index + 1} || '%'`)
            .join(' OR ');

        const query = `
            SELECT sv.*, sv.schedule_id AS id, to_timestamp(sv."when") AS tratamento_date
            FROM ${this.schema}.schedule_v sv
            INNER JOIN ${this.schema}.schedule s ON s.schedule_id = sv.schedule_id
            WHERE sv.confirmed = false
              AND COALESCE(s.active, true) = true
              AND (${clauses})
            ORDER BY sv."when" ASC
            LIMIT 1
        `;

        const { rows } = await this.pool.query(query, variationsArray);
        return this.mapAppointmentRow(rows[0] || null);
    }

    async confirmAppointment(scheduleId) {
        await this.ensureInitialized();

        if (!scheduleId) {
            throw new Error('scheduleId é obrigatório para confirmar agendamento');
        }

        const nowEpoch = this.getEpochSeconds();

        const updateSchedule = `
            UPDATE ${this.schema}.schedule
            SET confirmed = true,
                updated_at = $2
            WHERE schedule_id = $1
        `;

        await this.pool.query(updateSchedule, [scheduleId, nowEpoch]);

        const updateScheduleMv = `
            UPDATE ${this.schema}.schedule_mv
            SET confirmed = true,
                updated_at = $2
            WHERE schedule_id = $1
        `;

        try {
            await this.pool.query(updateScheduleMv, [scheduleId, nowEpoch]);
        } catch (_) {
            // Ignora: algumas bases podem não ter schedule_mv com coluna confirmed
        }

        await this.syncScheduleViewState(scheduleId, {
            confirmed: true,
            active: true,
            nowEpoch
        });

        return { scheduleId, confirmed: true };
    }

    async cancelAppointment(scheduleId, options = {}) {
        await this.ensureInitialized();

        if (!scheduleId) {
            throw new Error('scheduleId é obrigatório para cancelar agendamento');
        }

        const nowEpoch = this.getEpochSeconds();

        const updateSchedule = `
            UPDATE ${this.schema}.schedule
            SET confirmed = false,
                active = false,
                updated_at = $2
            WHERE schedule_id = $1
        `;

        await this.pool.query(updateSchedule, [scheduleId, nowEpoch]);

        const updateScheduleMv = `
            UPDATE ${this.schema}.schedule_mv
            SET confirmed = false,
                updated_at = $2
            WHERE schedule_id = $1
        `;

        try {
            await this.pool.query(updateScheduleMv, [scheduleId, nowEpoch]);
        } catch (_) {
            // Ignora: algumas bases podem não ter schedule_mv ou coluna confirmed
        }

        await this.syncScheduleViewState(scheduleId, {
            confirmed: false,
            active: false,
            nowEpoch
        });

        const {
            phone = null,
            incomingMessageId = null,
            messageBody = null,
            cancelledBy = 'system',
            source = null,
            timestamp = null
        } = options || {};

        const shouldLog = phone || incomingMessageId || messageBody || cancelledBy || source;
        if (shouldLog) {
            await this.initMessageLogs();

            const normalizedPhone = this.formatE164(phone) || phone || null;
            const createdAt = (() => {
                if (!timestamp) {
                    return new Date();
                }
                const numericTs = Number(timestamp);
                if (!Number.isFinite(numericTs)) {
                    return new Date();
                }
                return new Date(numericTs > 1e12 ? numericTs : numericTs * 1000);
            })();

            const templateName = cancelledBy || source || null;

            await this.pool.query(
                `INSERT INTO ${this.schema}.message_logs
                    (appointment_id, phone, message_id, type, template_name, status, error_details, created_at, updated_at)
                 VALUES ($1, $2, $3, 'cancellation', $4, 'cancelled', $5, $6, $6)
                 ON CONFLICT (message_id) DO UPDATE
                    SET appointment_id = EXCLUDED.appointment_id,
                        phone = EXCLUDED.phone,
                        template_name = EXCLUDED.template_name,
                        status = EXCLUDED.status,
                        error_details = EXCLUDED.error_details,
                        updated_at = EXCLUDED.updated_at`,
                [
                    String(scheduleId),
                    normalizedPhone,
                    incomingMessageId || null,
                    templateName,
                    messageBody || null,
                    createdAt
                ]
            );

            await this.updateLatestLogStatus(scheduleId, 'cancelled');
        }

        return { scheduleId, cancelled: true };
    }

    async syncScheduleViewState(scheduleId, { confirmed = null, active = null, nowEpoch = null } = {}) {
        if (!scheduleId) {
            return;
        }

        const setters = [];
        if (confirmed !== null) {
            setters.push(`confirmed = ${confirmed ? 'true' : 'false'}`);
        }
        if (active !== null) {
            setters.push(`active = ${active ? 'true' : 'false'}`);
        }

        if (setters.length === 0) {
            return;
        }

        const withNow = `${setters.join(', ')}, updated_at = NOW()`;
        const withEpochPlaceholder = `${setters.join(', ')}, updated_at = $2`;

        try {
            await this.pool.query(
                `UPDATE ${this.schema}.schedule_v
                 SET ${withNow}
                 WHERE schedule_id = $1`,
                [scheduleId]
            );
        } catch (err) {
            const epochValue = nowEpoch ?? this.getEpochSeconds();

            try {
                await this.pool.query(
                    `UPDATE ${this.schema}.schedule_v
                     SET ${withEpochPlaceholder}
                     WHERE schedule_id = $1`,
                    [scheduleId, epochValue]
                );
            } catch (innerErr) {
                console.log('[DatabaseService] Falha ao atualizar schedule_v:', innerErr.message);
            }
        }
    }

    async registrarConfirmacao({
        appointmentId,
        phone,
        confirmedBy = 'system',
        messageBody = null,
        source = 'manual',
        incomingMessageId = null,
        timestamp = null
    }) {
        await this.ensureInitialized();

        let target = null;

        if (appointmentId) {
            target = await this.getAppointmentById(appointmentId);
        } else if (phone) {
            target = await this.getLatestPendingAppointmentByPhone(phone);
            appointmentId = target?.id;
        }

        if (appointmentId) {
            await this.confirmAppointment(appointmentId);
        }

        const normalizedPhone = this.formatE164(phone) || phone || null;
        const now = new Date();

        await this.initMessageLogs();
        await this.pool.query(
            `INSERT INTO ${this.schema}.message_logs (appointment_id, phone, message_id, type, template_name, status, error_details, created_at, updated_at)
             VALUES ($1, $2, $3, 'confirmation', $4, 'confirmed', $5, $6, $6)`,
            [
                appointmentId ? String(appointmentId) : null,
                normalizedPhone,
                incomingMessageId || null,
                confirmedBy || null,
                messageBody || null,
                now
            ]
        );

        if (appointmentId && !target?.treatment_id) {
            await this.updateLatestLogStatus(appointmentId, 'confirmed');
        }

        if (target?.treatment_id) {
            await this.updateWhatsappStatusForTreatment(target.treatment_id, 3, {
                phone: phone,
                messageBody: messageBody || `Confirmado por ${confirmedBy}`,
                direction: source === 'webhook' ? 'webhook_confirm' : 'manual_confirm',
                appointmentId,
                incomingMessageId,
                timestamp
            });
        }

        return {
            appointmentId: appointmentId || null,
            treatmentId: target?.treatment_id || null,
            confirmedBy,
            source
        };
    }

    async updateWhatsappStatusForTreatment(treatmentId, statusId, metadata = {}) {
        await this.ensureInitialized();
        await this.initMessageLogs();

        if (!treatmentId) {
            return null;
        }

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const phoneDigits = this.phoneDigitsForWhatsapp(metadata.phone) || null;
            const messageTime = metadata.timestamp ? Number(metadata.timestamp) : this.getEpochSeconds();
            const directionHint = metadata.direction || (metadata.messageBody ? 'incoming' : null);
            const descriptionSuffix = directionHint ? `_${directionHint}` : '';
            let baseDescription = 'status_update';

            if (statusId === 3) {
                baseDescription = 'confirmed';
            } else if (statusId === 2) {
                baseDescription = 'cancelled';
            } else if (statusId === 4) {
                baseDescription = 'delivered';
            } else if (statusId === 1) {
                baseDescription = 'sent';
            }

            const description = `${baseDescription}${descriptionSuffix}`;

            let appointmentId = metadata.appointmentId || null;
            if (!appointmentId) {
                const { rows: treatmentRows } = await client.query(
                    `SELECT schedule_id FROM ${this.schema}.treatment WHERE treatment_id = $1 LIMIT 1`,
                    [treatmentId]
                );
                appointmentId = treatmentRows[0]?.schedule_id || null;
            }

            const insertMessageQuery = `
                INSERT INTO ${this.schema}.whatsapp_message (
                    whatsapp_status_id,
                    whatsapp_message_phone,
                    whatsapp_message_body,
                    whatsapp_message_quoted_message_id,
                    whatsapp_message_chat_id,
                    whatsapp_message_description,
                    whatsapp_message_time,
                    whatsapp_message_created_at,
                    whatsapp_message_updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7)
                RETURNING whatsapp_message_id
            `;

            const messageBody = metadata.messageBody || null;
            const messageId = metadata.incomingMessageId || null;

            const { rows } = await client.query(insertMessageQuery, [
                statusId,
                phoneDigits,
                messageBody,
                messageId,
                messageId,
                description,
                messageTime
            ]);

            const whatsappMessageId = rows[0]?.whatsapp_message_id;

            if (whatsappMessageId) {
                const insertRelationQuery = `
                    INSERT INTO ${this.schema}.whatsapp_message_has_treatment (
                        whatsapp_message_id,
                        treatment_id,
                        wmht_is_delivery,
                        wmht_created_at,
                        telemedicine
                    ) VALUES ($1, $2, false, $3, false)
                    ON CONFLICT DO NOTHING
                `;

                await client.query(insertRelationQuery, [
                    whatsappMessageId,
                    treatmentId,
                    messageTime
                ]);
            }

            const shouldUpdateLog = ['confirmed', 'cancelled', 'delivered', 'sent'].includes(baseDescription);
            if (appointmentId && shouldUpdateLog) {
                await this.updateLatestLogStatus(appointmentId, baseDescription, client);
            }

            await client.query('COMMIT');

            return { whatsappMessageId: whatsappMessageId || null, appointmentId: appointmentId || null };
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Erro ao atualizar status do WhatsApp:', err.message);
            throw err;
        } finally {
            client.release();
        }
    }

    async buscarConfirmacoesRecentes(limit = 20) {
        await this.ensureInitialized();

        const query = `
            SELECT
                wm.whatsapp_message_id,
                wm.whatsapp_message_body,
                wm.whatsapp_message_phone,
                wm.whatsapp_message_time,
                wm.whatsapp_message_description,
                sv.schedule_id AS appointment_id,
                sv.patient_name,
                sv.patient_contacts,
                sv.main_procedure_term
            FROM ${this.schema}.whatsapp_message wm
            JOIN ${this.schema}.whatsapp_message_has_treatment wmht
              ON wmht.whatsapp_message_id = wm.whatsapp_message_id
            JOIN ${this.schema}.schedule_v sv
              ON sv.treatment_id = wmht.treatment_id
            WHERE wm.whatsapp_status_id = 3
            ORDER BY wm.whatsapp_message_time DESC
            LIMIT $1
        `;

        const { rows } = await this.pool.query(query, [limit]);

        return rows.map(row => ({
            appointment_id: row.appointment_id,
            patient_name: row.patient_name || null,
            patient_contacts: row.patient_contacts || null,
            phone: row.patient_contacts || row.whatsapp_message_phone,
            confirmed_by: row.patient_name || null,
            confirmed_at: row.whatsapp_message_time ? new Date(row.whatsapp_message_time * 1000) : null,
            main_procedure_term: row.main_procedure_term,
            message_body: row.whatsapp_message_body,
            description: row.whatsapp_message_description
        }));
    }

    async getAllMessageLogs(limit = 100) {
        await this.ensureInitialized();
        await this.initMessageLogs();

        const outboundQuery = `
            SELECT ml.*, sv.patient_name, sv.patient_contacts, sv.main_procedure_term
            FROM ${this.schema}.message_logs ml
            LEFT JOIN ${this.schema}.schedule_v sv ON sv.schedule_id = ml.appointment_id::bigint
            ORDER BY ml.created_at DESC
            LIMIT $1
        `;

        const inboundQuery = `
            SELECT
                wm.whatsapp_message_id,
                wm.whatsapp_message_body,
                wm.whatsapp_message_phone,
                wm.whatsapp_message_description,
                wm.whatsapp_message_time,
                sv.schedule_id AS appointment_id,
                sv.patient_name,
                sv.patient_contacts,
                sv.main_procedure_term
            FROM ${this.schema}.whatsapp_message wm
            JOIN ${this.schema}.whatsapp_message_has_treatment wmht ON wmht.whatsapp_message_id = wm.whatsapp_message_id
            JOIN ${this.schema}.schedule_v sv ON sv.treatment_id = wmht.treatment_id
            WHERE wm.whatsapp_status_id IN (2, 3, 4)
            ORDER BY wm.whatsapp_message_time DESC
            LIMIT $1
        `;

        const [outbound, inbound] = await Promise.all([
            this.pool.query(outboundQuery, [limit]),
            this.pool.query(inboundQuery, [limit])
        ]);

        const outboundLogs = outbound.rows.map(row => ({
            id: row.id,
            appointment_id: row.appointment_id ? Number(row.appointment_id) : null,
            phone: row.phone,
            type: row.type,
            template_name: row.template_name,
            status: row.status,
            message: row.status ? `${row.status}${row.template_name ? ` (${row.template_name})` : ''}` : row.template_name,
            created_at: row.created_at,
            updated_at: row.updated_at,
            patient_name: row.patient_name,
            main_procedure_term: row.main_procedure_term
        }));

        const inboundLogs = inbound.rows.map(row => ({
            id: `wmsg-${row.whatsapp_message_id}`,
            appointment_id: row.appointment_id,
            phone: row.patient_contacts || (row.whatsapp_message_phone ? `+${row.whatsapp_message_phone}` : null),
            type: row.whatsapp_message_description,
            template_name: null,
            status: 'received',
            message: row.whatsapp_message_body,
            created_at: row.whatsapp_message_time ? new Date(row.whatsapp_message_time * 1000) : null,
            updated_at: null,
            patient_name: row.patient_name,
            main_procedure_term: row.main_procedure_term
        }));

        const combined = [...outboundLogs, ...inboundLogs];
        combined.sort((a, b) => {
            const dateA = new Date(a.created_at || 0).getTime();
            const dateB = new Date(b.created_at || 0).getTime();
            return dateB - dateA;
        });

        return combined.slice(0, limit);
    }

    async getAppointmentStats() {
        await this.ensureInitialized();

        const statsQuery = `
            SELECT
                COUNT(*) FILTER (WHERE confirmed = true) AS confirmed,
                COUNT(*) FILTER (WHERE confirmed = false) AS pending,
                COUNT(*) AS total
            FROM ${this.schema}.schedule_v
            WHERE to_timestamp("when") >= NOW() - INTERVAL '30 days'
        `;

        const row = (await this.pool.query(statsQuery)).rows[0];

        return {
            total: Number(row.total || 0),
            confirmed: Number(row.confirmed || 0),
            pending: Number(row.pending || 0)
        };
    }

    async getAppointmentsMap(params = [], query = '') {
        await this.ensureInitialized();

        let sql = query;
        if (!sql) {
            sql = `
                SELECT sv.*, sv.schedule_id AS id, to_timestamp(sv."when") AS tratamento_date
                FROM ${this.schema}.schedule_v sv
            `;
        }

        const { rows } = await this.pool.query(sql, params);
        const map = {};

        for (const row of rows) {
            const mapped = this.mapAppointmentRow(row);
            if (mapped?.id) {
                map[mapped.id] = mapped;
            }
        }

        return map;
    }

    async getAllMessageLogsRaw(limit = 100) {
        return this.getAllMessageLogs(limit);
    }

    async testConnection() {
        try {
            await this.pool.query('SELECT 1');
            this.demoMode = false;
            return true;
        } catch (err) {
            this.demoMode = true;
            throw err;
        }
    }
}

module.exports = new DatabaseService();
