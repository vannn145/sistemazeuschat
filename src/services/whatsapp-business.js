const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { formatClinicDateTime } = require('../utils/datetime');

class WhatsAppBusinessService {
    constructor() {
        this.accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
        this.businessAccountId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
        this.apiVersion = process.env.WHATSAPP_API_VERSION || 'v18.0';
        this.baseURL = `https://graph.facebook.com/${this.apiVersion}`;
        this.webhookVerifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
        this.statusMap = {
            sent: Number(process.env.WHATSAPP_STATUS_SENT_ID || 1),
            cancelled: Number(process.env.WHATSAPP_STATUS_CANCELLED_ID || 2),
            confirmed: Number(process.env.WHATSAPP_STATUS_CONFIRMED_ID || 3),
            delivered: Number(process.env.WHATSAPP_STATUS_DELIVERED_ID || 4)
        };
        
        // Configurar axios com certificado se disponível
        this.setupHttpsAgent();
    }

    setupHttpsAgent() {
        const certPath = path.join(__dirname, '../../certificates');
        
        try {
            // Verificar se há certificados disponíveis
            const certFiles = fs.readdirSync(certPath);
            const certFile = certFiles.find(file => file.endsWith('.pem') || file.endsWith('.crt'));
            
            if (certFile) {
                const cert = fs.readFileSync(path.join(certPath, certFile));
                console.log('📜 Certificado WhatsApp Business carregado');
                
                // Configurar agent HTTPS com certificado
                const https = require('https');
                this.httpsAgent = new https.Agent({
                    cert: cert,
                    rejectUnauthorized: false // Ajustar conforme necessário
                });
            }
        } catch (error) {
            console.log('⚠️  Nenhum certificado encontrado, usando configuração padrão');
        }
    }

    async registerPhoneNumber() {
        // Cloud API não permite mais registrar números via endpoint programático.
        // O registro deve ser feito no WhatsApp Manager (API Setup) ou pelo Embedded Signup.
        // Mantemos este método apenas para não quebrar chamadas existentes e para
        // retornar uma mensagem clara.
        const err = new Error('Registro de número via API descontinuado. Use o WhatsApp Manager (API Setup) para adicionar/registrar o número e vincular o App à WABA.');
        err.code = 'REGISTRATION_UNSUPPORTED';
        throw err;
    }

    async verifyConfiguration() {
        if (!this.accessToken || !this.phoneNumberId) {
            throw new Error('Configuração incompleta: ACCESS_TOKEN e PHONE_NUMBER_ID são obrigatórios');
        }

        try {
            // Primeiro tentar verificar se o número existe
            const response = await axios.get(
                `${this.baseURL}/${this.phoneNumberId}`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`
                    },
                    httpsAgent: this.httpsAgent
                }
            );

            console.log('✅ WhatsApp Business API configurado corretamente');
            console.log(`📱 Número verificado: ${response.data.display_phone_number}`);
            return response.data;
            
        } catch (error) {
            // Devolver erro com orientação quando o número/app não for encontrado
            const details = error.response?.data?.error;
            const code = details?.code;
            const subcode = details?.error_subcode;
            const hint =
                code === 100 || error.response?.status === 404
                    ? 'Verifique se o PHONE_NUMBER_ID pertence à WABA configurada e se o App está conectado em WhatsApp Manager > Accounts > WhatsApp Accounts > Connected apps.'
                    : code === 133010
                        ? 'Account not registered: conecte o App à WABA e gere um token (System User) com WhatsApp Business Messaging/Management. Teste o envio na página API Setup.'
                        : undefined;

            const friendly = new Error(`Falha na verificação do WhatsApp Business API${hint ? ` – ${hint}` : ''}`);
            friendly.original = error.response?.data || error.message;
            throw friendly;
        }
    }

    async sendMessage(to, message, type = 'text') {
        try {
            // Limpar número (remover caracteres especiais)
            const cleanNumber = to.replace(/\D/g, '');
            
            const payload = {
                messaging_product: 'whatsapp',
                to: cleanNumber,
                type: type
            };

            if (type === 'text') {
                payload.text = { body: message };
            }

            const response = await axios.post(
                `${this.baseURL}/${this.phoneNumberId}/messages`,
                payload,
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    httpsAgent: this.httpsAgent
                }
            );

            console.log(`✅ Mensagem enviada para ${cleanNumber} via Business API`);
            return {
                success: true,
                messageId: response.data.messages[0].id,
                phone: cleanNumber
            };

        } catch (error) {
            console.error(`❌ Erro ao enviar mensagem:`, error.response?.data || error.message);
            throw error;
        }
    }

    async sendTemplateMessage(to, templateName, languageCode, components = [], options = {}) {
        const receivedOptions = options || {};
        const { __retryAttempt, ...publicOptions } = receivedOptions;
        const attempt = Number(__retryAttempt || 0) || 0;
        const rawRetryLimit = receivedOptions.retryLimit;
        const retryLimit = Number.isFinite(rawRetryLimit) && rawRetryLimit >= 0
            ? Math.floor(rawRetryLimit)
            : 1;

        const cleanNumber = to.replace(/\D/g, '');
        const tplName = templateName || process.env.DEFAULT_CONFIRM_TEMPLATE_NAME || 'confirmacao_personalizada';
        const lang = languageCode || process.env.DEFAULT_CONFIRM_TEMPLATE_LOCALE || 'pt_BR';
        const templateComponents = this.buildTemplateComponents(components, publicOptions);
        const payload = {
            messaging_product: 'whatsapp',
            to: cleanNumber,
            type: 'template',
            template: {
                name: tplName,
                language: { code: lang },
                components: templateComponents
            }
        };

        if (String(process.env.LOG_TEMPLATE_PAYLOAD || 'false').toLowerCase() === 'true') {
            console.log('[TemplatePayload]', JSON.stringify({
                to: payload.to,
                template: payload.template
            }, null, 2));
        }

        try {
            const response = await axios.post(
                `${this.baseURL}/${this.phoneNumberId}/messages`,
                payload,
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    httpsAgent: this.httpsAgent
                }
            );
            console.log(`✅ Template '${tplName}' enviado para ${cleanNumber}`);
            return {
                success: true,
                messageId: response.data.messages?.[0]?.id,
                phone: cleanNumber,
                response: response.data
            };
        } catch (error) {
            const errorData = error.response?.data;
            const graphError = errorData?.error;
            const previewComponents = Array.isArray(payload?.template?.components)
                ? payload.template.components.map((component) => {
                    const preview = {
                        type: component.type,
                        sub_type: component.sub_type,
                        index: component.index
                    };
                    if (Array.isArray(component.parameters)) {
                        preview.parameters = component.parameters.map((param) => {
                            if (param.type === 'text') {
                                return { type: 'text', text: String(param.text ?? '').slice(0, 64) };
                            }
                            if (param.type === 'payload') {
                                return { type: 'payload', payload: String(param.payload ?? '').slice(0, 64) };
                            }
                            return { type: param.type };
                        });
                    }
                    return preview;
                })
                : undefined;
            console.error('❌ Erro ao enviar template:', {
                error: graphError || error.message,
                status: error.response?.status,
                attempt,
                fbtrace_id: graphError?.fbtrace_id,
                payload: {
                    to: payload?.to,
                    template: {
                        name: payload?.template?.name,
                        language: payload?.template?.language,
                        components: previewComponents
                    }
                }
            });

            const shouldRetry = graphError?.code === 131000 && attempt < retryLimit;
            if (shouldRetry) {
                const delayMs = 1000 * (attempt + 1);
                console.warn(`⏳ Retentativa para template '${tplName}' em ${delayMs}ms (tentativa ${attempt + 1}/${retryLimit + 1})`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                return this.sendTemplateMessage(to, templateName, languageCode, components, {
                    ...publicOptions,
                    retryLimit,
                    __retryAttempt: attempt + 1
                });
            }

            throw error;
        }
    }

    buildTemplateComponents(preset = [], options = {}) {
        const scheduleTokenRaw = options?.scheduleId !== undefined && options?.scheduleId !== null
            ? String(options.scheduleId).trim()
            : '';
        const scheduleToken = scheduleTokenRaw.replace(/[^A-Za-z0-9_-]/g, '');
        const confirmPayload = scheduleToken ? `confirm_${scheduleToken}` : 'confirm';
        const cancelPayload = scheduleToken ? `cancel_${scheduleToken}` : 'cancel';
        const includeConfirmButtons = options?.includeConfirmButtons ?? Boolean(scheduleToken);

        const sanitizeText = (value, fallback) => {
            if (typeof value === 'string') {
                const trimmed = value.trim();
                return trimmed.length ? trimmed.slice(0, 1024) : fallback;
            }
            if (value === null || value === undefined) {
                return fallback;
            }
            const text = String(value).trim();
            return text.length ? text.slice(0, 1024) : fallback;
        };

        const ensureTextParameters = (comp) => {
            if (comp.type !== 'body') {
                return comp;
            }

            const originalParams = Array.isArray(comp.parameters) ? comp.parameters : [];
            const defaults = ['Paciente', 'Data', 'Horário', 'Procedimento não informado'];

            return {
                type: 'body',
                parameters: defaults.map((fallback, index) => {
                    const candidate = originalParams[index];
                    const safeText = sanitizeText(candidate?.text, fallback);
                    return { type: 'text', text: safeText };
                })
            };
        };

        const sanitizePayload = (value, fallback, preferFallback = false) => {
            const base = typeof value === 'string' ? value.trim() : '';
            const source = base || (preferFallback ? fallback || '' : '') || fallback || '';
            const sanitized = source ? source.replace(/[^A-Za-z0-9_:\-]/g, '_') : '';
            if (sanitized) {
                return sanitized.slice(0, 128);
            }
            return preferFallback ? 'confirm' : 'option_0';
        };

        const createButton = (index, payload) => ({
            type: 'button',
            sub_type: 'quick_reply',
            index: String(index),
            parameters: [
                { type: 'payload', payload }
            ]
        });

        let normalized = Array.isArray(preset)
            ? preset.map(comp => {
                if (!comp || typeof comp !== 'object') {
                    return null;
                }
                if (comp.type === 'body') {
                    return ensureTextParameters(comp);
                }
                if (comp.type === 'button' && comp.sub_type === 'quick_reply') {
                    const idx = comp.index !== undefined ? String(comp.index) : '0';
                    const fallbackPayload = idx === '0' ? confirmPayload : idx === '1' ? cancelPayload : undefined;
                    const existingPayload = Array.isArray(comp.parameters)
                        ? comp.parameters.find(p => p && p.type === 'payload')?.payload
                        : undefined;
                    return createButton(idx, sanitizePayload(existingPayload, fallbackPayload, includeConfirmButtons));
                }
                return comp;
            }).filter(Boolean)
            : [];

        const hasBody = normalized.some(c => c?.type === 'body');
        if (!hasBody) {
            normalized.unshift(ensureTextParameters({ type: 'body', parameters: [] }));
        }

        if (includeConfirmButtons) {
            const hasConfirmButton = normalized.some(c => c?.type === 'button' && c.sub_type === 'quick_reply' && c.index === '0');
            if (!hasConfirmButton) {
                normalized.push(createButton('0', confirmPayload));
            }

            const hasCancelButton = normalized.some(c => c?.type === 'button' && c.sub_type === 'quick_reply' && c.index === '1');
            if (!hasCancelButton) {
                normalized.push(createButton('1', cancelPayload));
            }
        }

        return normalized;
    }

    async sendBulkMessages(recipients) {
        const results = [];
        
        for (let i = 0; i < recipients.length; i++) {
            const recipient = recipients[i];
            
            try {
                console.log(`📤 Enviando ${i + 1}/${recipients.length} para ${recipient.phone}`);
                
                const result = await this.sendMessage(recipient.phone, recipient.message);
                results.push({
                    ...recipient,
                    success: true,
                    messageId: result.messageId,
                    error: null
                });

                // Intervalo entre mensagens (evitar rate limiting)
                if (i < recipients.length - 1) {
                    console.log('⏱️ Aguardando intervalo...');
                    await new Promise(resolve => setTimeout(resolve, 1000)); // 1 segundo
                }

            } catch (error) {
                results.push({
                    ...recipient,
                    success: false,
                    messageId: null,
                    error: error.message
                });
            }
        }

        return results;
    }

    async listTemplates({ limit = 50, status = 'APPROVED', search = null } = {}) {
        if (!this.accessToken || !this.businessAccountId) {
            throw new Error('Configuração incompleta: defina WHATSAPP_ACCESS_TOKEN e WHATSAPP_BUSINESS_ACCOUNT_ID');
        }

        const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 200);
        const params = { limit: safeLimit };

        if (status && String(status).toLowerCase() !== 'all') {
            params.status = String(status).toUpperCase();
        }

        if (search && typeof search === 'string' && search.trim()) {
            params.name = search.trim();
        }

        try {
            const { data } = await axios.get(
                `${this.baseURL}/${this.businessAccountId}/message_templates`,
                {
                    headers: {
                        Authorization: `Bearer ${this.accessToken}`
                    },
                    params,
                    httpsAgent: this.httpsAgent
                }
            );

            const templates = Array.isArray(data?.data) ? data.data.map((tpl) => ({
                id: tpl.id || null,
                name: tpl.name || null,
                language: tpl.language || null,
                category: tpl.category || null,
                status: tpl.status || null,
                quality_score: tpl.quality_score || null,
                last_updated_time: tpl.last_updated_time || tpl.last_update_time || null,
                components: Array.isArray(tpl.components) ? tpl.components : []
            })) : [];

            return {
                templates,
                paging: data?.paging || null
            };
        } catch (error) {
            const apiError = error.response?.data?.error;
            const friendly = new Error(apiError?.message || error.message || 'Falha ao consultar templates');
            friendly.code = apiError?.code || error.code;
            friendly.error_subcode = apiError?.error_subcode;
            friendly.original = error.response?.data || error.message;
            throw friendly;
        }
    }

    async getMessageStatus(messageId) {
        try {
            const response = await axios.get(
                `${this.baseURL}/${messageId}`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`
                    },
                    httpsAgent: this.httpsAgent
                }
            );

            return response.data;
        } catch (error) {
            console.error('Erro ao verificar status:', error.response?.data || error.message);
            throw error;
        }
    }

    // Webhook para receber respostas/confirmações
    handleWebhook(body, signature, rawBody) {
        // Verificar assinatura do webhook (se segredo definido)
        const secret = process.env.WHATSAPP_WEBHOOK_SECRET;
        const hasRealSecret = secret && secret !== 'your_webhook_secret';
        if (hasRealSecret) {
            if (!signature) {
                throw new Error('Webhook sem assinatura');
            }
            const crypto = require('crypto');
            const payload = rawBody || JSON.stringify(body);
            const expectedSignature = crypto
                .createHmac('sha256', secret)
                .update(payload)
                .digest('hex');
            if (signature !== `sha256=${expectedSignature}`) {
                console.error('❌ Assinatura inválida do webhook', {
                    received: signature,
                    expected: `sha256=${expectedSignature}`
                });
                throw new Error('Assinatura inválida');
            }
        } else if (secret === 'your_webhook_secret') {
            console.warn('⚠️  WHATSAPP_WEBHOOK_SECRET usa valor placeholder; pulando verificação da assinatura.');
        }

        // Processar mensagens recebidas
        const changes = body.entry?.[0]?.changes?.[0];
        if (changes?.field === 'messages') {
            const messages = changes.value?.messages || [];
            const statuses = changes.value?.statuses || [];

            console.log('📥 Webhook recebido:', {
                messages: messages.map(m => ({ type: m.type, id: m.id, from: m.from, button: m.button?.text, interactive: m.interactive?.button_reply?.title || m.interactive?.list_reply?.title })),
                statuses: statuses.map(s => ({
                    id: s.id,
                    status: s.status,
                    errors: Array.isArray(s.errors)
                        ? s.errors.map(err => ({ code: err.code, title: err.title, details: err.details, href: err.href }))
                        : undefined
                }))
            });

            // Processar mensagens recebidas (confirmações via texto ou botão)
            for (const message of messages) {
                const from = message.from; // número do usuário
                let intent = null; // 'confirm' | 'cancel' | null

                const preview = this.describeIncomingMessage(message) || null;
                const messageTimestamp = message.timestamp ? Number(message.timestamp) : null;
                const receivedAt = (() => {
                    if (!Number.isFinite(messageTimestamp)) {
                        return new Date();
                    }
                    const ts = messageTimestamp > 1e12 ? messageTimestamp : messageTimestamp * 1000;
                    const date = new Date(ts);
                    return Number.isNaN(date.getTime()) ? new Date() : date;
                })();

                const dbService = require('./database');
                dbService.logOutboundMessage({
                    appointmentId: null,
                    phone: from,
                    messageId: message.id || null,
                    type: message.type || 'text',
                    templateName: null,
                    status: 'received',
                    body: preview,
                    direction: 'inbound',
                    metadata: {
                        source: 'webhook',
                        interactiveType: message.interactive?.type || null,
                        buttonText: message.button?.text || null,
                        payload: message.button?.payload || message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || null
                    },
                    lastAttemptAt: receivedAt
                }).catch((logErr) => {
                    console.log('⚠️  Falha ao registrar mensagem recebida:', logErr.message);
                });

                if (message.type === 'text') {
                    const text = (message.text?.body || '').toLowerCase().trim();
                    if (['sim', 's', 'confirmo', 'ok', 'confirmar'].includes(text)) intent = 'confirm';
                    if (['nao', 'não', 'n', 'cancelar', 'desmarcar'].includes(text)) intent = 'cancel';
                }

                // Botões interativos (templates com quick replies)
                if (message.type === 'button') {
                    const title = (message.button?.text || '').toLowerCase();
                    const payload = (message.button?.payload || '').toLowerCase();
                    if (['sim', 'confirmar', 'confirmado', 'ok'].includes(title) || payload.includes('confirm')) intent = 'confirm';
                    if (['desmarcar', 'cancelar', 'não', 'nao'].includes(title) || payload.includes('cancel')) intent = 'cancel';
                }

                // Interativo do tipo 'interactive' (button_reply/list_reply)
                if (message.type === 'interactive') {
                    const br = message.interactive?.button_reply;
                    const lr = message.interactive?.list_reply;
                    const title = (br?.title || lr?.title || '').toLowerCase();
                    const id = (br?.id || lr?.id || '').toLowerCase();
                    if (['sim', 'confirmar', 'confirmado', 'ok'].includes(title) || id.includes('confirm')) intent = 'confirm';
                    if (['desmarcar', 'cancelar', 'não', 'nao'].includes(title) || id.includes('cancel')) intent = 'cancel';
                }

                if (intent === 'confirm') {
                    console.log(`✅ Confirmação recebida de ${from}`);
                    this.processConfirmation(from, message.id, message);
                } else if (intent === 'cancel') {
                    console.log(`⚠️  Pedido de desmarcação de ${from}`);
                    this.processCancellation(from, message.id, message);
                }
            }

            // Processar status de entrega
            statuses.forEach(async (status) => {
                try {
                    const trimmedErrors = Array.isArray(status.errors)
                        ? status.errors.map(err => ({
                            code: err.code,
                            title: err.title,
                            details: err.details,
                            href: err.href,
                            description: err.error_data?.details || err.description || err.message
                        }))
                        : undefined;

                    if (status.status === 'failed') {
                        console.warn(`⚠️  Mensagem ${status.id} marcada como FAILED`, {
                            errors: trimmedErrors || null,
                            rawErrorsPresent: Array.isArray(status.errors) && status.errors.length > 0
                        });
                        if (!trimmedErrors || trimmedErrors.length === 0) {
                            console.warn(`⚠️  WhatsApp retornou status FAILED sem detalhar o erro para ${status.id}. Verifique o painel Meta ou registros adicionais.`);
                        }
                    } else {
                        console.log(`📊 Status da mensagem ${status.id}: ${status.status}`);
                    }
                    const dbService = require('./database');
                    await dbService.updateMessageStatus(status.id, status.status, trimmedErrors ? JSON.stringify(trimmedErrors) : null);
                } catch (e) {
                    console.log('⚠️  Falha ao atualizar status da mensagem:', e.message);
                }
            });
        }

        return { success: true };
    }

    async processConfirmation(phoneNumber, messageId, incomingMessage = null) {
        try {
            const dbService = require('./database');
            const hintedAppointmentId = this.extractAppointmentId(incomingMessage);
            let appointmentFromHint = null;
            if (hintedAppointmentId) {
                try {
                    appointmentFromHint = await dbService.getAppointmentById(hintedAppointmentId);
                    if (!appointmentFromHint) {
                        console.log(`ℹ️  Schedule hint ${hintedAppointmentId} informado no webhook mas não encontrado no banco.`);
                    }
                } catch (hintErr) {
                    console.log(`⚠️  Falha ao buscar agendamento ${hintedAppointmentId} do webhook:`, hintErr.message);
                }
            }

            const contextMessageId = incomingMessage?.context?.id || incomingMessage?.context?.message_id || null;
            let appointmentFromContext = null;
            if (contextMessageId) {
                try {
                    appointmentFromContext = await dbService.getAppointmentByMessageId(contextMessageId);
                    if (!appointmentFromContext) {
                        console.log(`ℹ️  Nenhum agendamento vinculado à mensagem ${contextMessageId} recebida no contexto do webhook.`);
                    }
                } catch (contextErr) {
                    console.log(`⚠️  Falha ao localizar agendamento pelo contexto ${contextMessageId}:`, contextErr.message);
                }
            }

            let apt = appointmentFromHint || appointmentFromContext || null;
            if (!apt) {
                try {
                    apt = await dbService.getLatestPendingAppointmentByPhone(phoneNumber);
                } catch (pendingErr) {
                    console.log('⚠️  Falha ao buscar pendente por telefone no webhook:', pendingErr.message);
                }
            }
            if (!apt) {
                try {
                    apt = await dbService.getLatestAppointmentFromLogsByPhone(phoneNumber);
                } catch (logLookupErr) {
                    console.log('⚠️  Falha ao buscar agendamento via logs no webhook:', logLookupErr.message);
                }
            }
            const confirmationText = this.extractIncomingText(incomingMessage);
            const confirmationTimestamp = incomingMessage?.timestamp ? Number(incomingMessage.timestamp) : null;

            const result = await dbService.registrarConfirmacao({
                appointmentId: appointmentFromHint?.id || appointmentFromContext?.id || hintedAppointmentId || apt?.id,
                phone: phoneNumber,
                confirmedBy: 'paciente',
                messageBody: confirmationText,
                source: 'webhook',
                incomingMessageId: messageId,
                timestamp: confirmationTimestamp
            });

            let appointmentForMessage = appointmentFromHint || appointmentFromContext || apt;
            if (!appointmentForMessage && result?.appointmentId) {
                try {
                    appointmentForMessage = await dbService.getAppointmentById(result.appointmentId);
                } catch (lookupError) {
                    console.log('⚠️  Falha ao recuperar agendamento confirmado para mensagem de agradecimento:', lookupError.message);
                }
            }

            if (result?.appointmentId && appointmentForMessage) {
                const { date: dateBR, time: timeBR } = formatClinicDateTime(appointmentForMessage.tratamento_date);
                const ackTemplate = process.env.CONFIRMATION_ACK_TEMPLATE_NAME;
                const ackLocale = process.env.CONFIRMATION_ACK_TEMPLATE_LOCALE || 'pt_BR';
                const ackPhone = '(34) 99889-5211';
                const ackText = `Obrigado! Seu agendamento para ${dateBR} às ${timeBR} está confirmado. Qualquer dúvida, estamos à disposição pelo telefone ${ackPhone}.`;
                let ackDelivered = false;

                if (ackTemplate) {
                    const ackComponents = [
                        {
                            type: 'body',
                            parameters: [
                                { type: 'text', text: appointmentForMessage.patient_name || 'Paciente' },
                                { type: 'text', text: dateBR },
                                { type: 'text', text: timeBR }
                            ]
                        }
                    ];
                    try {
                        await this.sendTemplateMessage(phoneNumber, ackTemplate, ackLocale, ackComponents, {
                            scheduleId: appointmentForMessage.id,
                            includeConfirmButtons: false
                        });
                        ackDelivered = true;
                    } catch (ackErr) {
                        console.warn('⚠️  Falha ao enviar template de agradecimento de confirmação:', ackErr.response?.data || ackErr.message);
                    }
                }

                if (!ackDelivered) {
                    try {
                        await this.sendMessage(phoneNumber, ackText);
                        ackDelivered = true;
                    } catch (textAckError) {
                        console.warn('⚠️  Falha ao enviar mensagem de agradecimento em texto:', textAckError.response?.data || textAckError.message);
                    }
                }

                if (!ackDelivered) {
                    console.log('ℹ️  Mensagem de agradecimento não enviada; verifique template/contato.');
                }

                console.log(`🏁 Agendamento ${result.appointmentId} confirmado via webhook por ${phoneNumber}`);
            } else {
                const ackTemplate = process.env.CONFIRMATION_ACK_TEMPLATE_NAME;
                const ackLocale = process.env.CONFIRMATION_ACK_TEMPLATE_LOCALE || 'pt_BR';
                if (ackTemplate) {
                    const placeholderComponents = [
                        {
                            type: 'body',
                            parameters: [
                                { type: 'text', text: 'Paciente' },
                                { type: 'text', text: 'Data' },
                                { type: 'text', text: 'Horário' }
                            ]
                        }
                    ];
                    try {
                        await this.sendTemplateMessage(phoneNumber, ackTemplate, ackLocale, placeholderComponents, {
                            scheduleId: null,
                            includeConfirmButtons: false
                        });
                    } catch (ackErr) {
                        console.warn('⚠️  Falha ao enviar template de agradecimento fallback:', ackErr.response?.data || ackErr.message);
                    }
                }

                if (!ackTemplate) {
                    const ackPhone = '(34) 99889-5211';
                    const fallbackAck = `Obrigado! Recebemos sua confirmação. Qualquer dúvida, estamos à disposição pelo telefone ${ackPhone}.`;
                    try {
                        await this.sendMessage(phoneNumber, fallbackAck);
                    } catch (textAckError) {
                        console.warn('⚠️  Falha ao enviar mensagem de agradecimento genérica em texto:', textAckError.response?.data || textAckError.message);
                    }
                    console.log('ℹ️  Confirmação sem agendamento associado; enviado agradecimento genérico em texto.');
                }
                console.log(`ℹ️ Confirmação via webhook sem match de agendamento para ${phoneNumber}`);
            }
        } catch (error) {
            console.error('❌ Erro geral ao processar confirmação:', error.response?.data || error.message);
        }
    }

    async processCancellation(phoneNumber, messageId, incomingMessage = null) {
        try {
            const dbService = require('./database');
            const hintedAppointmentId = this.extractAppointmentId(incomingMessage);
            let appointmentFromHint = null;
            if (hintedAppointmentId) {
                try {
                    appointmentFromHint = await dbService.getAppointmentById(hintedAppointmentId);
                } catch (hintErr) {
                    console.log(`⚠️  Falha ao buscar agendamento ${hintedAppointmentId} do webhook:`, hintErr.message);
                }
            }

            const apt = appointmentFromHint || await dbService.getLatestPendingAppointmentByPhone(phoneNumber);
            const cancellationText = this.extractIncomingText(incomingMessage);
            const cancellationTimestamp = incomingMessage?.timestamp ? Number(incomingMessage.timestamp) : null;

            const targetAppointmentId = appointmentFromHint?.id || hintedAppointmentId || apt?.id;

            if (targetAppointmentId) {
                await dbService.cancelAppointment(targetAppointmentId, {
                    phone: phoneNumber,
                    incomingMessageId: messageId,
                    messageBody: cancellationText,
                    cancelledBy: 'paciente',
                    source: 'webhook',
                    timestamp: cancellationTimestamp
                });
            }

            const treatmentOwner = appointmentFromHint || apt;

            if (treatmentOwner && treatmentOwner.treatment_id) {
                try {
                    await dbService.updateWhatsappStatusForTreatment(treatmentOwner.treatment_id, this.statusMap.cancelled, {
                        phone: phoneNumber,
                        incomingMessageId: messageId,
                        messageBody: cancellationText,
                        appointmentId: targetAppointmentId || treatmentOwner.id,
                        direction: 'webhook_cancel',
                        timestamp: cancellationTimestamp
                    });
                } catch (statusError) {
                    console.log('⚠️  Falha ao atualizar status WhatsApp (cancelamento):', statusError.message);
                }
            }
            // Aqui poderíamos registrar um status de cancelamento ou alertar a equipe.
            const cancellationAckTemplate = process.env.CANCELLATION_ACK_TEMPLATE_NAME;
            const cancellationAckLocale = process.env.CANCELLATION_ACK_TEMPLATE_LOCALE || 'pt_BR';
            if (cancellationAckTemplate) {
                const owner = appointmentFromHint || apt || null;
                const treatmentDateTime = owner?.tratamento_date ? formatClinicDateTime(owner.tratamento_date) : null;
                const components = [
                    {
                        type: 'body',
                        parameters: [
                            { type: 'text', text: owner?.patient_name || 'Paciente' },
                            { type: 'text', text: treatmentDateTime?.date || 'Data' },
                            { type: 'text', text: treatmentDateTime?.time || 'Horário' }
                        ]
                    }
                ];
                try {
                    await this.sendTemplateMessage(phoneNumber, cancellationAckTemplate, cancellationAckLocale, components, {
                        scheduleId: targetAppointmentId || owner?.id || null,
                        includeConfirmButtons: false
                    });
                } catch (ackErr) {
                    console.warn('⚠️  Falha ao enviar template de confirmação de cancelamento:', ackErr.response?.data || ackErr.message);
                }
            } else {
                console.log('ℹ️  CANCELLATION_ACK_TEMPLATE_NAME não definido; nenhuma mensagem de cancelamento adicional enviada para evitar erro 131047.');
            }
        } catch (error) {
            console.error('Erro ao processar cancelamento:', error.response?.data || error.message);
        }
    }

    extractIncomingText(message) {
        if (!message) {
            return null;
        }
        if (message.type === 'text') {
            return message.text?.body || null;
        }
        if (message.type === 'button') {
            return message.button?.text || message.button?.payload || null;
        }
        if (message.type === 'interactive') {
            const button = message.interactive?.button_reply;
            const list = message.interactive?.list_reply;
            return button?.title || button?.id || list?.title || list?.id || null;
        }
        return null;
    }

    describeIncomingMessage(message) {
        if (!message) {
            return null;
        }
        const text = this.extractIncomingText(message);
        if (text) {
            return text;
        }
        switch (message.type) {
            case 'image':
                return '[Imagem recebida]';
            case 'audio':
            case 'voice':
                return '[Mensagem de áudio recebida]';
            case 'video':
                return '[Vídeo recebido]';
            case 'document':
                return message.document?.filename ? `[Documento: ${message.document.filename}]` : '[Documento recebido]';
            case 'sticker':
                return '[Figurinha recebida]';
            case 'location':
                return '[Localização compartilhada]';
            default:
                return message.type ? `[${message.type}]` : '[Mensagem recebida]';
        }
    }

    extractAppointmentId(message) {
        if (!message) {
            return null;
        }

        const rawValues = [];
        if (message.button?.payload) rawValues.push(message.button.payload);
        if (message.button?.text) rawValues.push(message.button.text);
        if (message.text?.body) rawValues.push(message.text.body);

        const interactive = message.interactive;
        if (interactive?.button_reply?.id) rawValues.push(interactive.button_reply.id);
        if (interactive?.button_reply?.title) rawValues.push(interactive.button_reply.title);
        if (interactive?.list_reply?.id) rawValues.push(interactive.list_reply.id);
        if (interactive?.list_reply?.title) rawValues.push(interactive.list_reply.title);

        for (const value of rawValues) {
            if (!value || typeof value !== 'string') continue;
            const match = value.match(/(?:schedule|apt|id|confirm|cancel|conf|cnl)[_:\-]?(\d{3,})/i);
            if (match && match[1]) {
                const parsed = Number(match[1]);
                if (Number.isFinite(parsed)) {
                    return parsed;
                }
            }
        }

        return null;
    }

    generateMessage(appointment) {
        const { date: formattedDate, time: formattedTime } = formatClinicDateTime(appointment.tratamento_date);

        return `🏥 *Confirmação de Agendamento*

Olá *${appointment.patient_name}*!

Você tem um agendamento marcado na CD CENTER UBERABA:
📅 *Data:* ${formattedDate}
🕐 *Horário:* ${formattedTime}
🔬 *Procedimento:* ${appointment.main_procedure_term}

Para confirmar seu agendamento, responda *SIM*.
    Para reagendar, entre em contato: (34) 99889-5211

_Esta é uma mensagem automática do sistema de agendamentos._`;
    }

    getStatus() {
        return {
            isConfigured: !!(this.accessToken && this.phoneNumberId),
            hasApiAccess: true,
            phoneNumber: '+55 34 99889-5211'
        };
    }
}

module.exports = new WhatsAppBusinessService();