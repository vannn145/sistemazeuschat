const express = require('express');
const router = express.Router();
const cronService = require('../services/cron');
const dbService = require('../services/database');
const whatsappService = require('../services/whatsapp-hybrid');
const whatsappBusiness = require('../services/whatsapp-business');
const axios = require('axios');

// Log simples de requisições para depuração
router.use((req, res, next) => {
    try {
        console.log(`API ${req.method} ${req.originalUrl}`);
    } catch (_) {}
    next();
});

// ===== Cron: status e execução manual =====
router.get('/cron/status', (req, res) => {
    try {
        res.json({ success: true, data: cronService.getStatus() });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/cron/run', async (req, res) => {
    try {
        const result = await cronService.runOnce();
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Utilitário: extrair o primeiro telefone válido (formato E.164 BR) de um campo livre
function pickFirstPhone(raw) {
    if (!raw) return null;
    const parts = String(raw).split(/[;|,\n\r\t]/g);
    for (const p of parts) {
        const digits = (p.match(/\d+/g) || []).join('');
        if (!digits) continue;
        let n = digits;
        // Se já vier com 55 e 12-13 dígitos, mantém; se 10-11 dígitos, prefixa 55
        if (n.startsWith('55')) {
            // ok
        } else if (n.length >= 10 && n.length <= 11) {
            n = '55' + n;
        }
        if (n.length >= 12 && n.length <= 13) return `+${n}`;
    }
    return null;
}

// Conectar WhatsApp (Web ou Business)
router.post('/whatsapp/connect', async (req, res) => {
    try {
        const result = await whatsappService.initialize();
        res.json(result);
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});
        router.get('/test-template', async (req, res) => {
            try {
                const phone = req.query.phone;
                const templateName = req.query.templateName || req.query.template || process.env.DEFAULT_CONFIRM_TEMPLATE_NAME || 'confirmacao_personalizada';
                const languageCode = req.query.languageCode || req.query.lang || process.env.DEFAULT_CONFIRM_TEMPLATE_LOCALE || 'pt_BR';
                if (!phone) {
                    return res.status(400).json({ success: false, message: 'Telefone é obrigatório' });
                }
                let components = [];
                if (!req.query.components && templateName === (process.env.DEFAULT_CONFIRM_TEMPLATE_NAME || 'confirmacao_personalizada')) {
                    const patientName = req.query.patientName || 'Paciente';
                    const dateBR = req.query.dateBR || new Date().toLocaleDateString('pt-BR');
                    const timeBR = req.query.timeBR || new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                    const procedure = req.query.procedure || 'Exame';
                    components = [
                        { type: 'body', parameters: [
                            { type: 'text', text: patientName },
                            { type: 'text', text: dateBR },
                            { type: 'text', text: timeBR },
                            { type: 'text', text: procedure }
                        ]}
                    ];
                }
                const result = await whatsappBusiness.sendTemplateMessage(phone, templateName, languageCode, components);
                res.json({ success: true, data: result });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message, details: error.response?.data });
            }
        });

// Listar usuários atribuídos à WABA (verifica se o System User tem o ativo e tarefas)
router.get('/whatsapp/waba/assigned-users', async (req, res) => {
    try {
        const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        const apiVersion = process.env.WHATSAPP_API_VERSION || 'v18.0';
        const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
        if (!accessToken || !wabaId) return res.status(400).json({ success: false, message: 'Configuração incompleta' });

        const response = await axios.get(`https://graph.facebook.com/${apiVersion}/${wabaId}/assigned_users`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            params: { fields: 'id,name,business_role,tasks' }
        });
        res.json({ success: true, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message, details: error.response?.data });
    }
});

// Alternar modo WhatsApp
router.post('/whatsapp/mode', async (req, res) => {
    try {
        const { mode } = req.body;
        const success = await whatsappService.switchMode(mode);
        
        if (success) {
            res.json({ 
                success: true, 
                message: `Modo alterado para ${mode}`,
                newMode: mode
            });
        } else {
            res.status(400).json({
                success: false,
                message: 'Modo inválido. Use "web" ou "business"'
            });
        }
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Alternar modo via GET (facilita automações e testes)
router.get('/whatsapp/mode/:mode', async (req, res) => {
    try {
        const { mode } = req.params;
        const success = await whatsappService.switchMode(mode);
        if (success) {
            res.json({ success: true, message: `Modo alterado para ${mode}`, newMode: mode });
        } else {
            res.status(400).json({ success: false, message: 'Modo inválido. Use "web" ou "business"' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Status do WhatsApp
router.get('/whatsapp/status', (req, res) => {
    const status = whatsappService.getStatus();
    const qrCode = whatsappService.getQRCode();
    
    res.json({
        ...status,
        qrCode
    });
});

// Registrar número no WhatsApp Business – DESCONTINUADO pela Meta (Cloud/On-Prem)
router.post('/whatsapp/register-phone', async (req, res) => {
    return res.status(410).json({
        success: false,
        message: 'Registro de número via API foi descontinuado pela Meta. Adicione/registre o número no WhatsApp Manager (API Setup) e conecte o App na WABA.'
    });
});

// Listar números disponíveis
router.get('/whatsapp/phone-numbers', async (req, res) => {
    try {
        const axios = require('axios');
        const businessAccountId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
        const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        
        const response = await axios.get(
            `https://graph.facebook.com/v18.0/${businessAccountId}/phone_numbers`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );
        
        res.json({ 
            success: true, 
            data: response.data 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message,
            details: error.response?.data
        });
    }
});

// Webhook para WhatsApp Business API
router.get('/whatsapp/webhook', (req, res) => {
    const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // Ajuda a diagnosticar discrepâncias de token durante a verificação do webhook
    console.log('Webhook verify attempt', {
      mode,
      token,
      envToken: verifyToken,
      challenge,
      tokenLength: token ? token.length : null,
      envLength: verifyToken ? verifyToken.length : null,
      equal: token === verifyToken
    });

    if (mode === 'subscribe' && token === verifyToken) {
        console.log('✅ Webhook verificado com sucesso');
        res.status(200).send(challenge);
    } else {
        console.log('❌ Verificação de webhook falhou');
        res.status(403).send('Forbidden');
    }
});

router.post('/whatsapp/webhook', (req, res) => {
    try {
        const signature = req.headers['x-hub-signature-256'];
        console.log('📡 POST webhook recebido', {
            hasSignature: Boolean(signature),
            rawBodyLength: req.rawBody ? req.rawBody.length : null,
            contentType: req.headers['content-type']
        });
        const result = whatsappService.handleWebhook(req.body, signature, req.rawBody);
        res.json(result);
    } catch (error) {
        console.error('Erro no webhook:', error.message, error.stack);
        res.status(400).json({ error: error.message });
    }
});

// Desconectar WhatsApp
router.post('/whatsapp/disconnect', async (req, res) => {
    try {
        await whatsappService.disconnect();
        res.json({ success: true, message: 'WhatsApp desconectado' });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Alias GET para conectar (para facilitar chamadas via browser/curl)
router.get('/whatsapp/connect', async (req, res) => {
    try {
        const result = await whatsappService.initialize();
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ================= On-Premises (Business API On-Prem) =================
// Solicitar código de registro
router.post('/waba-onprem/request-code', async (req, res) => {
    try {
        const onprem = require('../services/whatsapp-onprem');
        const { cc, phone_number, method, cert } = req.body || {};
        const result = await onprem.requestRegistrationCode({ cc, phone_number, method, cert });
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message
        });
    }
});

// Verificar código de registro
router.post('/waba-onprem/verify', async (req, res) => {
    try {
        const onprem = require('../services/whatsapp-onprem');
        const { code, cert, pin, vname } = req.body || {};
        if (!code) {
            return res.status(400).json({ success: false, message: 'Campo "code" é obrigatório' });
        }
        const result = await onprem.verifyRegistrationCode({ code, cert, pin, vname });
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message
        });
    }
});

// Listar agendamentos não confirmados
router.get('/appointments/pending', async (req, res) => {
    try {
        const { date } = req.query; // formato esperado: YYYY-MM-DD
        const appointments = await dbService.getUnconfirmedAppointments(date);
        res.json({ success: true, data: appointments });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Listar todos os agendamentos (confirmados e não confirmados)
router.get('/appointments/all', async (req, res) => {
    try {
        const { date } = req.query; // se informado, filtra pela data (janela do dia); caso contrário, pega futuros
        const appointments = await dbService.getAllAppointments(date);
        res.json({ success: true, data: appointments });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Estatísticas de agendamentos
router.get('/appointments/stats', async (req, res) => {
    try {
        const stats = await dbService.getAppointmentStats();
        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Confirmar agendamento manualmente
router.post('/appointments/:id/confirm', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await dbService.confirmAppointment(id);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// Enviar mensagem para um agendamento específico
router.post('/send/:id', async (req, res) => {
    try {
    const { id } = req.params;
    const { customMessage } = req.body || {};

        // Buscar dados do agendamento
        const appointment = await dbService.getAppointmentById(id);
        if (!appointment) {
            return res.status(404).json({ 
                success: false, 
                message: 'Agendamento não encontrado' 
            });
        }

        // Gerar mensagem
        const message = customMessage || whatsappService.generateMessage(appointment);
        const phone = pickFirstPhone(appointment.patient_contacts) || appointment.patient_contacts;
        
        // Enviar mensagem
        const result = await whatsappService.sendMessage(phone, message);
        // Log envio (se retornou messageId)
        try {
            if (result?.messageId) {
                await dbService.logOutboundMessage({ appointmentId: Number(id), phone, messageId: result.messageId, type: 'text', templateName: null, status: 'sent' });
            }
        } catch (_) {}

        res.json({ 
            success: true, 
            data: { 
                appointment, 
                result 
            } 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message,
            details: error.response?.data
        });
    }
});

// Enviar mensagem de pré-visualização por nome do paciente (útil para testes)
router.post('/send/preview-by-name', async (req, res) => {
    try {
        const { patientName, phone, useTemplateFirst } = req.body || {};
        if (!patientName || !phone) {
            return res.status(400).json({ success: false, message: 'Campos obrigatórios: patientName e phone' });
        }

        const appointment = await dbService.getAppointmentByPatientName(patientName);
        if (!appointment) {
            return res.status(404).json({ success: false, message: 'Nenhum agendamento encontrado para este paciente' });
        }

    // Gerar com o mesmo template de produção (Business), mesmo que o envio seja via Web
    const message = whatsappBusiness.generateMessage(appointment);

        // Se estiver no modo Business (Cloud API), é recomendado abrir janela com template primeiro
        const status = whatsappService.getStatus();
        const shouldTemplate = (status.mode === 'business') && (useTemplateFirst !== false);
        let templateResult = null;
        if (shouldTemplate) {
            try {
                const name = process.env.DEFAULT_CONFIRM_TEMPLATE_NAME || 'confirmao_de_agendamento';
                const lang = process.env.DEFAULT_CONFIRM_TEMPLATE_LOCALE || 'pt_BR';
                let components = [];
                if (name !== 'confirmao_de_agendamento') {
                    const date = new Date(appointment.tratamento_date);
                    const dateBR = date.toLocaleDateString('pt-BR');
                    const timeBR = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                    components = [
                        { type: 'body', parameters: [
                            { type: 'text', text: appointment.patient_name },
                            { type: 'text', text: dateBR },
                            { type: 'text', text: timeBR },
                            { type: 'text', text: appointment.main_procedure_term }
                        ]}
                    ];
                }
                templateResult = await whatsappBusiness.sendTemplateMessage(phone, name, lang, components);
            } catch (e) {
                // Prosseguir mesmo se template falhar; o envio de texto pode falhar se não houver janela aberta
                console.warn('Aviso: falha ao enviar template inicial:', e.response?.data || e.message);
            }
        }

        // Evitar duplicidade: se o template foi enviado com sucesso, não enviar a mensagem de texto
        let sendResult = null;
        if (!templateResult?.success) {
            sendResult = await whatsappService.sendMessage(phone, message);
        }

        res.json({
            success: true,
            data: {
                patientName,
                phone,
                appointment,
                previewMessage: message,
                templateResult,
                sendResult
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message, details: error.response?.data });
    }
});

// Disparo em massa
router.post('/send/bulk', async (req, res) => {
    try {
        const { appointmentIds, customMessage } = req.body;

        if (!appointmentIds || !Array.isArray(appointmentIds)) {
            return res.status(400).json({
                success: false,
                message: 'IDs de agendamentos são obrigatórios'
            });
        }

        // Buscar agendamentos
        const recipients = [];
        for (const id of appointmentIds) {
            const appointment = await dbService.getAppointmentById(id);
            if (appointment && appointment.patient_contacts) {
                const phone = pickFirstPhone(appointment.patient_contacts) || appointment.patient_contacts;
                recipients.push({
                    id: appointment.id,
                    phone,
                    message: customMessage || whatsappService.generateMessage(appointment),
                    patientName: appointment.patient_name
                });
            }
        }

        if (recipients.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Nenhum agendamento válido encontrado'
            });
        }

        // Enviar mensagens
        console.log(`🚀 Iniciando disparo em massa para ${recipients.length} destinatários...`);
        const results = await whatsappService.sendBulkMessages(recipients);
        // Registrar logs para mensagens Business API (onde houver messageId)
        try {
            for (const r of results) {
                if (r.success && r.messageId) {
                    await dbService.logOutboundMessage({ appointmentId: r.id, phone: r.phone, messageId: r.messageId, type: 'text', templateName: null, status: 'sent' });
                }
            }
        } catch (_) {}

        // Contar sucessos e falhas
        const successful = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;

        res.json({
            success: true,
            data: {
                total: recipients.length,
                successful,
                failed,
                results
            }
        });

    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message,
            details: error.response?.data
        });
    }
});

// Batch: status das mensagens por agendamento
router.post('/appointments/status/batch', async (req, res) => {
    try {
        const { appointmentIds } = req.body || {};
        if (!appointmentIds || !Array.isArray(appointmentIds) || appointmentIds.length === 0) {
            return res.status(400).json({ success: false, message: 'appointmentIds é obrigatório' });
        }
        const map = await dbService.getLatestStatusesForAppointments(appointmentIds.map(Number));
        res.json({ success: true, data: map });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Teste de mensagem
router.post('/test', async (req, res) => {
    try {
        const { phone, message } = req.body;

        if (!phone || !message) {
            return res.status(400).json({
                success: false,
                message: 'Telefone e mensagem são obrigatórios'
            });
        }

        const result = await whatsappService.sendMessage(phone, message);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message,
            details: error.response?.data
        });
    }
});

module.exports = router;

// ================= DEBUG (temporário) =================
// Inspeção rápida do schema para ajustar JOINs
router.get('/debug/db-columns', async (req, res) => {
    const { Pool } = require('pg');
    const pool = new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT || 5432,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: false,
    });

    try {
        const client = await pool.connect();

        const queries = {
            sadt: `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sadt' ORDER BY ordinal_position`,
            schedule_v: `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'schedule_v' ORDER BY ordinal_position`,
        };

        const [sadtCols, scheduleVCols] = await Promise.all([
            client.query(queries.sadt).then(r => r.rows),
            client.query(queries.schedule_v).then(r => r.rows).catch(err => ({ error: err.message })),
        ]);

        // Amostras de linhas para inferir chaves
        let sadtSample = [];
        let scheduleVSample = [];
        try {
            sadtSample = (await client.query('SELECT * FROM sadt LIMIT 3')).rows;
        } catch (e) { sadtSample = [{ error: e.message }]; }
        try {
            scheduleVSample = (await client.query('SELECT * FROM schedule_v LIMIT 3')).rows;
        } catch (e) { scheduleVSample = [{ error: e.message }]; }

        client.release();
        await pool.end();

        res.json({
            success: true,
            data: {
                sadt: { columns: sadtCols, sample: sadtSample },
                schedule_v: { columns: scheduleVCols, sample: scheduleVSample },
            }
        });
    } catch (error) {
        try { await pool.end(); } catch {}
        res.status(500).json({ success: false, message: error.message });
    }
});

// Enviar mensagem por template (Cloud API)
router.post('/test-template', async (req, res) => {
    try {
        const { phone, templateName, languageCode } = req.body || {};
        if (!phone) {
            return res.status(400).json({ success: false, message: 'Telefone é obrigatório' });
        }
        const name = templateName || process.env.DEFAULT_CONFIRM_TEMPLATE_NAME || 'confirmacao_personalizada';
        const lang = languageCode || process.env.DEFAULT_CONFIRM_TEMPLATE_LOCALE || 'pt_BR';
        let components = (req.body && Array.isArray(req.body.components)) ? req.body.components : [];
        if ((!components || components.length === 0) && name === (process.env.DEFAULT_CONFIRM_TEMPLATE_NAME || 'confirmacao_personalizada')) {
            const patientName = req.body?.patientName || 'Paciente';
            const dateBR = req.body?.dateBR || new Date().toLocaleDateString('pt-BR');
            const timeBR = req.body?.timeBR || new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            const procedure = req.body?.procedure || 'Exame';
            components = [
                { type: 'body', parameters: [
                    { type: 'text', text: patientName },
                    { type: 'text', text: dateBR },
                    { type: 'text', text: timeBR },
                    { type: 'text', text: procedure }
                ]}
            ];
        }
        const result = await whatsappBusiness.sendTemplateMessage(phone, name, lang, components);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: error.message,
            details: error.response?.data
        });
    }
});

// Enviar template de confirmação por nome do paciente (com variáveis)
router.post('/send/confirm-template-by-name', async (req, res) => {
    try {
        const { patientName, phone, templateName } = req.body || {};
        if (!patientName || !phone) {
            return res.status(400).json({ success: false, message: 'Campos obrigatórios: patientName e phone' });
        }

        const appointment = await dbService.getAppointmentByPatientName(patientName);
        if (!appointment) {
            return res.status(404).json({ success: false, message: 'Nenhum agendamento encontrado para este paciente' });
        }

        const date = new Date(appointment.tratamento_date);
        const dateBR = date.toLocaleDateString('pt-BR');
        const timeBR = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

        const name = templateName || (process.env.DEFAULT_CONFIRM_TEMPLATE_NAME || 'confirmao_de_agendamento');
        let components = [];
        if (name !== 'confirmao_de_agendamento') {
            components = [
                {
                    type: 'body',
                    parameters: [
                        { type: 'text', text: appointment.patient_name },
                        { type: 'text', text: dateBR },
                        { type: 'text', text: timeBR },
                        { type: 'text', text: appointment.main_procedure_term }
                    ]
                }
            ];
        }

        const result = await whatsappBusiness.sendTemplateMessage(phone, name, 'pt_BR', components);
        try {
            if (result?.messageId) {
                await dbService.logOutboundMessage({ appointmentId: appointment.id, phone, messageId: result.messageId, type: 'template', templateName: name, status: 'sent' });
            }
        } catch (_) {}
        return res.json({ success: true, data: { patientName, phone, appointment, components, result } });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message, details: error.response?.data });
    }
});

// Enviar template de confirmação por ID do agendamento
router.post('/send/confirm-template/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { templateName } = req.body || {};

        const appointment = await dbService.getAppointmentById(id);
        if (!appointment) {
            return res.status(404).json({ success: false, message: 'Agendamento não encontrado' });
        }

        const phone = pickFirstPhone(appointment.patient_contacts) || appointment.patient_contacts;
        if (!phone) {
            return res.status(400).json({ success: false, message: 'Paciente sem telefone válido' });
        }

        const date = new Date(appointment.tratamento_date);
        const dateBR = date.toLocaleDateString('pt-BR');
        const timeBR = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

        const name = templateName || (process.env.DEFAULT_CONFIRM_TEMPLATE_NAME || 'confirmao_de_agendamento');
        let components = [];
        if (name !== 'confirmao_de_agendamento') {
            components = [
                {
                    type: 'body',
                    parameters: [
                        { type: 'text', text: appointment.patient_name },
                        { type: 'text', text: dateBR },
                        { type: 'text', text: timeBR },
                        { type: 'text', text: appointment.main_procedure_term }
                    ]
                }
            ];
        }

        const result = await whatsappBusiness.sendTemplateMessage(phone, name, 'pt_BR', components);
        try {
            if (result?.messageId) {
                await dbService.logOutboundMessage({ appointmentId: appointment.id, phone, messageId: result.messageId, type: 'template', templateName: name, status: 'sent' });
            }
        } catch (_) {}
        return res.json({ success: true, data: { appointment, phone, components, result } });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message, details: error.response?.data });
    }
});

// Alias GET para facilitar testes/evitar 404 acidentais
router.get('/send/confirm-template/:id', async (req, res) => {
    // Reusa a lógica do POST chamando o handler acima indiretamente
    req.body = req.body || {};
    const postHandler = router.stack.find(r => r.route && r.route.path === '/send/confirm-template/:id' && r.route.methods.post);
    if (postHandler && postHandler.handle) {
        return postHandler.handle(req, res);
    }
    return res.status(500).json({ success: false, message: 'Handler não encontrado' });
});

// Disparo em massa usando template de confirmação
router.post('/send/bulk-template', async (req, res) => {
    try {
        const { appointmentIds, templateName } = req.body || {};
        if (!appointmentIds || !Array.isArray(appointmentIds) || appointmentIds.length === 0) {
            return res.status(400).json({ success: false, message: 'IDs de agendamentos são obrigatórios' });
        }

    const name = templateName || (process.env.DEFAULT_CONFIRM_TEMPLATE_NAME || 'confirmao_de_agendamento');
        const results = [];

        for (let i = 0; i < appointmentIds.length; i++) {
            const id = appointmentIds[i];
            try {
                const appointment = await dbService.getAppointmentById(id);
                if (!appointment) {
                    results.push({ id, success: false, error: 'Agendamento não encontrado' });
                    continue;
                }
                const phone = pickFirstPhone(appointment.patient_contacts) || appointment.patient_contacts;
                if (!phone) {
                    results.push({ id, success: false, error: 'Paciente sem telefone válido' });
                    continue;
                }
                let components = [];
                if (name !== 'confirmao_de_agendamento') {
                    const date = new Date(appointment.tratamento_date);
                    const dateBR = date.toLocaleDateString('pt-BR');
                    const timeBR = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                    components = [
                        {
                            type: 'body',
                            parameters: [
                                { type: 'text', text: appointment.patient_name },
                                { type: 'text', text: dateBR },
                                { type: 'text', text: timeBR },
                                { type: 'text', text: appointment.main_procedure_term }
                            ]
                        }
                    ];
                }

                const result = await whatsappBusiness.sendTemplateMessage(phone, name, 'pt_BR', components);
                results.push({ id, success: true, messageId: result.messageId, phone, appointment });
                try {
                    if (result?.messageId) {
                        await dbService.logOutboundMessage({ appointmentId: appointment.id, phone, messageId: result.messageId, type: 'template', templateName: name, status: 'sent' });
                    }
                } catch (_) {}

                // Intervalo para evitar rate limiting
                if (i < appointmentIds.length - 1) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            } catch (err) {
                results.push({ id, success: false, error: err.response?.data || err.message });
            }
        }

        const successful = results.filter(r => r.success).length;
        const failed = results.length - successful;
        return res.json({ success: true, data: { total: results.length, successful, failed, results } });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message, details: error.response?.data });
    }
});

// Resposta explícita para GET em /send/bulk-template (evitar 404 confuso)
router.get('/send/bulk-template', (req, res) => {
    res.status(405).json({ success: false, message: 'Use POST em /send/bulk-template com { appointmentIds: number[] }' });
});

// ================= Cloud API - Diagnóstico WABA/App =================
router.get('/whatsapp/diagnostics', async (req, res) => {
    try {
        const axios = require('axios');
        const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        const apiVersion = process.env.WHATSAPP_API_VERSION || 'v18.0';
        const baseURL = `https://graph.facebook.com/${apiVersion}`;

        // Trazer visão geral: usuário, businesses, WABAs, números e apps inscritos
        const fields = [
            'id',
            'name',
            'businesses{id,name,owned_whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name,code_verification_status,platform_type,throughput},subscribed_apps{id,name}}}'
        ].join(',');

        const meResp = await axios.get(`${baseURL}/me`, {
            params: { fields },
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        res.json({ success: true, data: meResp.data });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
            details: error.response?.data
        });
    }
});

// Configuração efetiva carregada no processo (para diagnóstico rápido)
router.get('/whatsapp/config', (req, res) => {
    const token = process.env.WHATSAPP_ACCESS_TOKEN || '';
    const masked = token ? `${token.slice(0, 8)}...${token.slice(-6)}` : null;
    res.json({
        success: true,
        data: {
            mode: process.env.WHATSAPP_MODE,
            phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID,
            wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
            apiVersion: process.env.WHATSAPP_API_VERSION,
            tokenPreview: masked
        }
    });
});

// ================= Diagnostics WhatsApp Cloud API =================
// Verificar informações do token (app_id, scopes, expiração)
router.get('/whatsapp/debug-token', async (req, res) => {
    try {
        const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        const apiVersion = process.env.WHATSAPP_API_VERSION || 'v18.0';
        if (!accessToken) return res.status(400).json({ success: false, message: 'Token não configurado' });

        const response = await axios.get(`https://graph.facebook.com/${apiVersion}/debug_token`, {
            params: { input_token: accessToken, access_token: accessToken }
        });
        res.json({ success: true, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message, details: error.response?.data });
    }
});

// Listar apps inscritos (se suportado) na WABA
router.get('/whatsapp/waba/subscribed-apps', async (req, res) => {
    try {
        const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        const apiVersion = process.env.WHATSAPP_API_VERSION || 'v18.0';
        const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
        if (!accessToken || !wabaId) return res.status(400).json({ success: false, message: 'Configuração incompleta' });

        const response = await axios.get(`https://graph.facebook.com/${apiVersion}/${wabaId}/subscribed_apps`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        res.json({ success: true, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message, details: error.response?.data });
    }
});

// Listar templates da WABA (valida permissão de messaging/management)
router.get('/whatsapp/waba/templates', async (req, res) => {
    try {
        const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        const apiVersion = process.env.WHATSAPP_API_VERSION || 'v18.0';
        const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
        if (!accessToken || !wabaId) return res.status(400).json({ success: false, message: 'Configuração incompleta' });

        const response = await axios.get(`https://graph.facebook.com/${apiVersion}/${wabaId}/message_templates`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        res.json({ success: true, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message, details: error.response?.data });
    }
});

// Pré-checagem consolidada (Cloud API): valida token, app conectado, número e plataforma
router.get('/whatsapp/preflight', async (req, res) => {
    try {
        const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        const apiVersion = process.env.WHATSAPP_API_VERSION || 'v18.0';
        const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
        const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
        const baseURL = `https://graph.facebook.com/${apiVersion}`;
        if (!accessToken || !wabaId || !phoneId) {
            return res.status(400).json({ success: false, message: 'Defina WHATSAPP_ACCESS_TOKEN, WHATSAPP_BUSINESS_ACCOUNT_ID e WHATSAPP_PHONE_NUMBER_ID no .env' });
        }

        // 1) Token → app_id e scopes
        const dbg = await axios.get(`${baseURL}/debug_token`, {
            params: { input_token: accessToken, access_token: accessToken }
        }).then(r => r.data?.data);
        const appId = dbg?.app_id;
        const scopes = dbg?.scopes || [];

        // 2) WABA → apps conectados
        const subs = await axios.get(`${baseURL}/${wabaId}/subscribed_apps`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        }).then(r => r.data?.data || []);
        const appConnected = !!subs.find(s => (s.whatsapp_business_api_data?.id || s.id) === appId);

        // 3) Phone info → plataforma
        const phone = await axios.get(`${baseURL}/${phoneId}`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        }).then(r => r.data);
    const platformType = phone.platform_type || 'UNKNOWN';

        // 4) Templates (só para confirmar leitura)
        const templates = await axios.get(`${baseURL}/${wabaId}/message_templates`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        }).then(r => (r.data?.data || []).length).catch(() => null);

        const hasMessaging = scopes.includes('whatsapp_business_messaging');
        const hasManagement = scopes.includes('whatsapp_business_management');

        const checks = {
            appId,
            appConnected,
            platformType,
            hasMessaging,
            hasManagement,
            phoneId,
            wabaId,
            templatesCount: templates
        };

        const problems = [];
    if (!hasMessaging) problems.push('Token sem escopo whatsapp_business_messaging');
    if (!hasManagement) problems.push('Token sem escopo whatsapp_business_management');
    if (!appConnected) problems.push('App não está conectado à WABA (Connected apps)');
    const isCloud = ['CLOUD', 'CLOUD_API'].includes(String(platformType).toUpperCase());
    if (!isCloud) problems.push('Número não está na plataforma CLOUD (migre para Cloud API no WhatsApp Manager)');

    res.json({ success: problems.length === 0, data: { checks, problems, phone } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message, details: error.response?.data });
    }
});

// Assinar o app na WABA para webhooks/mensagens (pode ser necessário em alguns tenants)
router.post('/whatsapp/waba/subscribe', async (req, res) => {
    try {
        const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        const apiVersion = process.env.WHATSAPP_API_VERSION || 'v18.0';
        const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
        if (!accessToken || !wabaId) return res.status(400).json({ success: false, message: 'Configuração incompleta' });

        const payload = { subscribed_fields: ['messages'] };
        const response = await axios.post(`https://graph.facebook.com/${apiVersion}/${wabaId}/subscribed_apps`, payload, {
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
        });
        res.json({ success: true, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message, details: error.response?.data });
    }
});

// Info do número (phone_number_id)
router.get('/whatsapp/phone-info', async (req, res) => {
    try {
        const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        const apiVersion = process.env.WHATSAPP_API_VERSION || 'v18.0';
        const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
        if (!accessToken || !phoneId) return res.status(400).json({ success: false, message: 'Configuração incompleta' });

        const response = await axios.get(`https://graph.facebook.com/${apiVersion}/${phoneId}`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        res.json({ success: true, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message, details: error.response?.data });
    }
});

// Info do App (descoberto via debug_token)
router.get('/whatsapp/app', async (req, res) => {
    try {
        const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        const apiVersion = process.env.WHATSAPP_API_VERSION || 'v18.0';
        if (!accessToken) return res.status(400).json({ success: false, message: 'Token não configurado' });

        const dbg = await axios.get(`https://graph.facebook.com/${apiVersion}/debug_token`, {
            params: { input_token: accessToken, access_token: accessToken }
        });
        const appId = dbg.data?.data?.app_id;
        if (!appId) return res.status(400).json({ success: false, message: 'app_id não encontrado no token' });

        const app = await axios.get(`https://graph.facebook.com/${apiVersion}/${appId}`, {
            params: { fields: 'id,name,link,app_type,business' },
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        res.json({ success: true, data: app.data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message, details: error.response?.data });
    }
});

// Info da WABA (owner_business)
router.get('/whatsapp/waba/info', async (req, res) => {
    try {
        const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        const apiVersion = process.env.WHATSAPP_API_VERSION || 'v18.0';
        const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
        if (!accessToken || !wabaId) return res.status(400).json({ success: false, message: 'Configuração incompleta' });

        const info = await axios.get(`https://graph.facebook.com/${apiVersion}/${wabaId}`, {
            params: { fields: 'id,name,owner_business' },
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        res.json({ success: true, data: info.data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message, details: error.response?.data });
    }
});

// Usuários atribuídos à WABA (para checar System User e tarefas)
// (removido) rota duplicada de assigned-users