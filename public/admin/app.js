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
    } else if (normalized.includes('cancel')) {
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

function summarizeWebhook(entry) {
    const metadata = entry?.payload?.entry || entry?.payload?.messages;
    if (Array.isArray(metadata) && metadata.length > 0) {
        return JSON.stringify(metadata[0]).slice(0, 120) + '…';
    }
    return entry?.payload ? JSON.stringify(entry.payload).slice(0, 120) + '…' : 'Evento recebido';
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
        return `
            <tr>
                <td>${formatDate(event.createdAt)}</td>
                <td>${event.type || 'webhook'}</td>
                <td class="muted">${summarizeWebhook(event)}</td>
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

refreshAll();
