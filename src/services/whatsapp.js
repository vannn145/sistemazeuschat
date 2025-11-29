const puppeteer = require('puppeteer');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { formatClinicDateTime } = require('../utils/datetime');

class WhatsAppService {
    constructor() {
        this.browser = null;
        this.page = null;
        this.isConnected = false;
        this.qrCode = null;
        this.sessionPath = process.env.WHATSAPP_SESSION_PATH || './whatsapp-session';
        this.chromePath = process.env.CHROME_PATH || null; // Caminho do Chrome (opcional)
        this.headless = (process.env.WHATSAPP_HEADLESS || 'false').toLowerCase() === 'true';
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async tryConnectExisting() {
        try {
            const devtoolsFile = path.join(this.sessionPath, 'DevToolsActivePort');
            if (!fs.existsSync(devtoolsFile)) return false;

            const content = fs.readFileSync(devtoolsFile, 'utf8').trim();
            const [portLine] = content.split(/\r?\n/);
            const port = parseInt(portLine, 10);
            if (!port) return false;

            // Obter o endpoint WebSocket do DevTools
            const { data } = await axios.get(`http://127.0.0.1:${port}/json/version`, { timeout: 2000 });
            const wsEndpoint = data && data.webSocketDebuggerUrl;
            if (!wsEndpoint) return false;

            this.browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: { width: 1280, height: 800 } });
            const pages = await this.browser.pages();
            this.page = pages && pages.length ? pages[0] : await this.browser.newPage();
            try { await this.page.bringToFront(); } catch (_) {}
            console.log('🔗 Conectado ao navegador existente (whatsapp-session).');
            return true;
        } catch (err) {
            console.warn('⚠️  Não foi possível conectar ao navegador existente:', err.message);
            return false;
        }
    }

    async initialize() {
        try {
            console.log('🔄 Inicializando WhatsApp Web...');
            // Primeiro, tente conectar ao navegador já aberto usando o mesmo perfil
            const attached = await this.tryConnectExisting();
            if (attached) {
                await this.page.goto('https://web.whatsapp.com', {
                    waitUntil: 'networkidle2',
                    timeout: 180000
                });
                await this.sleep(3000);
                const isLoggedIn = await this.checkIfLoggedIn();
                if (isLoggedIn) {
                    console.log('✅ WhatsApp já está conectado (sessão existente)!');
                    this.isConnected = true;
                    return { success: true, message: 'WhatsApp conectado' };
                }
                console.log('📱 Sessão existente sem login. Solicitando QR...');
                return await this.waitForQRCode();
            }
            const launchArgs = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ];

            const launchOptions = {
                headless: this.headless ? 'new' : false, // false para depurar; 'new' em servidores sem GUI
                args: launchArgs,
                userDataDir: this.sessionPath,
                defaultViewport: { width: 1280, height: 800 },
                ignoreHTTPSErrors: true
            };

            if (this.chromePath) {
                launchOptions.executablePath = this.chromePath;
            }

            try {
                this.browser = await puppeteer.launch(launchOptions);
            } catch (e1) {
                // Se já existir um navegador usando o mesmo perfil, tente conectar a ele
                const msg = (e1 && e1.message) || '';
                if (/already running/i.test(msg) || /profile.*in use/i.test(msg)) {
                    console.warn('⚠️  Perfil já em uso. Tentando conectar na instância existente...');
                    const attachedNow = await this.tryConnectExisting();
                    if (attachedNow) {
                        this.page = this.page || (await this.browser.newPage());
                    } else {
                        throw e1;
                    }
                } else {
                    console.warn('⚠️  Falha ao iniciar com headless=%s, tentando alternativo...', launchOptions.headless);
                    // Tentar modo alternativo de headless
                    this.browser = await puppeteer.launch({ ...launchOptions, headless: this.headless ? true : 'new' });
                }
            }

            this.page = await this.browser.newPage();
            await this.page.goto('https://web.whatsapp.com', {
                waitUntil: 'networkidle2',
                timeout: 180000
            });

            // Aguardar carregamento da página
            await this.sleep(5000);

            // Verificar se já está logado
            const isLoggedIn = await this.checkIfLoggedIn();

            if (isLoggedIn) {
                console.log('✅ WhatsApp já está conectado!');
                this.isConnected = true;
                return { success: true, message: 'WhatsApp conectado' };
            } else {
                console.log('📱 Aguardando QR Code...');
                return await this.waitForQRCode();
            }

        } catch (error) {
            console.error('❌ Erro ao inicializar WhatsApp:', error);
            throw error;
        }
    }

    async checkIfLoggedIn() {
        try {
            // Aguardar um dos elementos aparecer (QR code ou chat list)
            await this.page.waitForSelector('canvas[aria-label="Scan me!"], [data-testid="chat-list"]', {
                timeout: 60000
            });

            // Verificar se existe a lista de chats (indicando que está logado)
            const chatList = await this.page.$('[data-testid="chat-list"]');
            return !!chatList;
        } catch (error) {
            return false;
        }
    }

    async waitForQRCode() {
        try {
                // Aguardar QR code aparecer (tentar seletor alternativo se necessário)
                const qrSelectors = [
                    'canvas[aria-label="Scan me!"]',
                    'canvas[aria-label*="Escaneie" i]',
                    'canvas[aria-label*="Scan" i]'
                ];

                let qrElement = null;
                for (const sel of qrSelectors) {
                    try {
                        await this.page.waitForSelector(sel, { timeout: 15000 });
                        qrElement = await this.page.$(sel);
                        if (qrElement) break;
                    } catch (_) { /* tenta próximo seletor */ }
                }
                if (!qrElement) {
                    throw new Error('QR Code não encontrado. Atualize a página e tente novamente.');
                }

                // Capturar QR code
                const qrImage = await qrElement.screenshot();
            
            // Converter para base64
            this.qrCode = `data:image/png;base64,${qrImage.toString('base64')}`;
            
            console.log('📱 QR Code gerado. Escaneie com seu WhatsApp.');

            // Aguardar login (verificar se QR code desaparece)
            await this.page.waitForFunction(() => {
                const sel = [
                    'canvas[aria-label="Scan me!"]',
                    'canvas[aria-label*="Escaneie" i]',
                    'canvas[aria-label*="Scan" i]'
                ];
                return !sel.some(s => document.querySelector(s));
            }, { timeout: 120000 });

            // Aguardar carregamento completo
            await this.page.waitForSelector('[data-testid="chat-list"]', { timeout: 60000 });
            
            this.isConnected = true;
            this.qrCode = null;
            console.log('✅ WhatsApp conectado com sucesso!');
            
            return { success: true, message: 'WhatsApp conectado' };
        } catch (error) {
            console.error('❌ Erro ao processar QR Code:', error);
            // Em vez de falhar direto, retornar instrução para escanear novamente via UI
            return { success: false, message: 'Timeout ou erro ao conectar WhatsApp. Tente novamente e escaneie o QR.', needsScan: true, qrCode: this.qrCode };
        }
    }

    async sendMessage(phoneNumber, message) {
        if (!this.isConnected || !this.page) {
            throw new Error('WhatsApp não está conectado');
        }
        try {
            // Limpar número (remover caracteres especiais)
            const cleanNumber = phoneNumber.replace(/\D/g, '');
            
            // Navegar para o chat
            const url = `https://web.whatsapp.com/send?phone=${cleanNumber}`;
            await this.page.goto(url, { waitUntil: 'networkidle2' });

            // Aguardar carregamento
            await this.sleep(3000);

            // Verificar se o número é válido
            const invalidNumber = await this.page.$('[data-testid="invalid-number"]');
            if (invalidNumber) {
                throw new Error(`Número inválido: ${phoneNumber}`);
            }

            // Aguardar caixa de mensagem (tentar seletores alternativos)
            const inputSelectors = [
                '[data-testid="conversation-compose-box-input"]',
                'div[contenteditable="true"][data-testid="conversation-compose-box-input"]',
                'div[contenteditable="true"][role="textbox"]',
                'div[contenteditable="true"][aria-label*="mensagem" i]',
                'div[contenteditable="true"][aria-label*="message" i]'
            ];

            let inputHandle = null;
            for (const sel of inputSelectors) {
                try {
                    await this.page.waitForSelector(sel, { timeout: 8000 });
                    inputHandle = await this.page.$(sel);
                    if (inputHandle) break;
                } catch (_) { /* tenta próximo seletor */ }
            }

            if (!inputHandle) {
                throw new Error('Não foi possível localizar a caixa de mensagem do WhatsApp Web');
            }

            // Focar e digitar mensagem (usando inputHandle)
            await inputHandle.focus();
            await this.page.keyboard.type(message, { delay: 10 });

            // Enviar: preferir ENTER para evitar mudanças no botão de envio
            await this.page.keyboard.press('Enter');
            
            // Aguardar envio
            await this.page.waitForTimeout(2000);

            console.log(`✅ Mensagem enviada para ${phoneNumber}`);
            return { success: true, phone: phoneNumber };

        } catch (error) {
            console.error(`❌ Erro ao enviar mensagem para ${phoneNumber}:`, error);
            throw error;
        }
    }

    async sendBulkMessages(recipients) {
        const results = [];
        
        for (let i = 0; i < recipients.length; i++) {
            const recipient = recipients[i];
            
            try {
                console.log(`📤 Enviando ${i + 1}/${recipients.length} para ${recipient.phone}`);
                
                await this.sendMessage(recipient.phone, recipient.message);
                results.push({
                    ...recipient,
                    success: true,
                    error: null
                });

                // Intervalo entre mensagens (evitar spam)
                if (i < recipients.length - 1) {
                    console.log('⏱️ Aguardando intervalo...');
                    await this.sleep(3000); // 3 segundos entre mensagens
                }

            } catch (error) {
                results.push({
                    ...recipient,
                    success: false,
                    error: error.message
                });
            }
        }

        return results;
    }

    getQRCode() {
        return this.qrCode;
    }

    getStatus() {
        return {
            isConnected: this.isConnected,
            hasQRCode: !!this.qrCode
        };
    }

    async disconnect() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
            this.isConnected = false;
            this.qrCode = null;
            console.log('🔌 WhatsApp desconectado');
        }
    }

    generateMessage(appointment) {
        const { date: formattedDate, time: formattedTime } = formatClinicDateTime(appointment.tratamento_date);

        return `🏥 *Confirmação de Agendamento*

Olá *${appointment.patient_name}*!

Você tem um agendamento marcado:
📅 *Data:* ${formattedDate}
🕐 *Horário:* ${formattedTime}
🔬 *Procedimento:* ${appointment.main_procedure_term}

Para confirmar seu agendamento, responda *SIM*.
Para reagendar, entre em contato conosco.

_Esta é uma mensagem automática do sistema de agendamentos._`;
    }
}

module.exports = new WhatsAppService();