// Endpoint temporário para testar getAppointmentStats
// ...existing code...
// Endpoint temporário para testar getAppointmentStats
const express = require('express');
const cors = require('cors');
const path = require('path');
// Forçar que as variáveis do .env sobrescrevam variáveis de ambiente já definidas
require('dotenv').config({ override: true });

const dbService = require('./src/services/database');
const whatsappService = require('./src/services/whatsapp-hybrid');
const cronService = require('./src/services/cron');
const messageRoutes = require('./src/routes/messages');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Middleware
app.use(cors());
app.use(express.json({
    limit: process.env.BODY_LIMIT || '2mb',
    verify: (req, res, buf) => {
        // Guardar corpo bruto para verificar assinatura do webhook
        req.rawBody = buf.toString();
    }
}));
app.use(express.static('public'));

// Routes
app.use('/api/messages', messageRoutes);
// Expor rota de confirmações recentes diretamente em /api/confirmations/recent
app.get('/api/confirmations/recent', (req, res) => {
    // Acessa o array do router
    if (messageRoutes.confirmationsLog) {
        res.json({ success: true, data: messageRoutes.confirmationsLog.slice(-20) });
    } else {
        res.json({ success: true, data: [] });
    }
});

// Rota principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Página pública: Política de Privacidade (requerido pela Meta)
app.get(['/privacy', '/politica-de-privacidade', '/privacy-policy'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

// Healthcheck simples para load balancer / monitoramento
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Inicialização do servidor
async function startServer() {
    // Teste direto dos métodos do dbService
    console.log('Testando métodos dbService...');
    console.log('getUnconfirmedAppointments:', typeof dbService.getUnconfirmedAppointments);
    console.log('getAppointmentStats:', typeof dbService.getAppointmentStats);
    try {
        console.log('🚀 Iniciando Sistema de Disparo WhatsApp...');
        // Log rápido de configuração ativa para evitar confusão de ambiente
        console.log('⚙️  Config WhatsApp em uso:', {
            MODE: process.env.WHATSAPP_MODE,
            PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
            WABA_ID: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
            API_VERSION: process.env.WHATSAPP_API_VERSION
        });
        
        // Testar conexão com banco (opcional)
        try {
            await dbService.testConnection();
            console.log('✅ Conexão com banco PostgreSQL estabelecida');
        } catch (dbError) {
            console.log('⚠️  Banco PostgreSQL não conectado - funcionará em modo demo');
            console.log('💡 Configure o .env para conectar ao banco real');
        }
        
        // Inicializar WhatsApp (sem conectar automaticamente)
        console.log('📱 Serviço WhatsApp inicializado');
        
        app.listen(PORT, HOST, () => {
            const publicHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
            console.log(`🌐 Servidor rodando em http://${publicHost}:${PORT}`);
            console.log('📋 Interface de controle disponível na página inicial');
            console.log(`🔗 Acesse: http://${publicHost}:${PORT}`);
            // Iniciar cron se habilitado
            if (String(process.env.CRON_ENABLED || 'false').toLowerCase() === 'true') {
                const started = cronService.start();
                if (started) {
                    console.log('⏱️  Cron habilitado. Intervalo(ms):', process.env.CRON_INTERVAL_MS || 60000);
                }
            } else {
                console.log('⏸️  Cron desabilitado (defina CRON_ENABLED=true para ativar).');
            }
        });
        
    } catch (error) {
        console.error('❌ Erro ao iniciar servidor:', error);
        process.exit(1);
    }
}

startServer();