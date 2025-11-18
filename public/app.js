// Função para enviar log ao backend
async function sendPatientLog(log) {
    try {
        await fetch('/api/messages/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(log)
        });
    } catch (e) {
        console.error('Erro ao enviar log:', e);
    }
}

// Exemplo: enviar log ao disparar mensagem
// Chame sendPatientLog({ appointmentId, phone, messageId, type, templateName, status }) após disparo

async function renderPatientLogs() {
    const container = document.getElementById('logs-container');
    container.innerHTML = '<small class="text-muted">Carregando...</small>';
    try {
        // Corrige o prefixo da API para funcionar em produção e dev
        const res = await fetch(window.location.origin + '/api/messages/logs');
        const data = await res.json();
        if (data.success && Array.isArray(data.data)) {
            if (data.data.length === 0) {
                container.innerHTML = '<small class="text-muted">Nenhum log encontrado.</small>';
                return;
            }
            container.innerHTML = `<ul class="list-group">
                ${data.data.map(log => `<li class="list-group-item">
                    <strong>${log.phone}</strong> <span class="badge bg-info">${log.type}</span><br>
                    <span class="text-muted">${log.message}</span><br>
                    <small>${new Date(log.created_at).toLocaleString('pt-BR')}</small>
                </li>`).join('')}
            </ul>`;
        } else {
            container.innerHTML = '<small class="text-danger">Erro ao carregar logs.</small>';
        }
    } catch (e) {
        container.innerHTML = '<small class="text-danger">Erro ao carregar logs.</small>';
    }
}

// Atualiza logs a cada 15 segundos
setInterval(renderPatientLogs, 15000);
document.addEventListener('DOMContentLoaded', renderPatientLogs);
// Estado da aplicação
let whatsappConnected = false;
let selectedAppointments = new Set();
let appointments = [];
let currentFilterDate = '';
let statusesMap = {}; // appointmentId -> { status, updated_at }

// Elementos DOM
const connectBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const whatsappStatus = document.getElementById('whatsapp-status');
const currentModeSpan = document.getElementById('current-mode');
const modeSelector = document.getElementById('mode-selector');
const qrContainer = document.getElementById('qr-container');
const qrImage = document.getElementById('qr-image');
const appointmentsContainer = document.getElementById('appointments-container');
const statsContainer = document.getElementById('stats-container');
const sendBulkBtn = document.getElementById('send-bulk-btn');
const selectedCount = document.getElementById('selected-count');
const customMessage = document.getElementById('custom-message');
const useTemplateCheckbox = document.getElementById('use-template');
const refreshBtn = document.getElementById('refresh-btn');
const selectAllBtn = document.getElementById('select-all-btn');
const testMessageBtn = document.getElementById('test-message-btn');
// On-Prem elements
let onpremRequestBtn, onpremVerifyBtn, onpremCC, onpremPhone, onpremMethod, onpremCert, onpremCode, onpremPin;

// Event Listeners
connectBtn.addEventListener('click', connectWhatsApp);
disconnectBtn.addEventListener('click', disconnectWhatsApp);
modeSelector.addEventListener('change', switchWhatsAppMode);
sendBulkBtn.addEventListener('click', sendBulkMessages);
refreshBtn.addEventListener('click', loadData);
selectAllBtn.addEventListener('click', toggleSelectAll);
testMessageBtn.addEventListener('click', () => {
    new bootstrap.Modal(document.getElementById('testModal')).show();
});

document.getElementById('send-test-btn').addEventListener('click', sendTestMessage);

// Inicialização
document.addEventListener('DOMContentLoaded', function() {
    // Filtro de data (default: amanhã)
    const filterDateInput = document.getElementById('filter-date');
    const applyFilterBtn = document.getElementById('apply-filter-btn');
    if (filterDateInput) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const yyyy = tomorrow.getFullYear();
        const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
        const dd = String(tomorrow.getDate()).padStart(2, '0');
        if (!filterDateInput.value) {
            filterDateInput.value = `${yyyy}-${mm}-${dd}`;
        }
        currentFilterDate = filterDateInput.value || '';
        if (applyFilterBtn) {
            applyFilterBtn.addEventListener('click', () => {
                currentFilterDate = filterDateInput.value || '';
                loadAppointments();
            });
        }
    }

    loadData();
    checkWhatsAppStatus();
    // Verificar status a cada 5 segundos
    setInterval(checkWhatsAppStatus, 5000);

    // Atualizar status das mensagens a cada 10 segundos
    setInterval(loadStatuses, 10000);

    // Atualiza confirmações recentes a cada 10 segundos para visão quase em tempo real
    setInterval(renderRecentConfirmations, 10000);

    // Bind On-Prem elements (rendered in DOM now)
    onpremRequestBtn = document.getElementById('onprem-request-btn');
    onpremVerifyBtn  = document.getElementById('onprem-verify-btn');
    onpremCC         = document.getElementById('onprem-cc');
    onpremPhone      = document.getElementById('onprem-phone');
    onpremMethod     = document.getElementById('onprem-method');
    onpremCert       = document.getElementById('onprem-cert');
    onpremCode       = document.getElementById('onprem-code');
    onpremPin        = document.getElementById('onprem-pin');
    
    if (onpremRequestBtn) onpremRequestBtn.addEventListener('click', requestOnPremCode);
    if (onpremVerifyBtn)  onpremVerifyBtn.addEventListener('click', verifyOnPremCode);
});

// Funções de API
async function apiCall(endpoint, options = {}) {
    try {
        const response = await fetch(`/api/messages${endpoint}`, {
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            },
            ...options
        });
        // Ler como texto e tentar parsear JSON para evitar "Unexpected token" em erros HTML
        const text = await response.text();
        let data;
        try {
            data = text ? JSON.parse(text) : {};
        } catch (_) {
            data = { success: false, message: text || 'Erro inesperado' };
        }

        if (!response.ok || data.success === false) {
            const msg = data.message || `Erro ${response.status}`;
            throw new Error(`${msg} (em ${endpoint})`);
        }

        return data;
    } catch (error) {
        console.error('Erro na API:', error);
        showAlert(error.message, 'danger');
        throw error;
    }
}

// WhatsApp Functions
async function connectWhatsApp() {
    connectBtn.disabled = true;
    connectBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Conectando...';
    
    try {
        const result = await apiCall('/whatsapp/connect', { method: 'POST' });
        showAlert(result.message, 'success');
        checkWhatsAppStatus();
    } catch (error) {
        connectBtn.disabled = false;
        connectBtn.innerHTML = '<i class="fas fa-plug"></i> Conectar';
    }
}

async function disconnectWhatsApp() {
    try {
        const result = await apiCall('/whatsapp/disconnect', { method: 'POST' });
        showAlert(result.message, 'info');
        checkWhatsAppStatus();
    } catch (error) {
        // Error already handled in apiCall
    }
}

async function switchWhatsAppMode() {
    const newMode = modeSelector.value;
    
    try {
        const result = await apiCall('/whatsapp/mode', {
            method: 'POST',
            body: JSON.stringify({ mode: newMode })
        });
        
        showAlert(result.message, 'success');
        currentModeSpan.textContent = newMode === 'business' ? 'Business API' : 'Web';
        checkWhatsAppStatus();
    } catch (error) {
        // Reverter seleção em caso de erro
        modeSelector.value = modeSelector.value === 'business' ? 'web' : 'business';
    }
}

async function checkWhatsAppStatus() {
    try {
        const status = await apiCall('/whatsapp/status');
        
        whatsappConnected = status.isConnected || status.isConfigured;
        
        // Atualizar modo na interface
        if (status.mode) {
            modeSelector.value = status.mode;
            currentModeSpan.textContent = status.mode === 'business' ? 'Business API' : 'Web';
        }
        
        // Atualizar UI baseado no modo
        if (status.mode === 'business') {
            // Modo Business API
            if (status.isConfigured) {
                whatsappStatus.innerHTML = '<span class="status-connected"><i class="fas fa-circle"></i> Business API Ativo</span>';
                connectBtn.disabled = true;
                disconnectBtn.disabled = false;
                sendBulkBtn.disabled = selectedAppointments.size === 0;
                qrContainer.style.display = 'none';
            } else {
                whatsappStatus.innerHTML = '<span class="status-disconnected"><i class="fas fa-circle"></i> Business API - Configure credenciais</span>';
                connectBtn.disabled = false;
                disconnectBtn.disabled = true;
                sendBulkBtn.disabled = true;
                qrContainer.style.display = 'none';
            }
        } else {
            // Modo Web (original)
            if (status.isConnected) {
                whatsappStatus.innerHTML = '<span class="status-connected"><i class="fas fa-circle"></i> WhatsApp Web Conectado</span>';
                connectBtn.disabled = true;
                disconnectBtn.disabled = false;
                sendBulkBtn.disabled = selectedAppointments.size === 0;
                qrContainer.style.display = 'none';
            } else if (status.hasQRCode && status.qrCode) {
                whatsappStatus.innerHTML = '<span class="status-waiting"><i class="fas fa-circle"></i> Aguardando QR Code</span>';
                qrImage.src = status.qrCode;
                qrContainer.style.display = 'block';
                connectBtn.disabled = true;
                disconnectBtn.disabled = false;
                sendBulkBtn.disabled = true;
            } else {
                whatsappStatus.innerHTML = '<span class="status-disconnected"><i class="fas fa-circle"></i> WhatsApp Web Desconectado</span>';
                connectBtn.disabled = false;
                disconnectBtn.disabled = true;
                sendBulkBtn.disabled = true;
                qrContainer.style.display = 'none';
            }
        }
        
        connectBtn.innerHTML = '<i class="fas fa-plug"></i> Conectar';
        
    } catch (error) {
        whatsappStatus.innerHTML = '<span class="status-disconnected"><i class="fas fa-circle"></i> Erro</span>';
    }
}

// Data Loading Functions
async function loadData() {
    showLoading(true);
    try {
        await Promise.all([
            loadAppointments(),
            loadStats()
        ]);
    } catch (error) {
        // Errors handled in individual functions
    } finally {
        showLoading(false);
    }
}

async function loadAppointments() {
    try {
        let endpoint = '/appointments/pending';
        if (currentFilterDate) {
            endpoint += `?date=${encodeURIComponent(currentFilterDate)}`;
        }
        const result = await apiCall(endpoint);
        appointments = result.data;
        renderAppointments();
        // Após carregar a lista, buscar status
        await loadStatuses();
    } catch (error) {
        appointmentsContainer.innerHTML = '<p class="text-danger">Erro ao carregar agendamentos</p>';
    }
}

async function loadStatuses() {
    try {
        if (!appointments || appointments.length === 0) return;
        const ids = appointments.map(a => a.id);
        const result = await apiCall('/appointments/status/batch', {
            method: 'POST',
            body: JSON.stringify({ appointmentIds: ids })
        });
        statusesMap = result.data || {};
        // Re-renderiza apenas os badges
        updateStatusBadges();
    } catch (e) {
        // silencioso
    }
}

async function loadStats() {
    try {
        const result = await apiCall('/appointments/stats');
        const stats = result.data;
        
        statsContainer.innerHTML = `
            <div class="small">
                <div class="text-muted mb-1">Janela: últimos 30 dias</div>
                <div><strong>Total:</strong> ${stats.total}</div>
                <div><strong>Confirmados:</strong> ${stats.confirmed}</div>
                <div class="text-warning"><strong>Pendentes:</strong> ${stats.pending}</div>
            </div>
        `;
    } catch (error) {
        statsContainer.innerHTML = '<small class="text-danger">Erro ao carregar</small>';
    }
}

// Render Functions
function renderAppointments() {
    if (appointments.length === 0) {
        appointmentsContainer.innerHTML = '<p class="text-muted">Nenhum agendamento pendente encontrado.</p>';
        return;
    }
    
    const html = appointments.map(appointment => {
        const date = new Date(appointment.tratamento_date);
        const formattedDate = date.toLocaleDateString('pt-BR');
        const formattedTime = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const isSelected = selectedAppointments.has(appointment.id);
        
        const statusInfo = statusesMap[appointment.id];
        const statusBadge = renderStatusBadge(statusInfo?.status);
        return `
            <div class="appointment-card card mb-2">
                <div class="card-body p-3">
                    <div class="row align-items-center">
                        <div class="col-md-1">
                            <input type="checkbox" class="form-check-input appointment-checkbox" 
                                value="${appointment.id}" ${isSelected ? 'checked' : ''}>
                        </div>
                        <div class="col-md-3">
                            <strong>${appointment.patient_name}</strong><br>
                            <small class="text-muted">${appointment.patient_contacts}</small>
                        </div>
                        <div class="col-md-3">
                            <i class="fas fa-calendar"></i> ${formattedDate}<br>
                            <i class="fas fa-clock"></i> ${formattedTime}
                        </div>
                        <div class="col-md-3">
                            <small class="text-muted">${appointment.main_procedure_term}</small>
                        </div>
                        <div class="col-md-2 text-end">
                            <span class="message-status" data-apt-id="${appointment.id}">${statusBadge}</span>
                            <button class="btn btn-outline-primary btn-sm" 
                                onclick="sendSingleMessage(${appointment.id})">
                                <i class="fas fa-paper-plane"></i>
                            </button>
                            <button class="btn btn-outline-success btn-sm" 
                                onclick="confirmAppointment(${appointment.id})">
                                <i class="fas fa-check"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    appointmentsContainer.innerHTML = html;
    
    // Adicionar event listeners para checkboxes
    document.querySelectorAll('.appointment-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', handleCheckboxChange);
    });
    
    updateSelectedCount();
}

// Event Handlers
function handleCheckboxChange(event) {
    const appointmentId = parseInt(event.target.value);
    
    if (event.target.checked) {
        selectedAppointments.add(appointmentId);
    } else {
        selectedAppointments.delete(appointmentId);
    }
    
    updateSelectedCount();
}

function updateSelectedCount() {
    selectedCount.textContent = `(${selectedAppointments.size})`;
    sendBulkBtn.disabled = !whatsappConnected || selectedAppointments.size === 0;
    
    // Atualizar texto do botão de selecionar todos
    const allSelected = selectedAppointments.size === appointments.length && appointments.length > 0;
    selectAllBtn.innerHTML = allSelected 
        ? '<i class="fas fa-square"></i> Desmarcar Todos'
        : '<i class="fas fa-check-square"></i> Selecionar Todos';
}

function toggleSelectAll() {
    const allSelected = selectedAppointments.size === appointments.length && appointments.length > 0;
    
    if (allSelected) {
        selectedAppointments.clear();
    } else {
        appointments.forEach(appointment => {
            selectedAppointments.add(appointment.id);
        });
    }
    
    renderAppointments();
}

// Message Functions
async function sendSingleMessage(appointmentId) {
    if (!whatsappConnected) {
        showAlert('WhatsApp não está conectado', 'warning');
        return;
    }
    
    try {
        const wantTemplate = !!useTemplateCheckbox?.checked;
        const isBusiness = modeSelector.value === 'business';
        let result;

        if (wantTemplate && isBusiness) {
            result = await apiCall(`/send/confirm-template/${appointmentId}`, {
                method: 'POST',
                body: JSON.stringify({})
            });
        } else {
            if (wantTemplate && !isBusiness) {
                showAlert('Para usar template, altere o modo para Business API.', 'info');
            }
            const message = customMessage.value.trim() || null;
            result = await apiCall(`/send/${appointmentId}`, {
                method: 'POST',
                body: JSON.stringify({ customMessage: message })
            });
        }
        
        showAlert(`Mensagem enviada para ${result.data.appointment.patient_name}`, 'success');
    } catch (error) {
        // Error already handled in apiCall
    }
}

async function sendBulkMessages() {
    if (!whatsappConnected) {
        showAlert('WhatsApp não está conectado', 'warning');
        return;
    }
    
    if (selectedAppointments.size === 0) {
        showAlert('Selecione pelo menos um agendamento', 'warning');
        return;
    }
    
    const confirmSend = confirm(`Enviar mensagens para ${selectedAppointments.size} destinatários?`);
    if (!confirmSend) return;
    
    sendBulkBtn.disabled = true;
    sendBulkBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...';
    
    try {
        const appointmentIds = Array.from(selectedAppointments);
        const wantTemplate = !!useTemplateCheckbox?.checked;
        const isBusiness = modeSelector.value === 'business';
        let result;

        if (wantTemplate && isBusiness) {
            result = await apiCall('/send/bulk-template', {
                method: 'POST',
                body: JSON.stringify({ appointmentIds })
            });
        } else {
            if (wantTemplate && !isBusiness) {
                showAlert('Para usar template, altere o modo para Business API. Enviaremos como texto padrão.', 'info');
            }
            const message = customMessage.value.trim() || null;
            result = await apiCall('/send/bulk', {
                method: 'POST',
                body: JSON.stringify({ 
                    appointmentIds, 
                    customMessage: message 
                })
            });
        }
        
        const { successful, failed, total } = result.data;
        showAlert(
            `Disparo concluído: ${successful} enviadas, ${failed} falharam de ${total} total`, 
            successful > 0 ? 'success' : 'warning'
        );
        
        // Limpar seleção
        selectedAppointments.clear();
        renderAppointments();
        
    } catch (error) {
        // Error already handled in apiCall
    } finally {
        sendBulkBtn.disabled = false;
        sendBulkBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Enviar Selecionados <span id="selected-count">(0)</span>';
    }
}

async function sendTestMessage() {
    const phone = document.getElementById('test-phone').value.trim();
    const message = document.getElementById('test-message').value.trim();
    
    if (!phone || !message) {
        showAlert('Telefone e mensagem são obrigatórios', 'warning');
        return;
    }
    
    if (!whatsappConnected) {
        showAlert('WhatsApp não está conectado', 'warning');
        return;
    }
    
    try {
        await apiCall('/test', {
            method: 'POST',
            body: JSON.stringify({ phone, message })
        });
        
        showAlert('Mensagem de teste enviada!', 'success');
        bootstrap.Modal.getInstance(document.getElementById('testModal')).hide();
        
        // Limpar campos
        document.getElementById('test-phone').value = '';
        document.getElementById('test-message').value = '';
        
    } catch (error) {
        // Error already handled in apiCall
    }
}

async function confirmAppointment(appointmentId) {
    const confirmAction = confirm('Confirmar este agendamento?');
    if (!confirmAction) return;
    
    try {
        await apiCall(`/appointments/${appointmentId}/confirm`, { method: 'POST' });
        showAlert('Agendamento confirmado!', 'success');
        loadData(); // Recarregar dados
    } catch (error) {
        // Error already handled in apiCall
    }
}

// Utility Functions
function showAlert(message, type = 'info') {
    // Remover alertas existentes
    const existingAlerts = document.querySelectorAll('.alert-custom');
    existingAlerts.forEach(alert => alert.remove());
    
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type} alert-dismissible fade show alert-custom`;
    alertDiv.style.position = 'fixed';
    alertDiv.style.top = '20px';
    alertDiv.style.right = '20px';
    alertDiv.style.zIndex = '9999';
    alertDiv.style.minWidth = '300px';
    
    alertDiv.innerHTML = `
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    
    document.body.appendChild(alertDiv);
    
    // Auto-remover após 5 segundos
    setTimeout(() => {
        if (alertDiv.parentNode) {
            alertDiv.remove();
        }
    }, 5000);
}

function showLoading(show) {
    const loading = document.querySelector('.loading');
    loading.style.display = show ? 'block' : 'none';
}

// ================= On-Premises helpers =================
async function requestOnPremCode() {
    try {
        const body = {
            cc: (onpremCC?.value || '55').trim(),
            phone_number: (onpremPhone?.value || '').trim(),
            method: (onpremMethod?.value || 'sms').trim(),
            cert: (onpremCert?.value || '').trim() || undefined
        };
        if (!body.phone_number) {
            showAlert('Informe o telefone (sem DDI)', 'warning');
            return;
        }
        const res = await apiCall('/waba-onprem/request-code', {
            method: 'POST',
            body: JSON.stringify(body)
        });
        showAlert('Código solicitado com sucesso. Verifique SMS/voz.', 'success');
        console.log('On-Prem request-code result:', res);
    } catch (e) {}
}

async function verifyOnPremCode() {
    try {
        const body = {
            code: (onpremCode?.value || '').trim(),
            cert: (onpremCert?.value || '').trim() || undefined,
            pin: (onpremPin?.value || '').trim() || undefined
        };
        if (!body.code) {
            showAlert('Informe o código recebido', 'warning');
            return;
        }
        const res = await apiCall('/waba-onprem/verify', {
            method: 'POST',
            body: JSON.stringify(body)
        });
        showAlert('Número verificado com sucesso!', 'success');
        console.log('On-Prem verify result:', res);
    } catch (e) {}
}

function renderStatusBadge(status) {
    if (!status) return '<span class="badge bg-secondary">sem envio</span>';
    const map = {
        sent: { cls: 'bg-info text-dark', label: 'enviada' },
        delivered: { cls: 'bg-primary', label: 'entregue' },
        read: { cls: 'bg-success', label: 'lida' },
        failed: { cls: 'bg-danger', label: 'falhou' },
        confirmed: { cls: 'bg-success', label: 'confirmada' },
        cancelled: { cls: 'bg-warning text-dark', label: 'cancelada' }
    };
    const cfg = map[status] || { cls: 'bg-secondary', label: status };
    return `<span class="badge ${cfg.cls}">${cfg.label}</span>`;
}

function updateStatusBadges() {
    document.querySelectorAll('.message-status').forEach(el => {
        const id = parseInt(el.getAttribute('data-apt-id'));
        const status = statusesMap[id]?.status;
        el.innerHTML = renderStatusBadge(status);
    });
}

// Novas funções para confirmações recentes
async function renderRecentConfirmations() {
    const container = document.getElementById('confirmations-container');
    container.innerHTML = '<small class="text-muted">Carregando...</small>';
    try {
        const res = await fetch('/api/messages/confirmations/recent');
        const data = await res.json();
        if (data.success && Array.isArray(data.data)) {
            if (data.data.length === 0) {
                container.innerHTML = '<small class="text-muted">Nenhuma confirmação recente.</small>';
                return;
            }
            container.innerHTML = `<ul class="list-group">
                ${data.data.map(c => `<li class="list-group-item">
                    <strong>${c.phone}</strong> confirmado por <span class="text-primary">${c.confirmed_by || c.confirmedBy || 'sistema'}</span><br>
                    <small>${new Date(c.confirmed_at || c.confirmedAt).toLocaleString('pt-BR')}</small>
                    ${c.message_body ? `<br><small class="text-muted">"${c.message_body}"</small>` : ''}
                </li>`).join('')}
            </ul>`;
        } else {
            container.innerHTML = '<small class="text-danger">Erro ao carregar confirmações.</small>';
        }
    } catch (e) {
        container.innerHTML = '<small class="text-danger">Erro ao carregar confirmações.</small>';
    }
}

// Chame ao carregar o painel
renderRecentConfirmations();