'use strict';

const refreshButton = document.getElementById('refreshButton');
const logoutButton = document.getElementById('logoutButton');
const logsTableBody = document.getElementById('logsTableBody');
const webhookTableBody = document.getElementById('webhookTableBody');
const cronStatusContainer = document.getElementById('cronStatus');
const footerStamp = document.getElementById('footerStamp');
const logsTypeFilter = document.getElementById('logsTypeFilter');
const logsStatusFilter = document.getElementById('logsStatusFilter');

const AUTO_REFRESH_MS = 30000;
let autoRefreshTimer = null;

const conversationListEl = document.getElementById('conversationList');
const conversationMessagesEl = document.getElementById('conversationMessages');
const conversationTitleEl = document.getElementById('conversationTitle');
const conversationSessionInfoEl = document.getElementById('conversationSessionInfo');
const conversationForm = document.getElementById('conversationForm');
const conversationInput = document.getElementById('conversationInput');
const conversationSendButton = document.getElementById('conversationSendButton');
const conversationRefreshButton = document.getElementById('conversationRefreshButton');
const conversationSearchInput = document.getElementById('conversationSearch');

const conversationState = {
    list: [],
    activeKey: null,
    messages: [],
    session: null,
    loadingList: false,
    loadingMessages: false,
    autoRefreshTimer: null,
    searchTerm: ''
};

let conversationSearchTimer = null;

function formatDate(value) {
    if (!value) {
        return '--';
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '--';
    }
    return date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

async function fetchJSON(url, options = {}) {
    const response = await fetch(url, {
        credentials: 'include',
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    if (response.status === 401) {
        window.location.href = '/admin/login';
        return null;
    }
    if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Erro HTTP ${response.status}`);
    }
    return response.json();
}

function setCardValue(selector, value) {
    const element = document.querySelector(`[data-field="${selector}"]`);
    if (element) {
        element.textContent = value;
    }
}

function renderOverview(data) {
    if (!data) {
        return;
    }
    const stats = data.stats || { total: 0, confirmed: 0, pending: 0 };
    setCardValue('stats.total', stats.total ?? '--');
    setCardValue('stats.confirmed', stats.confirmed ?? '--');
    setCardValue('stats.pending', stats.pending ?? '--');

    const logs = data.messageLogsToday || { total: 0, types: {} };
    const templateStats = logs.types?.template || { total: 0, statuses: {} };
    const reminderStats = logs.types?.reminder || { total: 0, statuses: {} };
    const sentTotal = (templateStats.statuses?.sent || 0) + (reminderStats.statuses?.sent || 0);
    const failedTotal = (templateStats.statuses?.failed || 0) + (reminderStats.statuses?.failed || 0);
    setCardValue('logs.sent', sentTotal);
    setCardValue('logs.details', `Templates: ${templateStats.total || 0} · Lembretes: ${reminderStats.total || 0}`);
    setCardValue('logs.failed', failedTotal);
    setCardValue('logs.failedDetails', failedTotal ? 'Verifique retentativas' : 'Nenhuma falha hoje');

    footerStamp.textContent = `Atualizado em ${formatDate(data.generatedAt)}`;

    renderCronStatus(data.cron || {});
}

function renderCronStatus(cron) {
    cronStatusContainer.innerHTML = '';
    const entries = [
        { key: 'primary', label: 'Envio diário', data: cron.primary },
        { key: 'retry', label: 'Retentativa', data: cron.retry },
        { key: 'reminder', label: 'Lembrete', data: cron.reminder }
    ];

    entries.forEach(({ label, data }) => {
        const card = document.createElement('article');
        card.className = 'cron-card';
        const enabled = data?.enabled ? 'Ativo' : 'Parado';
        const running = data?.running ? 'Executando' : 'Aguardando';
        const lastRun = data?.lastRun ? formatDate(data.lastRun) : 'Nunca';
        const lastResult = data?.lastResult?.error ? `Erro: ${data.lastResult.error}` : data?.lastResult?.reason || 'Pronto';
        card.innerHTML = `
            <h4>${label}</h4>
            <div class="cron-meta">
                <div><strong>Status:</strong> ${enabled} · ${running}</div>
                <div><strong>Última execução:</strong> ${lastRun}</div>
                <div><strong>Resultado:</strong> ${lastResult}</div>
                <div><strong>Intervalo:</strong> ${(data?.intervalMs || 0) / 1000}s</div>
            </div>
        `;
        cronStatusContainer.appendChild(card);
    });
}

function buildStatusBadge(status) {
    const normalized = (status || 'desconhecido').toLowerCase();
    let className = 'status-default';
    if (normalized === 'sent' || normalized === 'delivered') {
        className = 'status-sent';
    } else if (normalized === 'failed' || normalized === 'error') {
        className = 'status-failed';
    } else if (normalized === 'retrying') {
        className = 'status-retrying';
    } else if (normalized.includes('confirm')) {
        className = 'status-sent';
    } else if (normalized.includes('cancel') || normalized.includes('desmarc')) {
        className = 'status-warning';
    }
    return `<span class="status-badge ${className}">${status || '—'}</span>`;
}

function renderLogs(logs, errorMessage = null) {
    if (errorMessage) {
        logsTableBody.innerHTML = `<tr><td colspan="6">Falha ao carregar logs: ${errorMessage}</td></tr>`;
        return;
    }
    if (!Array.isArray(logs) || logs.length === 0) {
        logsTableBody.innerHTML = '<tr><td colspan="6">Nenhum registro encontrado.</td></tr>';
        return;
    }
    logsTableBody.innerHTML = logs.map((log) => {
        const createdAt = log.created_at || log.updated_at || null;
        const patient = log.patient_name || '—';
        const procedure = log.main_procedure_term || '—';
        const phone = log.phone || '—';
        const type = log.type || '—';
        const statusBadge = buildStatusBadge(log.status);
        return `
            <tr>
                <td>${formatDate(createdAt)}</td>
                <td>${type}</td>
                <td>${statusBadge}</td>
                <td>${patient}</td>
                <td>${procedure}</td>
                <td>${phone}</td>
            </tr>
        `;
    }).join('');
}

function renderWebhook(events, errorMessage = null) {
    if (errorMessage) {
        webhookTableBody.innerHTML = `<tr><td colspan="3">Falha ao carregar eventos: ${errorMessage}</td></tr>`;
        return;
    }
    if (!Array.isArray(events) || events.length === 0) {
        webhookTableBody.innerHTML = '<tr><td colspan="3">Nenhum webhook registrado.</td></tr>';
        return;
    }
    webhookTableBody.innerHTML = events.map((event) => {
        const timestamp = event.timestamp || event.createdAt;
        const badge = buildStatusBadge(event.status);
        return `
            <tr>
                <td>${formatDate(timestamp)}</td>
                <td>${event.phone || '—'}</td>
                <td>${badge}</td>
            </tr>
        `;
    }).join('');
}

async function loadOverview() {
    const result = await fetchJSON('/admin/api/overview');
    renderOverview(result?.data);
}

async function loadLogs() {
    const params = new URLSearchParams();
    const type = logsTypeFilter?.value || 'all';
    const status = logsStatusFilter?.value || '';
    params.set('limit', '40');
    if (type && type !== 'all') {
        params.set('type', type);
    }
    if (status) {
        params.set('status', status);
    }
    const result = await fetchJSON(`/admin/api/message-logs?${params.toString()}`);
    if (result?.success === false) {
        renderLogs([], result?.error || 'Desconhecido');
        return;
    }
    renderLogs(result?.data || []);
}

async function loadWebhooks() {
    const result = await fetchJSON('/admin/api/webhook-events?limit=30');
    if (result?.success === false) {
        renderWebhook([], result?.error || 'Desconhecido');
        return;
    }
    renderWebhook(result?.data || []);
}

function formatPhoneDisplay(value) {
    if (!value) {
        return '--';
    }
    const digits = String(value).replace(/\D/g, '');
    if (digits.startsWith('55') && digits.length >= 12) {
        const local = digits.slice(2);
        const area = local.slice(0, 2);
        const body = local.slice(2);
        if (body.length === 9) {
            return `(${area}) ${body.slice(0, 5)}-${body.slice(5)}`;
        }
        if (body.length === 8) {
            return `(${area}) ${body.slice(0, 4)}-${body.slice(4)}`;
        }
        return `(${area}) ${body}`;
    }
    if (digits.length >= 11) {
        return `${digits.slice(0, digits.length - 4)}-${digits.slice(-4)}`;
    }
    return value;
}

function formatRelativeTime(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return '--';
    }
    const diffMs = Date.now() - date.getTime();
    if (diffMs < 60_000) {
        return 'agora';
    }
    if (diffMs < 3_600_000) {
        return `${Math.floor(diffMs / 60_000)}m`;
    }
    if (diffMs < 86_400_000) {
        return `${Math.floor(diffMs / 3_600_000)}h`;
    }
    return `${Math.floor(diffMs / 86_400_000)}d`;
}

function formatTimeShort(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return '--';
    }
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function normalizeThreadData(raw) {
    if (!raw) {
        return null;
    }
    const parseDate = (value) => {
        if (!value) {
            return null;
        }
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    };
    return {
        ...raw,
        lastTimestamp: parseDate(raw.lastTimestamp),
        lastInboundAt: parseDate(raw.lastInboundAt),
        lastOutboundAt: parseDate(raw.lastOutboundAt),
        lastMessage: raw.lastMessage ? {
            ...raw.lastMessage,
            timestamp: parseDate(raw.lastMessage.timestamp)
        } : null
    };
}

function normalizeMessageData(raw) {
    if (!raw) {
        return null;
    }
    const parseDate = (value) => {
        if (!value) {
            return null;
        }
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    };
    return {
        ...raw,
        createdAt: parseDate(raw.createdAt),
        updatedAt: parseDate(raw.updatedAt),
        timestamp: parseDate(raw.timestamp)
    };
}

function normalizeSessionData(raw) {
    if (!raw) {
        return null;
    }
    const parseDate = (value) => {
        if (!value) {
            return null;
        }
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    };
    return {
        phoneKey: raw.phoneKey || null,
        lastInboundAt: parseDate(raw.lastInboundAt),
        lastOutboundAt: parseDate(raw.lastOutboundAt),
        lastMessageAt: parseDate(raw.lastMessageAt)
    };
}

function updateConversationHeader(thread) {
    if (!conversationTitleEl) {
        return;
    }
    if (!thread) {
        conversationTitleEl.textContent = 'Selecione uma conversa';
        if (conversationSessionInfoEl) {
            conversationSessionInfoEl.textContent = '';
            conversationSessionInfoEl.classList.remove('active', 'expired');
        }
        updateConversationFormState(false);
        return;
    }
    conversationTitleEl.textContent = thread.patientName || formatPhoneDisplay(thread.phoneDisplay || thread.phoneKey);
    if (conversationSessionInfoEl) {
        conversationSessionInfoEl.textContent = '';
        conversationSessionInfoEl.classList.remove('active', 'expired');
    }
    updateConversationFormState(true);
}

function renderConversationSession(session) {
    if (!conversationSessionInfoEl) {
        return;
    }
    conversationSessionInfoEl.classList.remove('active', 'expired');
    if (!session || !(session.lastInboundAt instanceof Date) || Number.isNaN(session.lastInboundAt.getTime())) {
        conversationSessionInfoEl.textContent = 'Sem mensagens recebidas nas últimas 24h.';
        return;
    }
    const ageMs = Date.now() - session.lastInboundAt.getTime();
    const withinWindow = ageMs <= 24 * 60 * 60 * 1000;
    const relative = formatRelativeTime(session.lastInboundAt);
    conversationSessionInfoEl.textContent = withinWindow
        ? `Janela ativa · ${relative}`
        : `Janela expirada · última interação há ${relative}`;
    conversationSessionInfoEl.classList.add(withinWindow ? 'active' : 'expired');
}

function renderConversationThreads(threads) {
    if (!conversationListEl) {
        return;
    }
    if (!Array.isArray(threads) || threads.length === 0) {
        conversationListEl.innerHTML = '<div class="chat-empty">Nenhuma conversa recente.</div>';
        return;
    }
    conversationListEl.innerHTML = '';
    threads.forEach((thread) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'chat-thread-item';
        if (thread.phoneKey === conversationState.activeKey) {
            item.classList.add('active');
        }
        item.dataset.phoneKey = thread.phoneKey;

        const header = document.createElement('div');
        header.className = 'chat-thread-row';

        const nameEl = document.createElement('span');
        nameEl.className = 'chat-thread-name';
        nameEl.textContent = thread.patientName || formatPhoneDisplay(thread.phoneDisplay || thread.phoneKey);
        header.appendChild(nameEl);

        const timeEl = document.createElement('time');
        timeEl.className = 'chat-thread-time';
        if (thread.lastTimestamp instanceof Date && !Number.isNaN(thread.lastTimestamp.getTime())) {
            timeEl.textContent = formatRelativeTime(thread.lastTimestamp);
            timeEl.title = formatDate(thread.lastTimestamp);
        } else {
            timeEl.textContent = '--';
        }
        header.appendChild(timeEl);
        item.appendChild(header);

        const preview = document.createElement('div');
        preview.className = 'chat-thread-preview';
        const previewSource = thread.lastMessage?.body || thread.lastMessage?.status || 'Sem mensagens';
        preview.textContent = previewSource;
        item.appendChild(preview);

        const meta = document.createElement('div');
        meta.className = 'chat-thread-meta';
        const withinWindow = thread.lastInboundAt instanceof Date && (Date.now() - thread.lastInboundAt.getTime()) <= 24 * 60 * 60 * 1000;
        const sessionBadge = document.createElement('span');
        sessionBadge.className = 'chat-thread-session';
        sessionBadge.textContent = withinWindow ? 'Janela ativa' : 'Janela expirada';
        meta.appendChild(sessionBadge);
        if (thread.needsResponse) {
            const badge = document.createElement('span');
            badge.className = 'chat-thread-badge';
            badge.textContent = 'Pendente';
            meta.appendChild(badge);
        }
        item.appendChild(meta);

        item.addEventListener('click', () => setActiveConversation(thread.phoneKey));
        conversationListEl.appendChild(item);
    });
}

function renderConversationMessages(messages) {
    if (!conversationMessagesEl) {
        return;
    }
    conversationMessagesEl.innerHTML = '';
    if (!Array.isArray(messages) || messages.length === 0) {
        const placeholder = document.createElement('div');
        placeholder.className = 'chat-placeholder';
        placeholder.textContent = 'Nenhuma mensagem registrada para esta conversa.';
        conversationMessagesEl.appendChild(placeholder);
        return;
    }
    messages.forEach((message) => {
        const direction = String(message.direction || '').startsWith('inbound') ? 'inbound' : 'outbound';
        const wrapper = document.createElement('div');
        wrapper.className = `chat-message ${direction}`;

        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';

        const bodyEl = document.createElement('div');
        bodyEl.className = 'chat-body';
        bodyEl.textContent = message.body || message.status || '[sem conteúdo]';
        bubble.appendChild(bodyEl);

        const meta = document.createElement('div');
        meta.className = 'chat-meta';
        const timeSpan = document.createElement('span');
        if (message.timestamp instanceof Date && !Number.isNaN(message.timestamp.getTime())) {
            timeSpan.textContent = formatTimeShort(message.timestamp);
            timeSpan.title = formatDate(message.timestamp);
        } else {
            timeSpan.textContent = '--';
        }
        meta.appendChild(timeSpan);

        if (message.status && !['sent', 'received'].includes(message.status)) {
            const statusSpan = document.createElement('span');
            statusSpan.className = 'chat-status';
            statusSpan.textContent = message.status;
            meta.appendChild(statusSpan);
        }

        if (message.type && message.type !== 'text') {
            const typeSpan = document.createElement('span');
            typeSpan.className = 'chat-status subtle';
            typeSpan.textContent = message.type;
            meta.appendChild(typeSpan);
        }

        bubble.appendChild(meta);
        wrapper.appendChild(bubble);
        conversationMessagesEl.appendChild(wrapper);
    });
    scrollConversationToBottom(true);
}

function scrollConversationToBottom(smooth = false) {
    if (!conversationMessagesEl) {
        return;
    }
    conversationMessagesEl.scrollTo({
        top: conversationMessagesEl.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto'
    });
}

function updateConversationFormState(enabled) {
    if (!conversationForm || !conversationInput || !conversationSendButton) {
        return;
    }
    conversationForm.classList.toggle('disabled', !enabled);
    conversationInput.disabled = !enabled;
    conversationSendButton.disabled = !enabled;
    if (!enabled) {
        conversationInput.value = '';
    }
}

function scheduleConversationAutoRefresh() {
    if (conversationState.autoRefreshTimer) {
        clearInterval(conversationState.autoRefreshTimer);
        conversationState.autoRefreshTimer = null;
    }
    if (!conversationState.activeKey) {
        return;
    }
    conversationState.autoRefreshTimer = setInterval(() => {
        loadConversationMessages(conversationState.activeKey, { silent: true }).catch((err) => {
            console.error('Falha ao atualizar conversa automaticamente:', err);
        });
    }, 15000);
}

async function loadConversationThreads(options = {}) {
    if (!conversationListEl) {
        return;
    }
    if (conversationState.loadingList && options.silent) {
        return;
    }
    conversationState.loadingList = true;
    if (!options.silent) {
        conversationListEl.innerHTML = '<div class="chat-empty">Carregando conversas...</div>';
    }
    try {
        const params = new URLSearchParams({ limit: '40' });
        if (conversationState.searchTerm) {
            params.set('search', conversationState.searchTerm);
        }
        const result = await fetchJSON(`/admin/api/conversations?${params.toString()}`);
        const threads = (result?.data || []).map(normalizeThreadData);
        conversationState.list = threads;
        renderConversationThreads(threads);
        if (conversationState.activeKey) {
            const active = threads.find((thread) => thread.phoneKey === conversationState.activeKey) || null;
            updateConversationHeader(active);
        }
    } catch (err) {
        console.error('Falha ao carregar conversas:', err);
        if (!options.silent) {
            conversationListEl.innerHTML = `<div class="chat-empty">Erro ao carregar conversas: ${err?.message || 'desconhecido'}</div>`;
        }
    } finally {
        conversationState.loadingList = false;
    }
}

async function loadConversationMessages(phoneKey, options = {}) {
    if (!conversationMessagesEl || !phoneKey) {
        return;
    }
    if (conversationState.loadingMessages && !options.force) {
        return;
    }
    conversationState.loadingMessages = true;
    if (!options.silent) {
        conversationMessagesEl.innerHTML = '<div class="chat-placeholder">Carregando mensagens...</div>';
    }
    try {
        const params = new URLSearchParams({ limit: '120' });
        const result = await fetchJSON(`/admin/api/conversations/${phoneKey}/messages?${params.toString()}`);
        const messages = (result?.data?.messages || []).map(normalizeMessageData);
        const session = normalizeSessionData(result?.data?.session);
        conversationState.messages = messages;
        conversationState.session = session;
        renderConversationMessages(messages);
        renderConversationSession(session);
        scheduleConversationAutoRefresh();
    } catch (err) {
        console.error('Falha ao carregar conversa:', err);
        if (!options.silent) {
            conversationMessagesEl.innerHTML = `<div class="chat-placeholder">Erro ao carregar mensagens: ${err?.message || 'desconhecido'}</div>`;
        }
    } finally {
        conversationState.loadingMessages = false;
    }
}

function setActiveConversation(phoneKey) {
    if (!conversationListEl || !phoneKey || conversationState.activeKey === phoneKey) {
        return;
    }
    conversationState.activeKey = phoneKey;
    conversationListEl.querySelectorAll('.chat-thread-item').forEach((item) => {
        item.classList.toggle('active', item.dataset.phoneKey === phoneKey);
    });
    const activeThread = conversationState.list.find((thread) => thread.phoneKey === phoneKey) || null;
    updateConversationHeader(activeThread);
    conversationMessagesEl.innerHTML = '<div class="chat-placeholder">Carregando mensagens...</div>';
    loadConversationMessages(phoneKey).catch((err) => {
        console.error('Falha ao carregar mensagens:', err);
    });
}

async function handleConversationSend(event) {
    if (event) {
        event.preventDefault();
    }
    if (!conversationState.activeKey || !conversationInput || !conversationSendButton) {
        return;
    }
    const messageText = conversationInput.value.trim();
    if (!messageText) {
        conversationInput.focus();
        return;
    }
    conversationSendButton.disabled = true;
    const previousLabel = conversationSendButton.textContent;
    conversationSendButton.textContent = 'Enviando...';

    try {
        const response = await fetch(`/admin/api/conversations/${conversationState.activeKey}/send`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ message: messageText })
        });

        let payload = null;
        if (!response.ok) {
            let errorMessage = 'Falha ao enviar mensagem.';
            try {
                payload = await response.json();
                errorMessage = payload?.message || errorMessage;
            } catch (_) {
                const fallback = await response.text();
                if (fallback) {
                    errorMessage = fallback;
                }
            }
            if (payload?.session) {
                conversationState.session = normalizeSessionData(payload.session);
                renderConversationSession(conversationState.session);
            }
            throw new Error(errorMessage);
        }

        payload = await response.json();
        conversationInput.value = '';

        if (payload?.data?.session) {
            conversationState.session = normalizeSessionData(payload.data.session);
        }

        await loadConversationMessages(conversationState.activeKey, { force: true, silent: true });
        await loadConversationThreads({ silent: true });
        if (conversationState.session) {
            renderConversationSession(conversationState.session);
        }
    } catch (err) {
        console.error('Envio manual falhou:', err);
        window.alert(err?.message || 'Falha ao enviar mensagem.');
    } finally {
        conversationSendButton.disabled = false;
        conversationSendButton.textContent = previousLabel;
    }
}

async function refreshAll() {
    await loadOverview().catch((err) => {
        console.error('Falha ao atualizar visão geral:', err);
    });
    await loadLogs().catch((err) => {
        console.error('Falha ao carregar logs:', err);
        renderLogs([], err?.message || 'Erro desconhecido');
    });
    await loadWebhooks().catch((err) => {
        console.error('Falha ao carregar webhooks:', err);
    });
    if (conversationListEl) {
        await loadConversationThreads({ silent: true }).catch((err) => {
            console.error('Falha ao atualizar conversas:', err);
        });
        if (conversationState.activeKey) {
            await loadConversationMessages(conversationState.activeKey, { silent: true }).catch((err) => {
                console.error('Falha ao atualizar conversa ativa:', err);
            });
        }
    }
    if (autoRefreshTimer) {
        clearTimeout(autoRefreshTimer);
    }
    autoRefreshTimer = setTimeout(refreshAll, AUTO_REFRESH_MS);
}

async function handleLogout() {
    try {
        await fetchJSON('/admin/api/logout', { method: 'POST', body: JSON.stringify({}) });
    } catch (_) {
        // ignore
    }
    window.location.href = '/admin/login';
}

if (refreshButton) {
    refreshButton.addEventListener('click', refreshAll);
}

if (logoutButton) {
    logoutButton.addEventListener('click', handleLogout);
}

if (logsTypeFilter) {
    logsTypeFilter.addEventListener('change', loadLogs);
}

if (logsStatusFilter) {
    logsStatusFilter.addEventListener('change', loadLogs);
}

if (conversationRefreshButton) {
    conversationRefreshButton.addEventListener('click', () => {
        loadConversationThreads().catch((err) => {
            console.error('Falha ao atualizar conversas manualmente:', err);
        });
    });
}

if (conversationForm) {
    conversationForm.addEventListener('submit', handleConversationSend);
}

if (conversationSearchInput) {
    conversationSearchInput.addEventListener('input', (event) => {
        const value = event.target.value || '';
        clearTimeout(conversationSearchTimer);
        conversationSearchTimer = setTimeout(() => {
            conversationState.searchTerm = value.trim();
            loadConversationThreads({ silent: true }).catch((err) => {
                console.error('Falha ao aplicar filtro de conversas:', err);
            });
        }, 350);
    });
}

if (conversationListEl) {
    loadConversationThreads().catch((err) => {
        console.error('Falha ao carregar conversas:', err);
    });
}

refreshAll();
