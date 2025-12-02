const express = require('express');
const path = require('path');
const router = express.Router();
const dbService = require('../services/database');
const cronService = require('../services/cron');
const retryCronService = require('../services/retry-cron');
const reminderCronService = require('../services/reminder-cron');
const activityLog = require('../services/activity-log');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const ADMIN_DISPLAY_NAME = process.env.ADMIN_DISPLAY_NAME || 'Zeus Chat';
const ADMIN_UI_DIR = path.join(__dirname, '../../public/admin');
const DASHBOARD_HTML = path.join(ADMIN_UI_DIR, 'index.html');
const LOGIN_HTML = path.join(ADMIN_UI_DIR, 'login.html');

function ensureAuthenticated(req, res, next) {
    if (req?.session?.isAdmin) {
        return next();
    }
    return res.status(401).json({ success: false, message: 'Não autenticado' });
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
        res.status(500).json({ success: false, message: err?.message || String(err) });
    }
});

router.get('/api/webhook-events', ensureAuthenticated, (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 200);
    const type = (req.query.type || '').trim() || null;
    const events = activityLog.getRecentEvents({ limit, type });
    res.json({ success: true, data: events });
});

module.exports = router;
