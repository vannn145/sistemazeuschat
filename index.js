// Endpoint temporário para testar getAppointmentStats
// ...existing code...
// Endpoint temporário para testar getAppointmentStats
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const session = require('express-session');

let PgSession = null;
try {
    PgSession = require('connect-pg-simple')(session);
} catch (pgStoreError) {
    console.warn('⚠️  Módulo connect-pg-simple indisponível; armazenamento de sessão em PostgreSQL será ignorado.', pgStoreError.message);
}
// Forçar que as variáveis do .env sobrescrevam variáveis de ambiente já definidas
require('dotenv').config({ override: true });

const dbService = require('./src/services/database');
const whatsappService = require('./src/services/whatsapp-hybrid');
const cronService = require('./src/services/cron');
const retryCronService = require('./src/services/retry-cron');
const reminderCronService = require('./src/services/reminder-cron');
const messageRoutes = require('./src/routes/messages');
const adminRoutes = require('./src/routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_ASSETS_DIR = path.join(__dirname, 'public', 'admin');

// Middleware
app.use(cors());
app.use('/admin/assets', express.static(ADMIN_ASSETS_DIR));
app.use(express.json({
    limit: process.env.BODY_LIMIT || '2mb',
    verify: (req, res, buf) => {
        // Guardar corpo bruto para verificar assinatura do webhook
        req.rawBody = buf.toString();
    }
}));

const sessionSecret = process.env.ADMIN_SESSION_SECRET || 'zeus-chat-session-secret';
if (!process.env.ADMIN_SESSION_SECRET) {
    console.warn('⚠️  ADMIN_SESSION_SECRET não configurado; usando valor padrão (não recomendado em produção).');
}

const storePreference = String(process.env.ADMIN_SESSION_STORE || 'file').toLowerCase();
let sessionStore = null;
let resolvedStore = storePreference;

if (resolvedStore === 'db') {
    if (!PgSession) {
        console.warn('⚠️  Store de sessão em PostgreSQL solicitado, mas dependência não está carregada. Recuando para store em arquivo.');
        resolvedStore = 'file';
    } else {
        try {
            sessionStore = new PgSession({
                pool: dbService.pool,
                schemaName: process.env.DB_SCHEMA || 'public',
                tableName: process.env.ADMIN_SESSION_TABLE || 'zeuschat_sessions',
                createTableIfMissing: String(process.env.ADMIN_SESSION_CREATE_TABLE || 'false').toLowerCase() === 'true'
            });
            console.log('🗄️  Sessões administrativas persistidas no PostgreSQL.');
        } catch (storeError) {
            sessionStore = null;
            resolvedStore = 'file';
            console.error('⚠️  Falha ao inicializar store de sessão no PostgreSQL; recuando para filesystem.', storeError.message);
        }
    }
}

if (resolvedStore !== 'db') {
    try {
        const FileStore = require('session-file-store')(session);
        const sessionsDir = process.env.ADMIN_SESSION_DIR
            ? (path.isAbsolute(process.env.ADMIN_SESSION_DIR)
                ? process.env.ADMIN_SESSION_DIR
                : path.join(__dirname, process.env.ADMIN_SESSION_DIR))
            : path.join(__dirname, 'sessions');
        fs.mkdirSync(sessionsDir, { recursive: true });
        sessionStore = new FileStore({
            path: sessionsDir,
            retries: 1,
            fileExtension: '.json'
        });
        console.log('🗃️  Sessões administrativas persistidas no filesystem:', sessionsDir);
    } catch (fileStoreError) {
        sessionStore = null;
        console.error('⚠️  Falha ao inicializar store de sessão no filesystem; usando MemoryStore temporariamente.', fileStoreError.message);
    }
}

const sessionOptions = {
    name: 'zeuschat.sid',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: Number(process.env.ADMIN_SESSION_MAX_AGE || 1000 * 60 * 60 * 8)
    }
};

if (sessionStore) {
    sessionOptions.store = sessionStore;
}

app.use(session(sessionOptions));
app.use('/admin', adminRoutes);
app.use(express.static('public'));
// Routes
app.use('/api/messages', messageRoutes);
app.use('/admin', adminRoutes);
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

            if (retryCronService.isEnabled()) {
                const startedRetry = retryCronService.start();
                if (startedRetry) {
                    console.log('♻️  Retry Cron habilitado. Intervalo(ms):', process.env.RETRY_CRON_INTERVAL_MS || 300000);
                }
            } else {
                console.log('⏸️  Retry Cron desabilitado (defina RETRY_CRON_ENABLED=true para ativar).');
            }

            if (reminderCronService.isEnabled()) {
                const startedReminder = reminderCronService.start();
                if (startedReminder) {
                    console.log('⏰  Reminder Cron habilitado. Intervalo(ms):', process.env.REMINDER_CRON_INTERVAL_MS || 300000);
                }
            } else {
                console.log('⏸️  Reminder Cron desabilitado (defina REMINDER_CRON_ENABLED=true para ativar).');
            }
        });
        
    } catch (error) {
        console.error('❌ Erro ao iniciar servidor:', error);
        process.exit(1);
    }
}

startServer();