const express = require('express');
const path = require('path');
const router = express.Router();
const dbService = require('../services/database');
const cronService = require('../services/cron');
const retryCronService = require('../services/retry-cron');
const reminderCronService = require('../services/reminder-cron');
const activityLog = require('../services/activity-log');
const whatsappService = require('../services/whatsapp-hybrid');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const ADMIN_DISPLAY_NAME = process.env.ADMIN_DISPLAY_NAME || 'Zeus Chat';
const ADMIN_UI_DIR = path.join(__dirname, '../../public/admin');
const DASHBOARD_HTML = path.join(ADMIN_UI_DIR, 'index.html');
const LOGIN_HTML = path.join(ADMIN_UI_DIR, 'login.html');

const CONFIRM_KEYWORDS = ['confirm', 'sim', 'ok', 'certo', 'confirmado', 'confirmar', 'ack'];
const CANCEL_KEYWORDS = ['cancel', 'desmarc', 'nao', 'não', 'cancelar', 'desmarcar'];

function normalizePhoneKey(raw) {
    return String(raw || '').replace(/\D/g, '');
}

function ensureAuthenticated(req, res, next) {
    if (req?.session?.isAdmin) {
        return next();
    }
    return res.status(401).json({ success: false, message: 'Não autenticado' });
}

function detectIntentFromMessage(message) {
    if (!message || typeof message !== 'object') {
        return null;
    }

    const candidates = [];
    if (message.text?.body) candidates.push(message.text.body);
    if (message.button?.text) candidates.push(message.button.text);
    if (message.button?.payload) candidates.push(message.button.payload);

    const interactive = message.interactive;
    if (interactive?.button_reply?.title) candidates.push(interactive.button_reply.title);
    if (interactive?.button_reply?.id) candidates.push(interactive.button_reply.id);
    if (interactive?.list_reply?.title) candidates.push(interactive.list_reply.title);
    if (interactive?.list_reply?.id) candidates.push(interactive.list_reply.id);

    const matchKeyword = (keywords) => candidates.some((value) => {
        if (!value || typeof value !== 'string') {
            return false;
        }
        const normalized = value.toLowerCase();
        return keywords.some((keyword) => normalized.includes(keyword));
    });

    if (matchKeyword(CONFIRM_KEYWORDS)) {
        return 'Confirmado';
    }
    if (matchKeyword(CANCEL_KEYWORDS)) {
        return 'Desmarcado';
    }
    return null;
}

function normalizeTimestamp(value, fallbackIso) {
    if (value === null || value === undefined) {
        return fallbackIso;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
        const millis = numeric > 1e12 ? numeric : numeric * 1000;
        const date = new Date(millis);
        if (!Number.isNaN(date.getTime())) {
            return date.toISOString();
        }
    }
    if (typeof value === 'string') {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) {
            return date.toISOString();
        }
    }
    return fallbackIso;
}

function extractWebhookSummaries(event) {
    const fallbackIso = event?.createdAt || new Date().toISOString();
    const payload = event?.payload || {};
    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    const summaries = [];

    entries.forEach((entry) => {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];
        changes.forEach((change) => {
            if (change?.field !== 'messages') {
                return;
            }
            const value = change.value || {};
            const messages = Array.isArray(value.messages) ? value.messages : [];
            messages.forEach((message) => {
                const intent = detectIntentFromMessage(message);
                if (!intent) {
                    return;
                }
                const phoneRaw = message.from || message.customer?.phone || null;
                const phone = dbService.formatE164(phoneRaw) || phoneRaw || null;
                const timestamp = normalizeTimestamp(message.timestamp, fallbackIso);
                summaries.push({ phone, status: intent, timestamp });
            });
        });
    });

    return summaries;
}

router.get('/', (req, res) => {
    if (req?.session?.isAdmin) {
        return res.sendFile(DASHBOARD_HTML);
    }
    return res.sendFile(LOGIN_HTML);
});

router.get('/login', (req, res) => {
    if (req?.session?.isAdmin) {
        return res.redirect('/admin');
    }
    return res.sendFile(LOGIN_HTML);
});

router.post('/api/login', (req, res) => {
    const username = (req.body?.username || '').trim();
    const password = req.body?.password || '';
    if (!ADMIN_PASS) {
        return res.status(500).json({ success: false, message: 'Credenciais administrativas não configuradas' });
    }
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        req.session.isAdmin = true;
        req.session.adminUser = username;
        return res.json({ success: true, displayName: ADMIN_DISPLAY_NAME });
    }
    return res.status(401).json({ success: false, message: 'Usuário ou senha inválidos' });
});

router.post('/api/logout', ensureAuthenticated, (req, res) => {
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

router.get('/api/session', (req, res) => {
    const authenticated = Boolean(req?.session?.isAdmin);
    res.json({
        success: true,
        authenticated,
        user: authenticated ? {
            username: req.session.adminUser || ADMIN_USER,
            displayName: ADMIN_DISPLAY_NAME
        } : null
    });
});

router.get('/api/overview', ensureAuthenticated, async (req, res) => {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const payload = {
        generatedAt: now.toISOString(),
        stats: null,
        messageLogsToday: null,
        cron: {
            primary: cronService.getStatus?.() || null,
            retry: retryCronService.getStatus ? retryCronService.getStatus() : null,
            reminder: reminderCronService.getStatus ? reminderCronService.getStatus() : null
        },
        database: { connected: false, error: null }
    };

    try {
        payload.stats = await dbService.getAppointmentStats();
    } catch (err) {
        payload.statsError = err?.message || String(err);
    }

    try {
        payload.messageLogsToday = await dbService.getMessageLogStats({ startDate: todayStart });
    } catch (err) {
        payload.messageLogError = err?.message || String(err);
    }

    try {
        await dbService.testConnection();
        payload.database.connected = true;
    } catch (err) {
        payload.database.error = err?.message || String(err);
    }

    const recentWebhook = activityLog.getRecentEvents({ limit: 5 });
    payload.recentWebhook = recentWebhook;

    res.json({ success: true, data: payload });
});

router.get('/api/message-logs', ensureAuthenticated, async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const typeFilter = (req.query.type || '').trim().toLowerCase();
    const statusFilter = (req.query.status || '').trim().toLowerCase();

    try {
        const logs = await dbService.getAllMessageLogs(limit * 2);
        const filtered = logs.filter((log) => {
            const typeMatch = typeFilter && typeFilter !== 'all'
                ? (log.type || '').toLowerCase() === typeFilter
                : true;
            const statusMatch = statusFilter
                ? (log.status || '').toLowerCase() === statusFilter
                : true;
            return typeMatch && statusMatch;
        }).slice(0, limit);
        res.json({ success: true, data: filtered });
    } catch (err) {
        console.error('[Admin] Falha ao consultar message logs:', err);
        res.json({ success: false, data: [], error: err?.message || String(err) });
    }
});

router.get('/api/webhook-events', ensureAuthenticated, (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 200);
    try {
        const rawEvents = activityLog.getRecentEvents({ limit: limit * 3 });
        const flattened = [];
        rawEvents.forEach((event) => {
            const items = extractWebhookSummaries(event);
            items.forEach((item) => {
                flattened.push({
                    phone: item.phone,
                    status: item.status,
                    timestamp: item.timestamp,
                    createdAt: item.timestamp
                });
            });
        });
        flattened.sort((a, b) => {
            const tsA = new Date(a.timestamp || a.createdAt || 0).getTime();
            const tsB = new Date(b.timestamp || b.createdAt || 0).getTime();
            return tsB - tsA;
        });
        res.json({ success: true, data: flattened.slice(0, limit) });
    } catch (err) {
        console.error('[Admin] Falha ao carregar eventos de webhook:', err);
        res.json({ success: false, data: [], error: err?.message || String(err) });
    }
});

router.get('/api/conversations', ensureAuthenticated, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10);
        const lookbackHours = parseInt(req.query.lookbackHours, 10);
        const data = await dbService.listConversationThreads({
            limit: Number.isFinite(limit) ? limit : undefined,
            search: req.query.search || null,
            lookbackHours: Number.isFinite(lookbackHours) ? lookbackHours : undefined
        });
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, message: err?.message || String(err) });
    }
});

router.get('/api/conversations/:phone/messages', ensureAuthenticated, async (req, res) => {
    try {
        const phoneKey = normalizePhoneKey(req.params.phone);
        if (!phoneKey) {
            return res.status(400).json({ success: false, message: 'Identificador de conversa inválido' });
        }
        const limit = parseInt(req.query.limit, 10);
        const beforeRaw = req.query.before || null;
        let before = null;
        if (beforeRaw) {
            const parsed = new Date(beforeRaw);
            if (!Number.isNaN(parsed.getTime())) {
                before = parsed;
            }
        }
        const [messages, session] = await Promise.all([
            dbService.getConversationMessages(phoneKey, {
                limit: Number.isFinite(limit) ? limit : undefined,
                before
            }),
            dbService.getConversationSession(phoneKey)
        ]);
        res.json({ success: true, data: { phoneKey, messages, session } });
    } catch (err) {
        res.status(500).json({ success: false, message: err?.message || String(err) });
    }
});

router.get('/api/conversations/:phone/session', ensureAuthenticated, async (req, res) => {
    try {
        const phoneKey = normalizePhoneKey(req.params.phone);
        if (!phoneKey) {
            return res.status(400).json({ success: false, message: 'Identificador de conversa inválido' });
        }
        const session = await dbService.getConversationSession(phoneKey);
        res.json({ success: true, data: session });
    } catch (err) {
        res.status(500).json({ success: false, message: err?.message || String(err) });
    }
});

router.post('/api/conversations/:phone/send', ensureAuthenticated, async (req, res) => {
    try {
        const phoneKey = normalizePhoneKey(req.params.phone);
        if (!phoneKey) {
            return res.status(400).json({ success: false, message: 'Identificador de conversa inválido' });
        }

        const messageText = (req.body?.message || '').trim();
        if (!messageText) {
            return res.status(400).json({ success: false, message: 'Mensagem vazia' });
        }

        const status = whatsappService.getStatus();
        const session = await dbService.getConversationSession(phoneKey);
        const now = Date.now();
        const lastInbound = session.lastInboundAt ? session.lastInboundAt.getTime() : null;
        const inboundAgeMs = lastInbound ? now - lastInbound : null;
        const hasOpenWindow = inboundAgeMs !== null && inboundAgeMs <= 24 * 60 * 60 * 1000;

        if (status.mode === 'business' && !hasOpenWindow) {
            return res.status(409).json({
                success: false,
                code: 'session_expired',
                message: 'A janela de 24 horas expirou. Envie um template aprovado antes de responder manualmente.',
                session
            });
        }

        const phoneE164 = dbService.formatE164(phoneKey) || `+${phoneKey}`;
        if (!phoneE164 || phoneE164.length < 8) {
            return res.status(400).json({ success: false, message: 'Telefone inválido para envio' });
        }

        let appointment = null;
        try {
            appointment = await dbService.getLatestPendingAppointmentByPhone(phoneKey);
            if (!appointment) {
                appointment = await dbService.getLatestAppointmentFromLogsByPhone(phoneKey);
            }
        } catch (lookupErr) {
            console.log('⚠️  Falha ao localizar agendamento da conversa:', lookupErr.message);
        }

        const sendResult = await whatsappService.sendMessage(phoneE164, messageText);
        if (sendResult?.messageId) {
            try {
                await dbService.logOutboundMessage({
                    appointmentId: appointment?.id || null,
                    phone: phoneE164,
                    messageId: sendResult.messageId,
                    type: 'text',
                    templateName: null,
                    status: 'sent',
                    body: messageText,
                    direction: 'outbound_admin',
                    metadata: {
                        origin: 'admin_panel_reply',
                        phoneKey,
                        appointmentId: appointment?.id || null,
                        sessionWindowActive: hasOpenWindow,
                        mode: status.mode
                    }
                });
            } catch (logErr) {
                console.log('⚠️  Falha ao registrar envio manual:', logErr.message);
            }
        }

        const updatedSession = await dbService.getConversationSession(phoneKey);
        res.json({
            success: true,
            data: {
                messageId: sendResult?.messageId || null,
                appointmentId: appointment?.id || null,
                session: updatedSession
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err?.message || String(err) });
    }
});

module.exports = router;
