const whatsappWeb = require('./whatsapp');
const whatsappBusiness = require('./whatsapp-business');

class WhatsAppHybridService {
    constructor() {
        this.mode = process.env.WHATSAPP_MODE || 'web'; // 'web' ou 'business'
        this.activeService = null;
        this.initializeService();
    }

    initializeService() {
        if (this.mode === 'business') {
            this.activeService = whatsappBusiness;
            console.log('📱 Usando WhatsApp Business API');
        } else {
            this.activeService = whatsappWeb;
            console.log('🌐 Usando WhatsApp Web (Puppeteer)');
        }
    }

    async switchMode(newMode) {
        if (['web', 'business'].includes(newMode)) {
            this.mode = newMode;
            this.initializeService();
            console.log(`🔄 Modo alterado para: ${newMode}`);
            return true;
        }
        return false;
    }

    async initialize() {
        if (this.mode === 'business') {
            try {
                await this.activeService.verifyConfiguration();
                return { success: true, mode: 'business', message: 'WhatsApp Business API configurado' };
            } catch (error) {
                console.log('⚠️  Erro no Business API, tentando Web...');
                this.mode = 'web';
                this.initializeService();
                return await this.activeService.initialize();
            }
        } else {
            return await this.activeService.initialize();
        }
    }

    async sendMessage(phoneNumber, message) {
        return await this.activeService.sendMessage(phoneNumber, message);
    }

    async sendBulkMessages(recipients) {
        return await this.activeService.sendBulkMessages(recipients);
    }

    async sendTemplateMessage(...args) {
        if (this.mode !== 'business' || typeof this.activeService?.sendTemplateMessage !== 'function') {
            throw new Error('Envio de template disponível apenas no modo WhatsApp Business');
        }
        return this.activeService.sendTemplateMessage(...args);
    }

    async listTemplates(options = {}) {
        if (this.mode !== 'business' || typeof this.activeService?.listTemplates !== 'function') {
            throw new Error('Listagem de templates disponível apenas no modo WhatsApp Business');
        }
        return this.activeService.listTemplates(options);
    }

    generateMessage(appointment) {
        return this.activeService.generateMessage(appointment);
    }

    getStatus() {
        const baseStatus = this.activeService.getStatus();
        return {
            ...baseStatus,
            mode: this.mode,
            serviceType: this.mode === 'business' ? 'WhatsApp Business API' : 'WhatsApp Web'
        };
    }

    getQRCode() {
        if (this.mode === 'web') {
            return this.activeService.getQRCode();
        }
        return null;
    }

    async disconnect() {
        if (this.activeService && this.activeService.disconnect) {
            await this.activeService.disconnect();
        }
    }

    // Para webhooks do Business API
    handleWebhook(body, signature, rawBody) {
        if (this.mode === 'business') {
            return this.activeService.handleWebhook(body, signature, rawBody);
        }
        throw new Error('Webhooks apenas disponíveis no modo Business API');
    }
}

module.exports = new WhatsAppHybridService();