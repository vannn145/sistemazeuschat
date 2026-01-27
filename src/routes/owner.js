const express = require('express');
const path = require('path');

const dbService = require('../services/database');
const cronService = require('../services/cron');
const retryCronService = require('../services/retry-cron');
const reminderCronService = require('../services/reminder-cron');
const whatsappHybrid = require('../services/whatsapp-hybrid');

const OWNER_UI_DIR = path.join(__dirname, '../../public/owner');
const DASHBOARD_HTML = path.join(OWNER_UI_DIR, 'index.html');
const LOGIN_HTML = path.join(OWNER_UI_DIR, 'login.html');

const TENANT_CONFIGS = {
    default: {
        key: 'default',
        basePath: '/owner',
        displayFallback: 'Diretoria',
        env: {
            user: 'OWNER_USER',
            pass: 'OWNER_PASS',
            display: 'OWNER_DISPLAY_NAME'
        },
        defaults: {
            user: 'dir',
            pass: 'dir123',
            display: 'Diretoria'
        },
        dataMode: 'primary',
        templatesEnabled: true
    },
    haertel: {
        key: 'haertel',
        basePath: '/owner/haertel',
        displayFallback: 'Diretoria Haertel',
        env: {
            user: 'HAERTEL_OWNER_USER',
            pass: 'HAERTEL_OWNER_PASS',
            display: 'HAERTEL_OWNER_DISPLAY_NAME'
        },
        defaults: {
            user: 'haertel',
            pass: 'haertel123',
            display: 'Diretoria Haertel'
        },
        dataMode: 'placeholder',
        templatesEnabled: false
    }
};

function resolveTenant(key = 'default') {
    return TENANT_CONFIGS[key] || TENANT_CONFIGS.default;
}

function normalizePhoneKey(raw) {
    return String(raw || '').replace(/\D/g, '');
}

function ensureTenantState(req) {
    if (!req.session) {
        return { flags: {}, users: {} };
    }
    if (!req.session.ownerTenants) {
        req.session.ownerTenants = {};
    }
    if (!req.session.ownerUsers) {
        req.session.ownerUsers = {};
    }
    return {
        flags: req.session.ownerTenants,
        users: req.session.ownerUsers
    };
}

function isTenantAuthenticated(req, tenant) {
    if (!req?.session) {
        return false;
    }
    const flags = req.session.ownerTenants;
    if (flags && flags[tenant.key]) {
        return true;
    }
    if (tenant.key === 'default' && req.session.isOwner) {
        ensureTenantState(req).flags[tenant.key] = true;
        if (req.session.ownerUser) {
            req.session.ownerUsers[tenant.key] = req.session.ownerUser;
        }
        return true;
    }
    return false;
}

function markTenantAuthenticated(req, tenant, username, enabled) {
    if (!req?.session) {
        return;
    }
    const { flags, users } = ensureTenantState(req);
    if (enabled) {
        flags[tenant.key] = true;
        users[tenant.key] = username || null;
        if (tenant.key === 'default') {
            req.session.isOwner = true;
            req.session.ownerUser = username || null;
        }
    } else {
        delete flags[tenant.key];
        delete users[tenant.key];
        if (tenant.key === 'default') {
            req.session.isOwner = false;
            req.session.ownerUser = null;
        }
    }
}

function getTenantDisplayName(tenant) {
    return process.env[tenant.env.display] || tenant.defaults?.display || tenant.displayFallback;
}

function getTenantCredentials(tenant) {
    return {
        user: process.env[tenant.env.user] || tenant.defaults?.user || '',
        pass: process.env[tenant.env.pass] || tenant.defaults?.pass || ''
    };
}

function getStoredTenantUsername(req, tenant, fallback) {
    if (!req?.session) {
        return fallback || null;
    }
    if (req.session.ownerUsers && req.session.ownerUsers[tenant.key]) {
        return req.session.ownerUsers[tenant.key];
    }
    if (tenant.key === 'default' && req.session.ownerUser) {
        return req.session.ownerUser;
    }
    return fallback || null;
}

function buildPlaceholderOverview(nowIso) {
    return {
        generatedAt: nowIso,
        stats: { total: 0, confirmed: 0, pending: 0 },
        messageLogsToday: {
            total: 0,
            types: {
                template: {
                    total: 0,
                    statuses: {}
                }
            }
        },
        pendingAppointments: [],
        cron: {
            primary: null,
            retry: null,
            reminder: null
        }
    };
}

function createOwnerRouter(tenantKey = 'default') {
    const tenant = resolveTenant(tenantKey);
    const router = express.Router();
    const credentials = getTenantCredentials(tenant);
    const displayName = getTenantDisplayName(tenant);

    const ensureAuthenticated = (req, res, next) => {
        if (isTenantAuthenticated(req, tenant)) {
            return next();
        }
        return res.status(401).json({ success: false, message: 'Não autenticado' });
    };

    router.get('/', (req, res) => {
        if (isTenantAuthenticated(req, tenant)) {
            return res.sendFile(DASHBOARD_HTML);
        }
        return res.sendFile(LOGIN_HTML);
    });

    router.get('/login', (req, res) => {
        if (isTenantAuthenticated(req, tenant)) {
            return res.redirect(tenant.basePath);
        }
        return res.sendFile(LOGIN_HTML);
    });

    router.post('/api/login', (req, res) => {
        const username = (req.body?.username || '').trim();
        const password = req.body?.password || '';

        if (!credentials.user || !credentials.pass) {
            return res.status(500).json({ success: false, message: 'Credenciais de diretoria não configuradas' });
        }

        if (username === credentials.user && password === credentials.pass) {
            markTenantAuthenticated(req, tenant, username, true);
            return res.json({ success: true, displayName, redirect: tenant.basePath });
        }

        return res.status(401).json({ success: false, message: 'Usuário ou senha inválidos' });
    });

    router.post('/api/logout', ensureAuthenticated, (req, res) => {
        markTenantAuthenticated(req, tenant, null, false);
        req.session.save((err) => {
            if (err) {
                return res.status(500).json({ success: false, message: 'Falha ao encerrar sessão' });
            }
            return res.json({ success: true });
        });
    });

    router.get('/api/session', (req, res) => {
        const authenticated = isTenantAuthenticated(req, tenant);
        res.json({
            success: true,
            authenticated,
            user: authenticated ? {
                username: getStoredTenantUsername(req, tenant, credentials.user),
                displayName,
                tenant: tenant.key
            } : null
        });
    });

    router.get('/api/overview', ensureAuthenticated, async (req, res) => {
        const now = new Date();
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);
        const tomorrowStart = new Date(todayStart);
        tomorrowStart.setDate(todayStart.getDate() + 1);

        if (tenant.dataMode !== 'primary') {
            return res.json({ success: true, data: buildPlaceholderOverview(now.toISOString()) });
        }

        const payload = {
            generatedAt: now.toISOString(),
            stats: null,
            messageLogsToday: null,
            pendingAppointments: null,
            cron: {
                primary: cronService.getStatus?.() || null,
                retry: retryCronService.getStatus?.() || null,
                reminder: reminderCronService.getStatus?.() || null
            }
        };

        try {
            payload.stats = await dbService.getAppointmentStats();
        } catch (error) {
            payload.statsError = error?.message || String(error);
        }

        try {
            payload.messageLogsToday = await dbService.getMessageLogStats({
                startDate: todayStart,
                endDate: tomorrowStart
            });
        } catch (error) {
            payload.messageLogsError = error?.message || String(error);
        }

        try {
            const pending = await dbService.getPendingInWindowNoTemplate(1, 7, 12);
            payload.pendingAppointments = pending.map((appointment) => {
                const contacts = parseContacts(appointment?.patient_contacts);
                const formattedContacts = contacts.map((contact) => dbService.formatE164(contact) || contact);
                return {
                    id: appointment.id || null,
                    patientName: appointment.patient_name || null,
                    procedure: appointment.main_procedure_term || null,
                    confirmed: Boolean(appointment.confirmed),
                    tratamentoIso: normalizeIso(appointment.tratamento_date),
                    scheduleEpoch: appointment.schedule_epoch || appointment.when || null,
                    contacts: formattedContacts
                };
            });
        } catch (error) {
            payload.pendingAppointments = [];
            payload.pendingError = error?.message || String(error);
        }

        return res.json({ success: true, data: payload });
    });

    router.get('/api/templates', ensureAuthenticated, async (req, res) => {
        if (!tenant.templatesEnabled) {
            return res.json({ success: true, data: { templates: [], paging: null } });
        }

        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const status = (req.query.status || '').trim();
        const search = (req.query.search || '').trim();

        try {
            const result = await whatsappHybrid.listTemplates({ limit, status, search });
            res.json({ success: true, data: result });
        } catch (error) {
            res.status(400).json({
                success: false,
                error: error?.message || 'Falha ao listar templates',
                details: error?.original || null
            });
        }
    });

    router.post('/api/templates/test-send', ensureAuthenticated, async (req, res) => {
        if (!tenant.templatesEnabled) {
            return res.status(400).json({ success: false, message: 'Envio de templates não disponível para este cliente.' });
        }

        const templateName = (req.body?.templateName || '').trim();
        const phone = (req.body?.phone || '').trim();
        const languageCode = (req.body?.languageCode || '').trim() || 'pt_BR';
        const parameters = Array.isArray(req.body?.parameters)
            ? req.body.parameters
            : (typeof req.body?.parameters === 'string'
                ? req.body.parameters.split('|').map((item) => item.trim()).filter(Boolean)
                : []);
        const scheduleId = req.body?.scheduleId || null;
        const includeConfirmButtons = req.body?.includeConfirmButtons !== false;

        if (!templateName || !phone) {
            return res.status(400).json({ success: false, message: 'Informe template e telefone para o teste' });
        }

        const bodyParameters = parameters.map((value) => ({
            type: 'text',
            text: String(value ?? '')
        }));

        const components = bodyParameters.length
            ? [{ type: 'body', parameters: bodyParameters }]
            : [];

        try {
            const result = await whatsappHybrid.sendTemplateMessage(
                phone,
                templateName,
                languageCode,
                components,
                {
                    includeConfirmButtons,
                    scheduleId: scheduleId || undefined
                }
            );
            res.json({ success: true, data: result });
        } catch (error) {
            res.status(400).json({
                success: false,
                error: error?.message || 'Falha ao enviar template',
                details: error?.response?.data || error?.original || null
            });
        }
    });
    router.get('/api/conversations', ensureAuthenticated, async (req, res) => {
        if (tenant.dataMode !== 'primary') {
            return res.json({ success: true, data: [] });
        }

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
        if (tenant.dataMode !== 'primary') {
            return res.json({ success: true, data: { phoneKey: null, messages: [], session: null } });
        }

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
        if (tenant.dataMode !== 'primary') {
            return res.json({ success: true, data: null });
        }

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
        if (tenant.dataMode !== 'primary') {
            return res.status(400).json({ success: false, message: 'Envio de mensagens não disponível para este cliente.' });
        }

        try {
            const phoneKey = normalizePhoneKey(req.params.phone);
            if (!phoneKey) {
                return res.status(400).json({ success: false, message: 'Identificador de conversa inválido' });
            }

            const messageText = (req.body?.message || '').trim();
            if (!messageText) {
                return res.status(400).json({ success: false, message: 'Mensagem vazia' });
            }

            const status = typeof whatsappHybrid.getStatus === 'function' ? whatsappHybrid.getStatus() : { mode: 'web' };
            const session = await dbService.getConversationSession(phoneKey);
            const lastInbound = session?.lastInboundAt instanceof Date
                ? session.lastInboundAt.getTime()
                : (session?.lastInboundAt ? new Date(session.lastInboundAt).getTime() : null);
            const hasOpenWindow = Number.isFinite(lastInbound) && (Date.now() - lastInbound <= 24 * 60 * 60 * 1000);

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
                console.log('⚠️  Falha ao localizar agendamento (owner):', lookupErr.message);
            }

            const sendResult = await whatsappHybrid.sendMessage(phoneE164, messageText);
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
                        direction: 'outbound_owner',
                        metadata: {
                            origin: 'owner_panel_reply',
                            phoneKey,
                            appointmentId: appointment?.id || null,
                            sessionWindowActive: hasOpenWindow,
                            mode: status.mode
                        }
                    });
                } catch (logErr) {
                    console.log('⚠️  Falha ao registrar envio manual (owner):', logErr.message);
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

    return router;
}

function normalizeIso(value) {
    if (!value) {
        return null;
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseContacts(raw) {
    if (!raw) {
        return [];
    }
    if (Array.isArray(raw)) {
        return raw.filter(Boolean);
    }
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) {
            return [];
        }
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed.filter(Boolean);
            }
        } catch (_) {
            // ignorar erro de parse e continuar com split
        }
        return trimmed.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
    }
    return [];
}

module.exports = {
    createOwnerRouter,
    tenantConfigs: TENANT_CONFIGS
};