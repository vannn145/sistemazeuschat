const displayNameEl = document.getElementById('display-name');
const infoBox = document.getElementById('info-box');
const errorBox = document.getElementById('error-box');
const alertsSection = document.getElementById('alerts');
const statsTotalEl = document.getElementById('stat-total');
const statsConfirmedEl = document.getElementById('stat-confirmed');
const statsPendingEl = document.getElementById('stat-pending');
const generatedAtEl = document.getElementById('generated-at');
const logTotalEl = document.getElementById('log-total');
const logDeliveredEl = document.getElementById('log-delivered');
const logFailedEl = document.getElementById('log-failed');
const logTotalInlineEl = document.getElementById('log-total-inline');
const logDeliveredInlineEl = document.getElementById('log-delivered-inline');
const logFailedInlineEl = document.getElementById('log-failed-inline');
const logProgressDeliveredEl = document.getElementById('log-progress-delivered');
const logProgressFailedEl = document.getElementById('log-progress-failed');
const pendingListEl = document.getElementById('pending-list');
const templatesBodyEl = document.getElementById('templates-body');
const templatesMetaEl = document.getElementById('templates-meta');
const templateSelectEl = document.getElementById('template-select');
const testForm = document.getElementById('test-form');
const testFeedbackEl = document.getElementById('test-feedback');
const logoutButton = document.getElementById('logout-button');
const sectionTabs = document.querySelectorAll('[data-section-target]');
const sectionPanels = document.querySelectorAll('[data-section]');
const conversationRefreshButton = document.getElementById('conversation-refresh');
const conversationSearchForm = document.getElementById('conversation-search-form');
const conversationSearchInput = document.getElementById('conversation-search-input');
const conversationThreadListEl = document.getElementById('conversation-thread-list');
const conversationThreadPlaceholder = document.getElementById('conversation-thread-placeholder');
const conversationPlaceholder = document.getElementById('conversation-placeholder');
const conversationLoadingEl = document.getElementById('conversation-loading');
const conversationViewEl = document.getElementById('conversation-view');
const conversationTitleEl = document.getElementById('conversation-title');
const conversationSubtitleEl = document.getElementById('conversation-subtitle');
const conversationSessionInfoEl = document.getElementById('conversation-session-info');
const conversationMessagesEl = document.getElementById('conversation-messages');
const conversationForm = document.getElementById('conversation-form');
const conversationMessageInput = document.getElementById('conversation-message-input');
const conversationSendButton = document.getElementById('conversation-send-button');
const conversationReplyStatus = document.getElementById('conversation-reply-status');

const state = {
    templates: [],
    activeSection: 'overview',
    conversationsLoaded: false,
    conversations: [],
    conversationSearch: '',
    activeConversation: null,
    conversationMessages: [],
    conversationSession: null,
    conversationLoading: false,
    conversationSending: false,
    conversationReplyMessage: '',
    conversationReplyError: false
};

let conversationReplyTimeout = null;

const ownerBasePath = (() => {
    const segments = window.location.pathname.split('/').filter(Boolean);
    if (!segments.length || segments[0] !== 'owner') {
        return '/owner';
    }
    const tenant = segments[1];
    if (!tenant || tenant === 'login' || tenant === 'assets') {
        return '/owner';
    }
    return `/owner/${tenant}`;
})();

const ownerApiBase = `${ownerBasePath}/api`;

function hideMessages() {
    if (infoBox) {
        infoBox.hidden = true;
        infoBox.textContent = '';
    }
    if (errorBox) {
        errorBox.hidden = true;
        errorBox.textContent = '';
    }
    if (alertsSection) {
        alertsSection.hidden = true;
    }
}

function showInfo(message) {
    if (!infoBox) return;
    infoBox.textContent = message;
    infoBox.hidden = false;
    if (alertsSection) {
        alertsSection.hidden = false;
    }
}

function showError(message) {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
    if (alertsSection) {
        alertsSection.hidden = false;
    }
}

async function fetchJson(url, options) {
    const response = await fetch(url, options);
    let data = null;
    try {
        data = await response.json();
    } catch (_) {
        // ignorar parse error para resposta vazia
    }
    if (!response.ok) {
        const message = data?.message || data?.error || `Falha na requisição (${response.status})`;
        const error = new Error(message);
        error.details = data?.details;
        throw error;
    }
    return data;
}

function ensureAuthenticated(session) {
    if (!session?.authenticated) {
        window.location.href = `${ownerBasePath}/login`;
        return false;
    }
    if (displayNameEl && session.user?.displayName) {
        displayNameEl.textContent = `Olá, ${session.user.displayName}`;
    }
    return true;
}

function setActiveSection(section) {
    if (!section) {
        return;
    }
    state.activeSection = section;
    hideMessages();
    sectionTabs.forEach((tab) => {
        const target = tab.dataset.sectionTarget;
        if (target === section) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
    sectionPanels.forEach((panel) => {
        panel.hidden = panel.dataset.section !== section;
    });
    if (section === 'conversations' && !state.conversationsLoaded) {
        loadConversations().catch(() => {
            if (conversationThreadPlaceholder) {
                conversationThreadPlaceholder.textContent = 'Falha ao carregar conversas.';
                conversationThreadPlaceholder.hidden = false;
            }
        });
    }
}

function renderStats(stats, generatedAt) {
    if (!stats) {
        if (statsTotalEl) statsTotalEl.textContent = '--';
        if (statsConfirmedEl) statsConfirmedEl.textContent = '--';
        if (statsPendingEl) statsPendingEl.textContent = '--';
        return;
    }
    if (statsTotalEl) {
        statsTotalEl.textContent = stats.total ?? 0;
    }
    if (statsConfirmedEl) {
        statsConfirmedEl.textContent = stats.confirmed ?? 0;
    }
    if (statsPendingEl) {
        statsPendingEl.textContent = stats.pending ?? 0;
    }
    if (generatedAtEl && generatedAt) {
        const date = new Date(generatedAt);
        generatedAtEl.textContent = `Atualizado em ${date.toLocaleString('pt-BR')}`;
    }
}

function renderMessageLogs(summary) {
    if (!summary) {
        logTotalEl.textContent = '--';
        logDeliveredEl.textContent = '--';
        logFailedEl.textContent = '--';
        if (logTotalInlineEl) logTotalInlineEl.textContent = '--';
        if (logDeliveredInlineEl) logDeliveredInlineEl.textContent = '--';
        if (logFailedInlineEl) logFailedInlineEl.textContent = '--';
        updateLogProgress(0, 0, 0);
        return;
    }

    const typeEntries = Object.values(summary.types || {});
    const aggregatedTotal = typeEntries.reduce((acc, stats) => acc + Number(stats?.total || 0), 0);
    const total = aggregatedTotal || Number(summary.total ?? 0);
    const delivered = typeEntries.reduce((acc, stats) => {
        const statuses = stats?.statuses || {};
        return acc + Number(statuses.delivered || 0) + Number(statuses.read || 0);
    }, 0);
    const failed = typeEntries.reduce((acc, stats) => {
        const statuses = stats?.statuses || {};
        return acc
            + Number(statuses.failed || 0)
            + Number(statuses.error || 0)
            + Number(statuses.undelivered || 0);
    }, 0);

    logTotalEl.textContent = total;
    logDeliveredEl.textContent = delivered;
    logFailedEl.textContent = failed;
    if (logTotalInlineEl) logTotalInlineEl.textContent = total;
    if (logDeliveredInlineEl) logDeliveredInlineEl.textContent = delivered;
    if (logFailedInlineEl) logFailedInlineEl.textContent = failed;

    updateLogProgress(total, delivered, failed);
}

function updateLogProgress(total, delivered, failed) {
    if (!logProgressDeliveredEl || !logProgressFailedEl) {
        return;
    }
    const safeTotal = Number(total) > 0 ? Number(total) : 0;
    if (!safeTotal) {
        logProgressDeliveredEl.style.width = '0%';
        logProgressFailedEl.style.width = '0%';
        return;
    }

    const deliveredPercent = Math.min(100, Math.max(0, (Number(delivered) / safeTotal) * 100));
    const failedPercent = Math.min(100 - deliveredPercent, Math.max(0, (Number(failed) / safeTotal) * 100));

    logProgressDeliveredEl.style.width = `${deliveredPercent}%`;
    logProgressFailedEl.style.width = `${failedPercent}%`;
}

function formatDate(value) {
    if (!value) {
        return 'Sem data';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return 'Data inválida';
    }
    return date.toLocaleString('pt-BR', {
        dateStyle: 'short',
        timeStyle: 'short'
    });
}

function formatDateTimeShort(value) {
    if (!value) {
        return '—';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '—';
    }
    return date.toLocaleString('pt-BR', {
        dateStyle: 'short',
        timeStyle: 'short'
    });
}

function formatTimeOnly(value) {
    if (!value) {
        return '—';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '—';
    }
    return date.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit'
    });
}

function describeSession(session) {
    const result = {
        text: 'Sem registros recentes',
        className: '',
        activeWindow: false
    };
    if (!session) {
        return result;
    }
    const lastInbound = session.lastInboundAt ? new Date(session.lastInboundAt) : null;
    const lastOutbound = session.lastOutboundAt ? new Date(session.lastOutboundAt) : null;
    const lastMessage = session.lastMessageAt ? new Date(session.lastMessageAt) : null;
    const parts = [];
    if (lastInbound && !Number.isNaN(lastInbound.getTime())) {
        parts.push(`Última entrada ${formatDateTimeShort(lastInbound)}`);
    }
    if (lastOutbound && !Number.isNaN(lastOutbound.getTime())) {
        parts.push(`Última saída ${formatDateTimeShort(lastOutbound)}`);
    }
    if (!parts.length && lastMessage && !Number.isNaN(lastMessage.getTime())) {
        parts.push(`Última mensagem ${formatDateTimeShort(lastMessage)}`);
    }
    const inboundTime = lastInbound ? lastInbound.getTime() : null;
    const activeWindow = Number.isFinite(inboundTime) && (Date.now() - inboundTime <= 24 * 60 * 60 * 1000);
    result.activeWindow = Boolean(activeWindow);
    result.className = activeWindow ? 'active' : parts.length ? 'expired' : '';
    if (parts.length) {
        result.text = parts.join(' · ');
    }
    return result;
}

function renderPending(list) {
    if (!pendingListEl) {
        return;
    }
    pendingListEl.innerHTML = '';

    if (!Array.isArray(list) || list.length === 0) {
        const li = document.createElement('li');
        li.className = 'pending-empty meta';
        li.textContent = 'Nenhum paciente aguardando disparo no período monitorado.';
        pendingListEl.appendChild(li);
        return;
    }

    list.forEach((item) => {
        const li = document.createElement('li');
        li.className = 'pending-item';
        const name = item.patientName || 'Paciente sem nome';
        const when = formatDate(item.tratamentoIso);
        const procedure = item.procedure || 'Procedimento não informado';
        const contacts = Array.isArray(item.contacts) && item.contacts.length
            ? item.contacts.join(', ')
            : 'Contato não cadastrado';

        li.innerHTML = `
            <div class="pending-header">
                <strong>${name}</strong>
                <span class="badge">${procedure}</span>
            </div>
            <span class="meta">${when}</span>
            <span class="meta">Contatos: ${contacts}</span>
        `;
        pendingListEl.appendChild(li);
    });
}

function clearConversationView() {
    if (conversationTitleEl) conversationTitleEl.textContent = '';
    if (conversationSubtitleEl) conversationSubtitleEl.textContent = '';
    if (conversationSessionInfoEl) {
        conversationSessionInfoEl.textContent = '';
        conversationSessionInfoEl.classList.remove('active', 'expired');
    }
    if (conversationMessagesEl) conversationMessagesEl.innerHTML = '';
    if (conversationViewEl) conversationViewEl.hidden = true;
    if (conversationLoadingEl) {
        conversationLoadingEl.hidden = true;
        conversationLoadingEl.textContent = 'Carregando mensagens...';
    }
    if (conversationPlaceholder) {
        conversationPlaceholder.textContent = 'Selecione uma conversa para visualizar as mensagens.';
        conversationPlaceholder.hidden = false;
    }
    if (conversationForm) {
        conversationForm.hidden = true;
    }
    if (conversationMessageInput) {
        conversationMessageInput.value = '';
        conversationMessageInput.disabled = true;
    }
    if (conversationSendButton) {
        conversationSendButton.disabled = true;
    }
    if (conversationReplyStatus) {
        conversationReplyStatus.textContent = '';
        conversationReplyStatus.classList.remove('warning');
    }
    state.conversationReplyMessage = '';
    state.conversationSending = false;
    state.conversationReplyError = false;
    if (conversationReplyTimeout) {
        clearTimeout(conversationReplyTimeout);
        conversationReplyTimeout = null;
    }
}

function renderConversationThreads() {
    if (!conversationThreadListEl) {
        return;
    }
    conversationThreadListEl.innerHTML = '';
    const items = Array.isArray(state.conversations) ? state.conversations : [];
    if (!items.length) {
        if (conversationThreadPlaceholder) {
            conversationThreadPlaceholder.textContent = state.conversationsLoaded
                ? 'Nenhuma conversa encontrada.'
                : 'Carregando conversas...';
            conversationThreadPlaceholder.hidden = false;
        }
        return;
    }
    if (conversationThreadPlaceholder) {
        conversationThreadPlaceholder.hidden = true;
    }
    items.forEach((thread) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'conversation-thread-item';
        if (state.activeConversation && state.activeConversation.phoneKey === thread.phoneKey) {
            button.classList.add('active');
        }

        const titleEl = document.createElement('h5');
        titleEl.textContent = thread.patientName || thread.phoneDisplay || thread.phoneKey || 'Conversa';
        button.appendChild(titleEl);

        const previewEl = document.createElement('div');
        previewEl.className = 'thread-preview';
        const previewText = thread.lastMessage?.body || '[Sem mensagem registrada]';
        previewEl.textContent = previewText;
        button.appendChild(previewEl);

        const metaEl = document.createElement('div');
        metaEl.className = 'thread-meta';
        const timeSpan = document.createElement('span');
        timeSpan.textContent = thread.lastTimestamp ? formatDateTimeShort(thread.lastTimestamp) : 'Sem histórico';
        metaEl.appendChild(timeSpan);
        const countSpan = document.createElement('span');
        countSpan.textContent = `In/Out 48h: ${Number(thread.inboundCount48h || 0)}/${Number(thread.outboundCount48h || 0)}`;
        if (thread.needsResponse) {
            countSpan.textContent += ' · aguardando resposta';
        }
        metaEl.appendChild(countSpan);
        button.appendChild(metaEl);

        button.addEventListener('click', () => {
            selectConversation(thread);
        });

        conversationThreadListEl.appendChild(button);
    });
}

function renderConversationView() {
    const thread = state.activeConversation;
    if (!thread) {
        clearConversationView();
        return;
    }
    if (conversationPlaceholder) {
        conversationPlaceholder.hidden = true;
    }
    if (conversationLoadingEl) {
        conversationLoadingEl.hidden = state.conversationLoading ? false : true;
        conversationLoadingEl.textContent = 'Carregando mensagens...';
    }
    if (state.conversationLoading) {
        if (conversationViewEl) {
            conversationViewEl.hidden = true;
        }
        updateConversationFormState();
        return;
    }
    if (conversationViewEl) {
        conversationViewEl.hidden = false;
    }
    if (conversationTitleEl) {
        conversationTitleEl.textContent = thread.patientName || thread.phoneDisplay || thread.phoneKey || 'Conversa';
    }
    if (conversationSubtitleEl) {
        const parts = [];
        if (thread.phoneDisplay) parts.push(thread.phoneDisplay);
        if (thread.mainProcedureTerm) parts.push(thread.mainProcedureTerm);
        conversationSubtitleEl.textContent = parts.join(' · ');
    }
    const sessionInfo = describeSession(state.conversationSession);
    if (conversationSessionInfoEl) {
        conversationSessionInfoEl.textContent = sessionInfo.text;
        conversationSessionInfoEl.classList.remove('active', 'expired');
        if (sessionInfo.className) {
            conversationSessionInfoEl.classList.add(sessionInfo.className);
        }
    }
    if (!conversationMessagesEl) {
        updateConversationFormState(sessionInfo);
        return;
    }
    conversationMessagesEl.innerHTML = '';
    const messages = Array.isArray(state.conversationMessages) ? state.conversationMessages : [];
    if (!messages.length) {
        const empty = document.createElement('div');
        empty.className = 'meta';
        empty.textContent = 'Nenhuma mensagem registrada para esta conversa.';
        conversationMessagesEl.appendChild(empty);
        return;
    }
    messages.forEach((message) => {
        const wrapper = document.createElement('div');
        const direction = String(message.direction || '').toLowerCase();
        wrapper.className = `conversation-message ${direction.startsWith('inbound') ? 'inbound' : 'outbound'}`;

        const bubble = document.createElement('div');
        bubble.className = 'conversation-bubble';

        const textEl = document.createElement('p');
        textEl.textContent = message.body || (message.type ? `[${message.type}]` : '[sem conteúdo]');
        bubble.appendChild(textEl);

        const metaEl = document.createElement('div');
        metaEl.className = 'conversation-meta';
        const timestamp = message.timestamp || message.updatedAt || message.createdAt || null;
        const timeSpan = document.createElement('span');
        timeSpan.textContent = formatDateTimeShort(timestamp);
        metaEl.appendChild(timeSpan);
        if (message.status) {
            const statusSpan = document.createElement('span');
            statusSpan.textContent = message.status;
            metaEl.appendChild(statusSpan);
        }
        if (message.direction && !direction.startsWith('inbound') && !direction.startsWith('outbound')) {
            const dirSpan = document.createElement('span');
            dirSpan.textContent = message.direction;
            metaEl.appendChild(dirSpan);
        }
        bubble.appendChild(metaEl);
        wrapper.appendChild(bubble);
        conversationMessagesEl.appendChild(wrapper);
    });
    conversationMessagesEl.scrollTop = conversationMessagesEl.scrollHeight;
    updateConversationFormState(sessionInfo);
}

function updateConversationFormState(sessionInfo) {
    if (!conversationForm) {
        return;
    }
    const hasConversation = Boolean(state.activeConversation);
    conversationForm.hidden = !hasConversation;
    if (!hasConversation) {
        if (conversationMessageInput) {
            conversationMessageInput.value = '';
            conversationMessageInput.disabled = true;
        }
        if (conversationSendButton) {
            conversationSendButton.disabled = true;
        }
        if (conversationReplyStatus) {
            conversationReplyStatus.textContent = '';
            conversationReplyStatus.classList.remove('warning');
        }
        return;
    }

    const info = sessionInfo || describeSession(state.conversationSession);
    if (conversationMessageInput) {
        conversationMessageInput.disabled = state.conversationSending;
        if (!state.conversationSending) {
            conversationMessageInput.focus();
        }
    }
    const textValue = conversationMessageInput?.value?.trim() || '';
    if (conversationSendButton) {
        conversationSendButton.disabled = state.conversationSending || !textValue;
    }
    if (conversationReplyStatus) {
        const hasHistory = Array.isArray(state.conversationMessages) && state.conversationMessages.length > 0;
        const defaultMessage = info.activeWindow
            ? 'Envie uma resposta para o paciente.'
            : hasHistory
                ? 'Janela de 24h expirada; tente um template antes de responder.'
                : 'Converse com o paciente para iniciar o atendimento.';
        conversationReplyStatus.textContent = state.conversationReplyMessage || defaultMessage;
        const showWarning = state.conversationReplyError || (!info.activeWindow && hasHistory && !state.conversationReplyMessage);
        conversationReplyStatus.classList.toggle('warning', showWarning);
    }
}

async function loadConversationMessages(phoneKey) {
    if (!phoneKey) {
        clearConversationView();
        return;
    }
    state.conversationLoading = true;
    renderConversationView();
    try {
        const params = new URLSearchParams();
        params.set('limit', '120');
        const query = params.toString();
        const url = query
            ? `${ownerApiBase}/conversations/${phoneKey}/messages?${query}`
            : `${ownerApiBase}/conversations/${phoneKey}/messages`;
        const response = await fetchJson(url);
        const data = response?.data || {};
        state.conversationMessages = Array.isArray(data.messages) ? data.messages : [];
        state.conversationSession = data.session || null;
        state.conversationLoading = false;
        renderConversationView();
    } catch (error) {
        state.conversationLoading = false;
        renderConversationView();
        if (conversationPlaceholder) {
            conversationPlaceholder.textContent = error.message || 'Falha ao carregar mensagens.';
            conversationPlaceholder.hidden = false;
        }
        if (conversationViewEl) {
            conversationViewEl.hidden = true;
        }
    }
}

async function loadConversations(searchTerm) {
    if (!conversationThreadListEl) {
        return;
    }
    const term = typeof searchTerm === 'string' ? searchTerm.trim() : state.conversationSearch;
    state.conversationSearch = term;
    if (conversationThreadPlaceholder) {
        conversationThreadPlaceholder.textContent = 'Carregando conversas...';
        conversationThreadPlaceholder.hidden = false;
    }
    conversationThreadListEl.innerHTML = '';
    const params = new URLSearchParams();
    params.set('limit', '60');
    if (term) {
        params.set('search', term);
    }
    const query = params.toString();
    const url = query ? `${ownerApiBase}/conversations?${query}` : `${ownerApiBase}/conversations`;
    try {
        const response = await fetchJson(url);
        const data = Array.isArray(response?.data) ? response.data : [];
        state.conversations = data;
        state.conversationsLoaded = true;
        if (state.activeConversation) {
            const refreshed = data.find((item) => item.phoneKey === state.activeConversation.phoneKey);
            if (refreshed) {
                state.activeConversation = refreshed;
            } else {
                state.activeConversation = null;
                state.conversationMessages = [];
                state.conversationSession = null;
                clearConversationView();
            }
        }
        renderConversationThreads();
        if (!state.activeConversation && data.length && state.activeSection === 'conversations') {
            selectConversation(data[0]);
        } else if (state.activeConversation) {
            renderConversationView();
        }
    } catch (error) {
        state.conversations = [];
        state.conversationsLoaded = true;
        if (conversationThreadPlaceholder) {
            conversationThreadPlaceholder.textContent = error.message || 'Falha ao carregar conversas.';
            conversationThreadPlaceholder.hidden = false;
        }
        clearConversationView();
    }
}

function selectConversation(thread) {
    if (!thread) {
        state.activeConversation = null;
        state.conversationMessages = [];
        state.conversationSession = null;
        state.conversationReplyMessage = '';
        state.conversationReplyError = false;
        if (conversationMessageInput) {
            conversationMessageInput.value = '';
        }
        clearConversationView();
        renderConversationThreads();
        return;
    }
    state.activeConversation = thread;
    state.conversationMessages = [];
    state.conversationSession = null;
    state.conversationReplyMessage = '';
    state.conversationReplyError = false;
    if (conversationMessageInput) {
        conversationMessageInput.value = '';
    }
    renderConversationThreads();
    loadConversationMessages(thread.phoneKey).catch(() => {
        if (conversationPlaceholder) {
            conversationPlaceholder.textContent = 'Falha ao carregar mensagens.';
            conversationPlaceholder.hidden = false;
        }
    });
}

async function sendConversationMessage(event) {
    event.preventDefault();
    if (!state.activeConversation || state.conversationSending) {
        return;
    }
    const text = conversationMessageInput?.value?.trim() || '';
    if (!text) {
        state.conversationReplyMessage = 'Digite uma mensagem antes de enviar.';
        state.conversationReplyError = true;
        updateConversationFormState();
        return;
    }

    state.conversationSending = true;
    state.conversationReplyMessage = '';
    state.conversationReplyError = false;
    if (conversationReplyTimeout) {
        clearTimeout(conversationReplyTimeout);
        conversationReplyTimeout = null;
    }
    updateConversationFormState();

    const phoneKey = state.activeConversation.phoneKey;
    try {
        await fetchJson(`${ownerApiBase}/conversations/${phoneKey}/send`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ message: text })
        });
        if (conversationMessageInput) {
            conversationMessageInput.value = '';
        }
        state.conversationReplyMessage = 'Mensagem enviada.';
        state.conversationReplyError = false;
        updateConversationFormState();
        conversationReplyTimeout = setTimeout(() => {
            state.conversationReplyMessage = '';
            state.conversationReplyError = false;
            updateConversationFormState();
            conversationReplyTimeout = null;
        }, 4000);
        await loadConversationMessages(phoneKey);
        loadConversations(state.conversationSearch).catch(() => {});
    } catch (error) {
        state.conversationReplyMessage = error.message || 'Falha ao enviar mensagem.';
        state.conversationReplyError = true;
        updateConversationFormState();
    } finally {
        state.conversationSending = false;
        updateConversationFormState();
    }
}

function renderTemplates(payload) {
    if (!templatesBodyEl || !templateSelectEl) {
        return;
    }

    templatesBodyEl.innerHTML = '';
    templateSelectEl.innerHTML = '';

    const templates = Array.isArray(payload?.templates) ? payload.templates : [];
    state.templates = templates;

    templateSelectEl.disabled = templates.length === 0;

    if (templates.length === 0) {
        templatesMetaEl.textContent = 'Nenhum template recuperado. Verifique se o modo Business está ativo.';
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Templates indisponíveis';
        templateSelectEl.appendChild(option);
        return;
    }

    templatesMetaEl.textContent = `${templates.length} template(s) encontrados.`;

    templates.forEach((tpl) => {
        const option = document.createElement('option');
        option.value = tpl.name || '';
        option.textContent = tpl.name || '(sem nome)';
        templateSelectEl.appendChild(option);

        const tr = document.createElement('tr');
        const updated = tpl.last_updated_time ? formatDate(tpl.last_updated_time) : '—';
        tr.innerHTML = `
            <td>${tpl.name || '—'}</td>
            <td>${tpl.language || '—'}</td>
            <td>${tpl.category || '—'}</td>
            <td>${tpl.status || '—'}</td>
            <td>${updated}</td>
        `;
        templatesBodyEl.appendChild(tr);
    });
}

async function loadSession() {
    const session = await fetchJson(`${ownerApiBase}/session`);
    ensureAuthenticated(session);
}

async function loadOverview() {
    const response = await fetchJson(`${ownerApiBase}/overview`);
    if (!response?.success) {
        throw new Error('Não foi possível carregar o resumo.');
    }
    if (response.data) {
        renderStats(response.data.stats, response.data.generatedAt);
        renderMessageLogs(response.data.messageLogsToday);
        renderPending(response.data.pendingAppointments);
    }
    return response.data;
}

async function loadTemplates() {
    try {
        const response = await fetchJson(`${ownerApiBase}/templates`);
        if (!response?.success) {
            throw new Error('Resposta inválida do servidor ao listar templates.');
        }
        renderTemplates(response.data);
    } catch (error) {
        showInfo(error.message || 'Templates indisponíveis no momento.');
        templatesMetaEl.textContent = 'Não foi possível carregar templates.';
        if (templateSelectEl) {
            templateSelectEl.disabled = true;
            templateSelectEl.innerHTML = '';
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'Templates indisponíveis';
            templateSelectEl.appendChild(option);
        }
    }
}

async function handleTestSubmit(event) {
    event.preventDefault();
    if (!testForm) {
        return;
    }
    if (!templateSelectEl || !templateSelectEl.value) {
        testFeedbackEl.textContent = 'Selecione um template disponível antes de enviar o teste.';
        return;
    }
    const submitButton = testForm.querySelector('button[type="submit"]');
    if (submitButton) {
        submitButton.disabled = true;
    }
    testFeedbackEl.textContent = 'Enviando template...';

    const parametersRaw = document.getElementById('test-parameters')?.value || '';
    const parameters = parametersRaw
        ? parametersRaw.split('|').map((item) => item.trim()).filter(Boolean)
        : [];

    const payload = {
        templateName: templateSelectEl?.value || '',
        phone: document.getElementById('test-phone')?.value || '',
        languageCode: document.getElementById('test-language')?.value || 'pt_BR',
        parameters,
        scheduleId: document.getElementById('test-schedule')?.value || null,
        includeConfirmButtons: document.getElementById('test-buttons')?.checked !== false
    };

    try {
        const response = await fetchJson(`${ownerApiBase}/templates/test-send`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        if (!response?.success) {
            throw new Error(response?.message || 'Falha no envio');
        }
        testFeedbackEl.textContent = 'Template enviado com sucesso. Confira o WhatsApp do destinatário.';
    } catch (error) {
        testFeedbackEl.textContent = error.message || 'Erro ao enviar template.';
    } finally {
        if (submitButton) {
            submitButton.disabled = false;
        }
    }
}

async function handleLogout() {
    try {
        await fetchJson(`${ownerApiBase}/logout`, { method: 'POST' });
    } catch (_) {
        // mesmo em caso de erro, redireciona para login
    } finally {
        window.location.href = `${ownerBasePath}/login`;
    }
}

(async function bootstrap() {
    try {
        await loadSession();
        hideMessages();
        const overview = await loadOverview();
        const warnings = [];
        if (overview?.statsError) {
            warnings.push(`Estatísticas: ${overview.statsError}`);
        }
        if (overview?.messageLogsError) {
            warnings.push(`Logs do dia: ${overview.messageLogsError}`);
        }
        if (overview?.pendingError) {
            warnings.push(`Pendentes: ${overview.pendingError}`);
        }
        if (warnings.length) {
            showInfo(`Alguns dados podem estar incompletos: ${warnings.join(' | ')}`);
        }
        await loadTemplates();
        if (state.activeSection !== 'conversations') {
            loadConversations(state.conversationSearch).catch(() => {});
        }
    } catch (error) {
        showError(error.message || 'Falha ao carregar painel.');
    }
})();

clearConversationView();

if (sectionTabs.length) {
    sectionTabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.sectionTarget;
            if (target && target !== state.activeSection) {
                setActiveSection(target);
            }
        });
    });
    setActiveSection(state.activeSection);
}

if (conversationSearchForm) {
    conversationSearchForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const term = conversationSearchInput?.value?.trim() || '';
        loadConversations(term).catch((error) => {
            showError(error.message || 'Falha ao buscar conversas.');
        });
    });
}

if (conversationSearchInput) {
    conversationSearchInput.addEventListener('input', () => {
        if (!conversationSearchInput.value && state.conversationSearch) {
            loadConversations('').catch(() => {});
        }
    });
}

if (conversationRefreshButton) {
    conversationRefreshButton.addEventListener('click', () => {
        loadConversations(state.conversationSearch).catch((error) => {
            showError(error.message || 'Falha ao atualizar conversas.');
        });
    });
}

if (conversationMessageInput) {
    conversationMessageInput.addEventListener('input', () => {
        state.conversationReplyMessage = '';
        state.conversationReplyError = false;
        if (conversationReplyTimeout) {
            clearTimeout(conversationReplyTimeout);
            conversationReplyTimeout = null;
        }
        updateConversationFormState();
    });
}

if (conversationForm) {
    conversationForm.addEventListener('submit', sendConversationMessage);
}

if (testForm) {
    testForm.addEventListener('submit', handleTestSubmit);
}

if (logoutButton) {
    logoutButton.addEventListener('click', handleLogout);
}
