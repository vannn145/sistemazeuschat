const { Pool } = require('pg');

const DEFAULT_CONNECTION_TIMEOUT_MS = 10000;
const DEFAULT_IDLE_TIMEOUT_MS = 30000;
const hasAbortController = typeof globalThis.AbortController === 'function';

function parsePositiveInt(value) {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return undefined;
    }

    return Math.floor(parsed);
}

function createDbTimeoutError(label, timeoutMs, original) {
    const message = label ? `Database query timed out (${label})` : 'Database query timed out';
    const error = new Error(message);
    error.code = 'ZEUS_DB_TIMEOUT';

    if (Number.isFinite(timeoutMs)) {
        error.timeoutMs = timeoutMs;
    }

    if (original) {
        error.original = original;
    }

    return error;
}

class DatabaseService {
    constructor() {
        const connectionTimeout = parsePositiveInt(process.env.DB_CONNECTION_TIMEOUT_MS) || DEFAULT_CONNECTION_TIMEOUT_MS;
        const idleTimeout = parsePositiveInt(process.env.DB_IDLE_TIMEOUT_MS) || DEFAULT_IDLE_TIMEOUT_MS;
        const statementTimeout = parsePositiveInt(process.env.DB_STATEMENT_TIMEOUT_MS);
        const queryTimeout = parsePositiveInt(process.env.DB_QUERY_TIMEOUT_MS);
        const idleInTransactionTimeout = parsePositiveInt(process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS);

        const poolConfig = {
            host: process.env.DB_HOST,
            port: process.env.DB_PORT || 5432,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            ssl: process.env.DB_SSL === 'true',
            connectionTimeoutMillis: connectionTimeout,
            idleTimeoutMillis: idleTimeout,
            max: Number(process.env.DB_MAX_POOL || 10)
        };

        if (statementTimeout !== undefined) {
            poolConfig.statement_timeout = statementTimeout;
        }

        if (queryTimeout !== undefined) {
            poolConfig.query_timeout = queryTimeout;
        }

        if (idleInTransactionTimeout !== undefined) {
            poolConfig.idle_in_transaction_session_timeout = idleInTransactionTimeout;
        }

        this.pool = new Pool(poolConfig);

        console.log('[DatabaseService] Pool config:', {
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            user: process.env.DB_USER,
            database: process.env.DB_NAME,
            ssl: process.env.DB_SSL,
            connectionTimeoutMillis: connectionTimeout,
            idleTimeoutMillis: idleTimeout,
            statementTimeout: statementTimeout,
            queryTimeout: queryTimeout,
            idleInTransactionTimeout: idleInTransactionTimeout
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

    async queryWithTimeout(queryConfig, options = {}) {
        await this.ensureInitialized();

        const effectiveConfig = typeof queryConfig === 'string' ? { text: queryConfig } : { ...queryConfig };
        const timeoutMsOption = options.timeoutMs !== undefined ? parsePositiveInt(options.timeoutMs) : undefined;
        const fallbackTimeout = parsePositiveInt(process.env.DB_API_QUERY_TIMEOUT_MS) || 8000;
        const timeoutMs = timeoutMsOption || fallbackTimeout;
        const label = options.label || effectiveConfig.text?.split('\n')[0]?.trim() || 'query';

        let controller = null;
        let timer = null;

        if (hasAbortController && timeoutMs && timeoutMs > 0) {
            controller = new AbortController();
            effectiveConfig.signal = controller.signal;
            timer = setTimeout(() => controller.abort(), timeoutMs);
        }

        try {
            return await this.pool.query(effectiveConfig);
        } catch (err) {
            const isAbort = controller && err.name === 'AbortError';
            const isStatementTimeout = err.code === '57014';

            if (isAbort || isStatementTimeout) {
                console.warn(`[DatabaseService] Query timeout (${label})`, { timeoutMs, reason: isStatementTimeout ? 'statement_timeout' : 'abort_signal' });
                throw createDbTimeoutError(label, timeoutMs, err);
            }

            throw err;
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
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

    buildPhoneVariations(phone) {
        const digits = this.sanitizePhone(phone);
        if (!digits) {
            return [];
        }

        const variations = new Set();
        variations.add(digits);

        if (digits.startsWith('55')) {
            const withoutDdi = digits.slice(2);
            if (withoutDdi) {
                variations.add(withoutDdi);
            }
        } else if (digits.length >= 10) {
            variations.add(`55${digits}`);
        }

        if (digits.length > 11) {
            variations.add(digits.slice(-11));
        }

        if (digits.length > 10) {
            variations.add(digits.slice(-10));
        }

        const normalized = Array.from(variations).filter(Boolean);
        return normalized.length ? normalized : [digits];
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

    async fetchAppointmentDetailsByIds(appointmentIds = []) {
        await this.ensureInitialized();

        if (!Array.isArray(appointmentIds) || appointmentIds.length === 0) {
            return new Map();
        }

        const numericIds = Array.from(
            new Set(
                appointmentIds
                    .map((value) => Number(value))
                    .filter((value) => Number.isFinite(value) && value > 0)
            )
        );

        if (numericIds.length === 0) {
            return new Map();
        }

        const { rows } = await this.pool.query(
            `
                SELECT
                    schedule_id,
                    patient_name,
                    main_procedure_term,
                    patient_contacts
                FROM ${this.schema}.schedule_v
                WHERE schedule_id = ANY($1)
            `,
            [numericIds]
        );

        const map = new Map();
        for (const row of rows) {
            const scheduleId = Number(row.schedule_id);
            map.set(scheduleId, {
                scheduleId,
                patientName: row.patient_name || null,
                mainProcedureTerm: row.main_procedure_term || null,
                patientContacts: row.patient_contacts || null
            });
        }

        return map;
    }

    async fetchLatestScheduleByPhoneDigits(phoneDigitsList = []) {
        await this.ensureInitialized();

        if (!Array.isArray(phoneDigitsList) || phoneDigitsList.length === 0) {
            return new Map();
        }

        const cleanList = Array.from(new Set(phoneDigitsList.filter(Boolean)));
        if (cleanList.length === 0) {
            return new Map();
        }

        const { rows } = await this.pool.query(
            `
                SELECT DISTINCT ON (clean_phone)
                    clean_phone,
                    schedule_id,
                    patient_name,
                    main_procedure_term,
                    patient_contacts,
                    to_timestamp("when") AS when_ts
                FROM (
                    SELECT
                        regexp_replace(COALESCE(patient_contacts, ''), '[^0-9]', '', 'g') AS clean_phone,
                        schedule_id,
                        patient_name,
                        main_procedure_term,
                        patient_contacts,
                        "when"
                    FROM ${this.schema}.schedule_v
                    WHERE regexp_replace(COALESCE(patient_contacts, ''), '[^0-9]', '', 'g') = ANY($1)
                ) data
                WHERE clean_phone IS NOT NULL AND clean_phone <> ''
                ORDER BY clean_phone, when_ts DESC
            `,
            [cleanList]
        );

        const map = new Map();
        for (const row of rows) {
            map.set(row.clean_phone, {
                scheduleId: row.schedule_id ? Number(row.schedule_id) : null,
                patientName: row.patient_name || null,
                mainProcedureTerm: row.main_procedure_term || null,
                patientContacts: row.patient_contacts || null
            });
        }

        return map;
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
        await this.pool.query(`ALTER TABLE ${this.schema}.message_logs ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0`);
        await this.pool.query(`ALTER TABLE ${this.schema}.message_logs ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ`);
        await this.pool.query(`ALTER TABLE ${this.schema}.message_logs ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ`);
        await this.pool.query(`ALTER TABLE ${this.schema}.message_logs ADD COLUMN IF NOT EXISTS phone_digits TEXT`);
        await this.pool.query(`ALTER TABLE ${this.schema}.message_logs ADD COLUMN IF NOT EXISTS body TEXT`);
        await this.pool.query(`ALTER TABLE ${this.schema}.message_logs ADD COLUMN IF NOT EXISTS direction TEXT`);
        await this.pool.query(`ALTER TABLE ${this.schema}.message_logs ADD COLUMN IF NOT EXISTS metadata JSONB`);
        await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_message_logs_phone_digits ON ${this.schema}.message_logs (phone_digits)`);
    }

    normalizeErrorDetails(details) {
        if (!details) {
            return null;
        }
        if (typeof details === 'string') {
            return details.slice(0, 4000);
        }
        try {
            return JSON.stringify(details).slice(0, 4000);
        } catch (_) {
            return String(details).slice(0, 4000);
        }
    }

    normalizeMessageBody(body) {
        if (body === undefined || body === null) {
            return null;
        }

        if (typeof body === 'string') {
            const trimmed = body.trim();
            return trimmed ? trimmed.slice(0, 2000) : null;
        }

        try {
            const serialized = JSON.stringify(body);
            return serialized ? serialized.slice(0, 2000) : null;
        } catch (_) {
            return String(body).slice(0, 2000);
        }
    }

    normalizeDirection(direction, fallback = 'outbound') {
        if (!direction && direction !== '') {
            return fallback;
        }

        const normalized = String(direction)
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '_')
            .slice(0, 64);

        if (!normalized) {
            return fallback;
        }

        const allowed = new Set([
            'inbound',
            'outbound',
            'outbound_template',
            'outbound_template_cron',
            'outbound_manual',
            'outbound_bulk',
            'outbound_bulk_template',
            'outbound_resend',
            'status_update',
            'manual_confirm',
            'webhook_confirm',
            'webhook_cancel'
        ]);

        if (allowed.has(normalized)) {
            return normalized;
        }

        if (normalized.startsWith('outbound') || normalized.startsWith('inbound')) {
            return normalized;
        }

        return fallback;
    }

    normalizeMetadata(metadata) {
        if (metadata === undefined || metadata === null) {
            return null;
        }

        if (typeof metadata === 'string') {
            const trimmed = metadata.trim();
            if (!trimmed) {
                return null;
            }
            try {
                return JSON.parse(trimmed);
            } catch (_) {
                return { value: trimmed.slice(0, 4000) };
            }
        }

        if (metadata instanceof Date) {
            return { timestamp: metadata.toISOString() };
        }

        try {
            return JSON.parse(JSON.stringify(metadata));
        } catch (_) {
            return { value: String(metadata).slice(0, 4000) };
        }
    }

    async logOutboundMessage({
        appointmentId,
        phone,
        messageId,
        type,
        templateName,
        status,
        body = null,
        direction = null,
        metadata = null,
        errorDetails = null,
        retryCount = 0,
        nextRetryAt = null,
        lastAttemptAt = null
    }) {
        await this.ensureInitialized();
        await this.initMessageLogs();

        const normalizedPhone = this.formatE164(phone) || phone || null;
        const digitsCandidate = this.phoneDigitsForWhatsapp(phone) || this.sanitizePhone(phone);
        const phoneDigits = digitsCandidate ? digitsCandidate : null;
        const now = new Date();
        const attemptAt = lastAttemptAt instanceof Date ? lastAttemptAt : now;
        const normalizedError = this.normalizeErrorDetails(errorDetails);
        const normalizedBody = this.normalizeMessageBody(body);
        const normalizedDirection = this.normalizeDirection(direction, type === 'template' ? 'outbound_template' : 'outbound');
        const normalizedMetadata = this.normalizeMetadata(metadata);
        const safeMessageId = messageId || null;

        const query = `
            INSERT INTO ${this.schema}.message_logs
                (appointment_id, phone, phone_digits, message_id, type, template_name, status, body, direction, metadata, error_details, created_at, updated_at, retry_count, next_retry_at, last_attempt_at)
            VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13, $14, $15)
            ON CONFLICT (message_id) DO UPDATE
                SET appointment_id = EXCLUDED.appointment_id,
                    phone = EXCLUDED.phone,
                    phone_digits = EXCLUDED.phone_digits,
                    type = EXCLUDED.type,
                    template_name = EXCLUDED.template_name,
                    status = EXCLUDED.status,
                    body = EXCLUDED.body,
                    direction = EXCLUDED.direction,
                    metadata = EXCLUDED.metadata,
                    error_details = EXCLUDED.error_details,
                    updated_at = EXCLUDED.updated_at,
                    retry_count = EXCLUDED.retry_count,
                    next_retry_at = EXCLUDED.next_retry_at,
                    last_attempt_at = EXCLUDED.last_attempt_at
            RETURNING *
        `;

        const params = [
            appointmentId ? String(appointmentId) : null,
            normalizedPhone,
            phoneDigits,
            safeMessageId,
            type || null,
            templateName || null,
            status || null,
            normalizedBody,
            normalizedDirection,
            normalizedMetadata,
            normalizedError,
            now,
            retryCount,
            nextRetryAt,
            attemptAt
        ];

        const { rows } = await this.pool.query(query, params);
        return rows[0] || null;
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

    async getMessageLogsForRetry({
        limit = 10,
        statuses = ['failed', 'error'],
        types = ['template'],
        maxRetryCount = 3,
        lookbackMinutes = null
    } = {}) {
        await this.ensureInitialized();
        await this.initMessageLogs();

        const conditions = [
            'type = ANY($1)',
            'status = ANY($2)',
            'COALESCE(retry_count, 0) < $3',
            '(next_retry_at IS NULL OR next_retry_at <= NOW())'
        ];

        const params = [types, statuses, maxRetryCount];
        let paramIndex = params.length;

        if (lookbackMinutes !== null && Number.isFinite(lookbackMinutes)) {
            paramIndex += 1;
            conditions.push(`created_at >= NOW() - ($${paramIndex}::int * INTERVAL '1 minute')`);
            params.push(Math.floor(lookbackMinutes));
        }

        paramIndex += 1;
        const limitIndex = paramIndex;
        params.push(Math.max(1, Math.floor(limit)));

        const query = `
            SELECT *
            FROM ${this.schema}.message_logs
            WHERE ${conditions.join(' AND ')}
            ORDER BY COALESCE(last_attempt_at, updated_at, created_at) ASC
            LIMIT $${limitIndex}
        `;

        const queryConfig = { text: query, values: params };
        const { rows } = await this.queryWithTimeout(queryConfig, {
            timeoutMs: parsePositiveInt(process.env.DB_RECENT_LOG_TIMEOUT_MS),
            label: 'getRecentLogsByType'
        });
        return rows || [];
    }

    async getRecentLogsByType({
        types = [],
        statuses = [],
        limit = 50,
        lookbackMinutes = null
    } = {}) {
        await this.ensureInitialized();
        await this.initMessageLogs();

        if (!Array.isArray(types) || types.length === 0) {
            return [];
        }

        const params = [types];
        const conditions = ['type = ANY($1)'];
        let paramIndex = 1;

        if (Array.isArray(statuses) && statuses.length > 0) {
            paramIndex += 1;
            conditions.push(`status = ANY($${paramIndex})`);
            params.push(statuses);
        }

        if (lookbackMinutes !== null && Number.isFinite(lookbackMinutes)) {
            paramIndex += 1;
            conditions.push(`created_at >= NOW() - ($${paramIndex}::int * INTERVAL '1 minute')`);
            params.push(Math.floor(lookbackMinutes));
        }

        paramIndex += 1;
        const limitIndex = paramIndex;
        params.push(Math.max(1, Math.floor(limit)));

        const query = `
            SELECT *
            FROM ${this.schema}.message_logs
            WHERE ${conditions.join(' AND ')}
            ORDER BY COALESCE(updated_at, created_at) DESC
            LIMIT $${limitIndex}
        `;

        const { rows } = await this.pool.query(query, params);
        return rows || [];
    }

    async updateMessageLogById(logId, updates = {}) {
        if (!logId) {
            return null;
        }

        await this.ensureInitialized();
        await this.initMessageLogs();

        const fields = { ...updates };
        if (!Object.prototype.hasOwnProperty.call(fields, 'updated_at')) {
            fields.updated_at = new Date();
        }

        if (Object.prototype.hasOwnProperty.call(fields, 'error_details')) {
            fields.error_details = this.normalizeErrorDetails(fields.error_details);
        }

        if (Object.prototype.hasOwnProperty.call(fields, 'next_retry_at') && fields.next_retry_at === undefined) {
            fields.next_retry_at = null;
        }

        if (Object.prototype.hasOwnProperty.call(fields, 'last_attempt_at') && !(fields.last_attempt_at instanceof Date)) {
            fields.last_attempt_at = fields.last_attempt_at ? new Date(fields.last_attempt_at) : new Date();
        }

        if (Object.prototype.hasOwnProperty.call(fields, 'message_id') && fields.message_id !== null && fields.message_id !== undefined) {
            fields.message_id = String(fields.message_id);
        }

        const columns = [];
        const params = [];
        let index = 1;

        for (const [column, value] of Object.entries(fields)) {
            columns.push(`${column} = $${index}`);
            params.push(value);
            index++;
        }

        params.push(logId);

        const query = `
            UPDATE ${this.schema}.message_logs
            SET ${columns.join(', ')}
            WHERE id = $${index}
            RETURNING *
        `;

        const queryConfig = { text: query, values: params };
        const { rows } = await this.queryWithTimeout(queryConfig, {
            timeoutMs: parsePositiveInt(process.env.DB_LOG_MESSAGE_TIMEOUT_MS),
            label: 'logOutboundMessage'
        });
        return rows[0] || null;
    }

    async updateMessageStatus(messageId, status, errorDetails = null, options = {}) {
        if (!messageId) {
            return;
        }

        await this.ensureInitialized();
        await this.initMessageLogs();

        const now = new Date();
        const normalizedError = this.normalizeErrorDetails(errorDetails);

        const fields = {
            status: status || null,
            error_details: normalizedError,
            updated_at: now
        };

        if (Object.prototype.hasOwnProperty.call(options, 'retryCount')) {
            fields.retry_count = options.retryCount;
        }

        if (Object.prototype.hasOwnProperty.call(options, 'nextRetryAt')) {
            fields.next_retry_at = options.nextRetryAt || null;
        }

        if (Object.prototype.hasOwnProperty.call(options, 'lastAttemptAt')) {
            fields.last_attempt_at = options.lastAttemptAt || now;
        }

        const columns = [];
        const params = [messageId];
        let index = 2;
        for (const [column, value] of Object.entries(fields)) {
            columns.push(`${column} = $${index}`);
            params.push(value);
            index++;
        }

        const updateQuery = `
            UPDATE ${this.schema}.message_logs
            SET ${columns.join(', ')}
            WHERE message_id = $1
        `;

        const result = await this.pool.query(updateQuery, params);

        if (result.rowCount === 0) {
            const retryCount = Object.prototype.hasOwnProperty.call(options, 'retryCount')
                ? options.retryCount
                : 0;
            const nextRetryAt = Object.prototype.hasOwnProperty.call(options, 'nextRetryAt')
                ? options.nextRetryAt || null
                : null;
            const lastAttemptAt = Object.prototype.hasOwnProperty.call(options, 'lastAttemptAt')
                ? options.lastAttemptAt || now
                : now;

            const insertQuery = `
                INSERT INTO ${this.schema}.message_logs
                    (appointment_id, phone, message_id, type, template_name, status, error_details, created_at, updated_at, retry_count, next_retry_at, last_attempt_at)
                VALUES
                    (NULL, NULL, $1, 'status', NULL, $2, $3, $4, $4, $5, $6, $7)
            `;

            await this.pool.query(insertQuery, [messageId, status || null, normalizedError, now, retryCount, nextRetryAt, lastAttemptAt]);
        }
    }

    async getLatestStatusesForAppointments(appointmentIds = []) {
        await this.ensureInitialized();

        if (!Array.isArray(appointmentIds) || appointmentIds.length === 0) {
            return {};
        }

        const ids = appointmentIds.map(id => String(id));

        const queryConfig = {
            text: `
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
            `,
            values: [ids]
        };

        const { rows } = await this.queryWithTimeout(queryConfig, {
            timeoutMs: parsePositiveInt(process.env.DB_STATUS_QUERY_TIMEOUT_MS),
            label: 'getLatestStatusesForAppointments'
        });
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

        const { rows: scheduleRows } = await this.queryWithTimeout({ text: scheduleQuery, values: params }, {
            timeoutMs: parsePositiveInt(process.env.DB_REMINDER_SCHEDULE_TIMEOUT_MS),
            label: 'getPendingAppointments.schedule'
        });

        if (!Array.isArray(scheduleRows) || scheduleRows.length === 0) {
            return [];
        }

        const appointmentIds = scheduleRows.map(row => Number(row.schedule_id));

        const detailsQuery = `
            SELECT sv.*, sv.schedule_id AS id, to_timestamp(sv."when") AS tratamento_date
            FROM ${this.schema}.schedule_v sv
            WHERE sv.schedule_id = ANY($1)
        `;

        const { rows: detailRows } = await this.queryWithTimeout({ text: detailsQuery, values: [appointmentIds] }, {
            timeoutMs: parsePositiveInt(process.env.DB_REMINDER_DETAILS_TIMEOUT_MS),
            label: 'getPendingAppointments.details'
        });
        const detailMap = {};
        for (const row of detailRows) {
            const mapped = this.mapAppointmentRow(row);
            if (mapped?.id) {
                detailMap[mapped.id] = mapped;
            }
        }

        let logMap = {};
        try {
            logMap = await this.getLatestStatusesForAppointments(appointmentIds);
        } catch (error) {
            if (error.code === 'ZEUS_DB_TIMEOUT') {
                console.warn('[DatabaseService] Timeout while fetching latest statuses; continuing without logs.');
                logMap = {};
            } else {
                throw error;
            }
        }

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

    async getAppointmentsForReminder({
        startDate,
        endDate,
        limit = 50,
        requireConfirmed = false
    } = {}) {
        await this.ensureInitialized();
        await this.initMessageLogs();

        if (!startDate || !endDate) {
            return [];
        }

        const conditions = [
            'COALESCE(s.active, true) = true',
            'to_timestamp(s."when") BETWEEN $1 AND $2'
        ];
        const params = [startDate, endDate];

        if (requireConfirmed) {
            conditions.push('sv.confirmed = true');
        }

        const query = `
            SELECT sv.*, sv.schedule_id AS id, to_timestamp(s."when") AS tratamento_date
            FROM ${this.schema}.schedule_v sv
            INNER JOIN ${this.schema}.schedule s ON s.schedule_id = sv.schedule_id
            LEFT JOIN ${this.schema}.message_logs ml
                ON ml.appointment_id::bigint = sv.schedule_id
               AND ml.type = 'reminder'
               AND ml.status IN ('sent', 'delivered', 'read')
            WHERE ${conditions.join(' AND ')}
              AND ml.id IS NULL
            ORDER BY s."when" ASC
            LIMIT $3
        `;

        const queryConfig = {
            text: query,
            values: [...params, Math.max(1, Math.floor(limit))]
        };

        try {
            const { rows } = await this.queryWithTimeout(queryConfig, {
                timeoutMs: parsePositiveInt(process.env.DB_REMINDER_FETCH_TIMEOUT_MS),
                label: 'getAppointmentsForReminder'
            });
            return rows.map(row => this.mapAppointmentRow(row));
        } catch (error) {
            if (error.code !== 'ZEUS_DB_TIMEOUT') {
                throw error;
            }

            console.warn('[DatabaseService] Consulta principal de lembretes excedeu timeout, aplicando fallback simplificado.');

            const fallbackQuery = `
                SELECT sv.*, sv.schedule_id AS id, to_timestamp(s."when") AS tratamento_date
                FROM ${this.schema}.schedule_v sv
                INNER JOIN ${this.schema}.schedule s ON s.schedule_id = sv.schedule_id
                WHERE ${conditions.join(' AND ')}
                ORDER BY s."when" ASC
                LIMIT $3
            `;

            const fallbackConfig = {
                text: fallbackQuery,
                values: [...params, Math.max(1, Math.floor(limit))]
            };

            let fallbackRows = [];
            try {
                const timeoutMs = parsePositiveInt(process.env.DB_REMINDER_FALLBACK_TIMEOUT_MS) || 10000;
                const { rows } = await this.queryWithTimeout(fallbackConfig, {
                    timeoutMs,
                    label: 'getAppointmentsForReminder.fallback'
                });
                fallbackRows = rows;
            } catch (fallbackError) {
                console.warn('[DatabaseService] Fallback de lembretes também excedeu timeout.', fallbackError.message);
                throw error;
            }

            if (!Array.isArray(fallbackRows) || fallbackRows.length === 0) {
                return [];
            }

            const appointmentIds = fallbackRows.map(row => Number(row.schedule_id)).filter(Number.isFinite);
            if (appointmentIds.length === 0) {
                return fallbackRows.map(row => this.mapAppointmentRow(row));
            }

            try {
                const logQuery = {
                    text: `
                        SELECT DISTINCT appointment_id
                        FROM ${this.schema}.message_logs
                        WHERE appointment_id = ANY($1)
                          AND type = 'reminder'
                          AND status IN ('sent', 'delivered', 'read')
                    `,
                    values: [appointmentIds.map(id => String(id))]
                };

                const { rows: logRows } = await this.queryWithTimeout(logQuery, {
                    timeoutMs: parsePositiveInt(process.env.DB_REMINDER_LOG_CHECK_TIMEOUT_MS) || 5000,
                    label: 'getAppointmentsForReminder.logCheck'
                });

                if (Array.isArray(logRows) && logRows.length > 0) {
                    const sentSet = new Set(logRows.map(r => Number(r.appointment_id)));
                    fallbackRows = fallbackRows.filter(row => !sentSet.has(Number(row.schedule_id)));
                }
            } catch (logCheckError) {
                console.warn('[DatabaseService] Falha ao filtrar lembretes já enviados durante fallback:', logCheckError.message);
            }

            return fallbackRows.map(row => this.mapAppointmentRow(row));
        }
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

        const variationsArray = this.buildPhoneVariations(phone);

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

    async getLatestAppointmentFromLogsByPhone(phone) {
        await this.ensureInitialized();
        await this.initMessageLogs();

        const variationsArray = this.buildPhoneVariations(phone);
        if (variationsArray.length === 0) {
            return null;
        }

        const clauses = variationsArray
            .map((_, index) => `REGEXP_REPLACE(ml.phone, '\\D', '', 'g') LIKE '%' || $${index + 1} || '%'`)
            .join(' OR ');

        const query = `
            SELECT ml.appointment_id
            FROM ${this.schema}.message_logs ml
            WHERE ml.appointment_id IS NOT NULL
              AND (${clauses})
            ORDER BY COALESCE(ml.updated_at, ml.created_at) DESC NULLS LAST
            LIMIT 1
        `;

        const { rows } = await this.pool.query(query, variationsArray);
        const appointmentIdRaw = rows[0]?.appointment_id;
        const appointmentId = appointmentIdRaw ? Number(appointmentIdRaw) : null;
        if (!appointmentId) {
            return null;
        }

        try {
            return await this.getAppointmentById(appointmentId);
        } catch (err) {
            console.log('[DatabaseService] Falha ao carregar agendamento via logs:', err.message);
            return null;
        }
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

        try {
            await this.removeAppointmentFromAgenda(scheduleId);
        } catch (purgeError) {
            console.log('[DatabaseService] Falha ao remover agendamento da agenda:', purgeError.message);
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

    async removeAppointmentFromAgenda(scheduleId) {
        await this.ensureInitialized();

        if (!scheduleId) {
            return;
        }

        const numericId = Number(scheduleId);
        if (!Number.isFinite(numericId)) {
            return;
        }

        const nowEpoch = this.getEpochSeconds();
        let baseRemoved = false;

        try {
            await this.pool.query(
                `DELETE FROM ${this.schema}.schedule_mv WHERE schedule_id = $1`,
                [numericId]
            );
        } catch (err) {
            console.log(`[DatabaseService] Aviso: falha ao atualizar schedule_mv na remoção do agendamento ${numericId}:`, err.message);
        }

        try {
            const { rowCount } = await this.pool.query(
                `DELETE FROM ${this.schema}.schedule WHERE schedule_id = $1`,
                [numericId]
            );
            baseRemoved = rowCount > 0;
        } catch (err) {
            console.log(`[DatabaseService] Aviso: falha ao remover registro base da agenda ${numericId}:`, err.message);
        }

        if (!baseRemoved) {
            try {
                await this.pool.query(
                    `UPDATE ${this.schema}.schedule
                     SET confirmed = false,
                         active = false,
                         updated_at = $2
                     WHERE schedule_id = $1`,
                    [numericId, nowEpoch]
                );
            } catch (err) {
                console.log(`[DatabaseService] Aviso: falha ao sinalizar agendamento ${numericId} como inativo:`, err.message);
            }
        }

        try {
            await this.pool.query(
                `UPDATE ${this.schema}.treatment
                 SET treatment_status_id = 2,
                     ended_at = COALESCE(ended_at, $2)
                 WHERE schedule_id = $1
                   AND COALESCE(treatment_status_id, 0) <> 2`,
                [numericId, nowEpoch]
            );
        } catch (err) {
            console.log(`[DatabaseService] Aviso: falha ao sinalizar tratamento relacionado ao agendamento ${numericId} como cancelado:`, err.message);
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
            if (!target) {
                const fromLogs = await this.getLatestAppointmentFromLogsByPhone(phone);
                if (fromLogs) {
                    target = fromLogs;
                    appointmentId = fromLogs.id;
                }
            }
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

    async listConversationThreads({ limit = 30, search = null, lookbackHours = 720 } = {}) {
        await this.ensureInitialized();
        await this.initMessageLogs();

        const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 200);
        const safeLookback = Math.min(Math.max(Number(lookbackHours) || 720, 1), 24 * 365);

        let textSearchTokens = [];
        let digitSearchValue = null;
        if (search && typeof search === 'string') {
            const trimmed = search.trim();
            if (trimmed) {
                textSearchTokens = trimmed
                    .toLowerCase()
                    .split(/\s+/)
                    .filter(Boolean);
                const digits = (trimmed.match(/\d+/g) || []).join('');
                if (digits) {
                    digitSearchValue = digits;
                }
            }
        }

        const sampleMultiplier = textSearchTokens.length > 0 ? 40 : 15;
        const sampleSize = Math.min(Math.max(safeLimit * sampleMultiplier, safeLimit), 5000);

        const params = [safeLookback];
        let digitClause = '';
        let digitParamIndex = null;
        if (digitSearchValue) {
            digitParamIndex = params.length + 1;
            params.push(`%${digitSearchValue}%`);
            digitClause = `
        AND phone_key LIKE $${digitParamIndex}`;
        }

        const sampleParamIndex = params.length + 1;
        params.push(sampleSize);
        const finalParamIndex = params.length + 1;
        params.push(safeLimit);

        const query = `
            WITH base AS (
                SELECT
                    ml.id,
                    ml.appointment_id,
                    ml.message_id,
                    ml.type,
                    ml.template_name,
                    ml.status,
                    ml.body,
                    ml.direction,
                    ml.metadata,
                    ml.error_details,
                    ml.phone,
                    ml.phone_digits,
                    COALESCE(ml.updated_at, ml.created_at) AS ts,
                    COALESCE(
                        NULLIF(ml.phone_digits, ''),
                        regexp_replace(COALESCE(ml.phone, ''), '[^0-9]', '', 'g')
                    ) AS phone_key,
                    CASE
                        WHEN (ml.appointment_id)::text ~ '^[0-9]+$' THEN (ml.appointment_id)::text::bigint
                        ELSE NULL
                    END AS appointment_id_numeric
                FROM ${this.schema}.message_logs ml
                WHERE COALESCE(ml.updated_at, ml.created_at) >= NOW() - make_interval(hours => $1)
            ),
            filtered AS (
                SELECT *
                FROM base
                WHERE phone_key IS NOT NULL AND phone_key <> ''${digitClause}
                ORDER BY ts DESC
                LIMIT $${sampleParamIndex}
            ),
            stats AS (
                SELECT
                    phone_key,
                    MAX(ts) AS last_timestamp,
                    MAX(CASE WHEN direction = 'inbound' THEN ts END) AS last_inbound_at,
                    MAX(CASE WHEN direction LIKE 'outbound%' THEN ts END) AS last_outbound_at,
                    COUNT(*) FILTER (WHERE direction = 'inbound' AND ts >= NOW() - INTERVAL '48 hours') AS inbound_last48,
                    COUNT(*) FILTER (WHERE direction LIKE 'outbound%' AND ts >= NOW() - INTERVAL '48 hours') AS outbound_last48,
                    BOOL_OR(direction = 'inbound' AND ts >= NOW() - INTERVAL '24 hours') AS needs_response
                FROM filtered
                GROUP BY phone_key
            ),
            latest AS (
                SELECT DISTINCT ON (phone_key)
                    phone_key,
                    id,
                    appointment_id,
                    message_id,
                    type,
                    template_name,
                    status,
                    body,
                    direction,
                    metadata,
                    error_details,
                    phone,
                    phone_digits,
                    ts,
                    appointment_id_numeric
                FROM filtered
                ORDER BY phone_key, ts DESC
            )
            SELECT
                stats.phone_key,
                stats.last_timestamp,
                stats.last_inbound_at,
                stats.last_outbound_at,
                stats.inbound_last48,
                stats.outbound_last48,
                stats.needs_response,
                latest.id AS last_id,
                latest.appointment_id,
                latest.message_id,
                latest.type AS last_type,
                latest.template_name AS last_template_name,
                latest.status AS last_status,
                latest.body AS last_body,
                latest.direction AS last_direction,
                latest.metadata AS last_metadata,
                latest.error_details AS last_error_details,
                latest.phone AS last_phone,
                latest.phone_digits AS last_phone_digits,
                latest.ts AS last_ts,
                latest.appointment_id_numeric
            FROM stats
            JOIN latest ON latest.phone_key = stats.phone_key
            ORDER BY stats.last_timestamp DESC
            LIMIT $${finalParamIndex}
        `;

        const { rows } = await this.pool.query(query, params);

        if (!rows.length) {
            return [];
        }

        const appointmentIds = new Set();
        const phoneDigitsSet = new Set();

        const baseThreads = rows.map((row) => {
            if (row.appointment_id_numeric) {
                appointmentIds.add(Number(row.appointment_id_numeric));
            }
            if (row.phone_key) {
                phoneDigitsSet.add(row.phone_key);
            }

            let metadata = row.last_metadata;
            if (metadata && typeof metadata === 'string') {
                try {
                    metadata = JSON.parse(metadata);
                } catch (_) {
                    metadata = { raw: metadata };
                }
            }

            const lastTimestamp = row.last_ts ? new Date(row.last_ts) : null;
            const lastInbound = row.last_inbound_at ? new Date(row.last_inbound_at) : null;
            const lastOutbound = row.last_outbound_at ? new Date(row.last_outbound_at) : null;

            const phoneDisplay = row.last_phone
                || (row.last_phone_digits ? `+${row.last_phone_digits.replace(/^\+/, '')}` : null)
                || (row.phone_key ? `+${row.phone_key}` : null);

            return {
                phoneKey: row.phone_key,
                phoneDisplay: phoneDisplay || null,
                appointmentId: row.appointment_id_numeric ? Number(row.appointment_id_numeric) : null,
                lastMessage: {
                    id: row.last_id,
                    messageId: row.message_id || null,
                    body: row.last_body || null,
                    status: row.last_status || null,
                    type: row.last_type || null,
                    direction: row.last_direction || null,
                    metadata,
                    errorDetails: row.last_error_details || null,
                    templateName: row.last_template_name || null,
                    timestamp: lastTimestamp
                },
                lastInboundAt: lastInbound,
                lastOutboundAt: lastOutbound,
                lastTimestamp,
                inboundCount48h: Number(row.inbound_last48 || 0),
                outboundCount48h: Number(row.outbound_last48 || 0),
                needsResponse: Boolean(row.needs_response)
            };
        });

        const [appointmentDetails, scheduleByPhone] = await Promise.all([
            this.fetchAppointmentDetailsByIds(Array.from(appointmentIds)),
            this.fetchLatestScheduleByPhoneDigits(Array.from(phoneDigitsSet))
        ]);

        const threads = baseThreads.map((thread) => {
            const appointmentInfo = thread.appointmentId ? appointmentDetails.get(thread.appointmentId) : null;
            const phoneInfo = scheduleByPhone.get(thread.phoneKey);

            return {
                ...thread,
                patientName: appointmentInfo?.patientName || phoneInfo?.patientName || null,
                mainProcedureTerm: appointmentInfo?.mainProcedureTerm || phoneInfo?.mainProcedureTerm || null,
                patientContacts: appointmentInfo?.patientContacts || phoneInfo?.patientContacts || null
            };
        });

        if (textSearchTokens.length > 0) {
            const filtered = threads.filter((thread) => {
                const haystack = [
                    thread.patientName || '',
                    thread.phoneDisplay || '',
                    thread.lastMessage?.body || '',
                    thread.mainProcedureTerm || ''
                ]
                    .map((value) => value.toLowerCase())
                    .join(' ');

                return textSearchTokens.every((token) => haystack.includes(token));
            });
            return filtered.slice(0, safeLimit);
        }

        return threads.slice(0, safeLimit);
    }

    async getConversationMessages(phoneKey, { limit = 100, before = null } = {}) {
        await this.ensureInitialized();
        await this.initMessageLogs();

        const normalizedKey = String(phoneKey || '').replace(/\D/g, '');
        if (!normalizedKey) {
            return [];
        }

        const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
        const params = [normalizedKey];
        let beforeClause = '';
        if (before instanceof Date && !Number.isNaN(before.getTime())) {
            params.push(before);
            beforeClause = `
            AND COALESCE(ml.updated_at, ml.created_at) < $2`;
        }
        const limitParamIndex = params.length + 1;
        params.push(safeLimit);

        const query = `
            SELECT
                ml.id,
                ml.appointment_id,
                ml.message_id,
                ml.type,
                ml.template_name,
                ml.status,
                ml.body,
                ml.direction,
                ml.metadata,
                ml.error_details,
                ml.phone,
                ml.phone_digits,
                ml.created_at,
                ml.updated_at
            FROM ${this.schema}.message_logs ml
            WHERE COALESCE(NULLIF(ml.phone_digits, ''), regexp_replace(COALESCE(ml.phone, ''), '[^0-9]', '', 'g')) = $1
            ${beforeClause}
            ORDER BY COALESCE(ml.updated_at, ml.created_at) DESC
            LIMIT $${limitParamIndex}
        `;

        const { rows } = await this.pool.query(query, params);

        const messages = rows.map((row) => {
            let metadata = row.metadata;
            if (metadata && typeof metadata === 'string') {
                try {
                    metadata = JSON.parse(metadata);
                } catch (_) {
                    metadata = { raw: metadata };
                }
            }

            const createdAt = row.created_at ? new Date(row.created_at) : null;
            const updatedAt = row.updated_at ? new Date(row.updated_at) : null;
            const timestamp = updatedAt || createdAt;

            return {
                id: row.id,
                appointmentId: row.appointment_id ? Number(row.appointment_id) : null,
                messageId: row.message_id || null,
                type: row.type || null,
                templateName: row.template_name || null,
                status: row.status || null,
                body: row.body || null,
                direction: row.direction || null,
                metadata,
                errorDetails: row.error_details || null,
                phone: row.phone || null,
                phoneDigits: row.phone_digits || null,
                createdAt,
                updatedAt,
                timestamp
            };
        });

        return messages.reverse();
    }

    async getConversationSession(phoneKey) {
        await this.ensureInitialized();
        await this.initMessageLogs();

        const variations = this.buildPhoneVariations(phoneKey);
        if (!variations.length) {
            return {
                phoneKey: null,
                lastInboundAt: null,
                lastOutboundAt: null,
                lastMessageAt: null
            };
        }

        const digits = variations
            .map((value) => (value.match(/\d+/g) || []).join(''))
            .filter(Boolean);

        if (!digits.length) {
            return {
                phoneKey: null,
                lastInboundAt: null,
                lastOutboundAt: null,
                lastMessageAt: null
            };
        }

        const query = `
            SELECT
                MAX(CASE WHEN direction = 'inbound' THEN COALESCE(updated_at, created_at) END) AS last_inbound_at,
                MAX(CASE WHEN direction LIKE 'outbound%' THEN COALESCE(updated_at, created_at) END) AS last_outbound_at,
                MAX(COALESCE(updated_at, created_at)) AS last_message_at
            FROM ${this.schema}.message_logs
            WHERE phone_digits = ANY($1)
               OR regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ANY($1)
        `;

        const { rows } = await this.pool.query(query, [digits]);
        const row = rows[0] || {};

        return {
            phoneKey: digits[0] || null,
            lastInboundAt: row.last_inbound_at ? new Date(row.last_inbound_at) : null,
            lastOutboundAt: row.last_outbound_at ? new Date(row.last_outbound_at) : null,
            lastMessageAt: row.last_message_at ? new Date(row.last_message_at) : null
        };
    }

    async getMessageLogStats({ startDate = null, endDate = null } = {}) {
        await this.ensureInitialized();
        await this.initMessageLogs();

        const conditions = [];
        const params = [];

        if (startDate) {
            params.push(startDate);
            conditions.push(`created_at >= $${params.length}`);
        }

        if (endDate) {
            params.push(endDate);
            conditions.push(`created_at < $${params.length}`);
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const query = `
            SELECT type, status, COUNT(*) AS total
            FROM ${this.schema}.message_logs
            ${whereClause}
            GROUP BY type, status
        `;

        const { rows } = await this.pool.query(query, params);
        const summary = { total: 0, types: {} };

        for (const row of rows) {
            const type = row.type || 'unknown';
            const status = row.status || 'unknown';
            const count = Number(row.total || 0);
            summary.total += count;
            if (!summary.types[type]) {
                summary.types[type] = { total: 0, statuses: {} };
            }
            summary.types[type].total += count;
            summary.types[type].statuses[status] = count;
        }

        return summary;
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
