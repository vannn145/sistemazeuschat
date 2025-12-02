# Sistema de Disparo WhatsApp

Sistema automatizado para envio de mensagens via WhatsApp Web para agendamentos médicos, integrado com banco PostgreSQL.

## 🚀 Características

- **Automação WhatsApp Web** via Puppeteer
- **Integração PostgreSQL** para buscar agendamentos
- **Interface Web Responsiva** para controle e monitoramento
- **Disparo em Massa** com controle de intervalo
- **Sistema de Confirmação** integrado ao banco
- **Mensagens Personalizáveis** com template padrão

## 📋 Pré-requisitos

- Node.js (v18+)
- PostgreSQL com as tabelas configuradas
- Chrome/Chromium instalado
- Conexão com o banco de dados

## 🏗️ Estrutura do Projeto

```
disparador/
├── .env                    # Configurações do ambiente
├── .github/
│   └── copilot-instructions.md
├── index.js               # Servidor principal
├── package.json           # Dependências e scripts
├── public/                # Interface web
│   ├── index.html        # Página principal
│   └── app.js            # JavaScript da interface
└── src/
    ├── routes/
    │   └── messages.js   # Rotas da API
    └── services/
        ├── database.js   # Serviço PostgreSQL
        └── whatsapp.js   # Serviço WhatsApp Web
```

## 🗃️ Estrutura do Banco

### Tabela `sadt`
```sql
CREATE TABLE sadt (
    id SERIAL PRIMARY KEY,
    patient_name VARCHAR(255),
    tratamento_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
```

### Tabela `schedule_v`
```sql
CREATE TABLE schedule_v (
    id INTEGER REFERENCES sadt(id),
    patient_contacts VARCHAR(20),
    main_procedure_term VARCHAR(255),
    confirmed BOOLEAN DEFAULT FALSE
);
```

## ⚙️ Configuração

1. **Clone e instale dependências:**
```bash
cd disparador
npm install
```

2. **Configure o arquivo `.env`:**
```env
# Configurações do Banco PostgreSQL
DB_HOST=100.99.99.36
DB_PORT=5432
DB_USER=cdcenter
DB_PASSWORD=DevZeus@2025
DB_NAME=postgres

# Configurações do Servidor
PORT=3000

# Configurações WhatsApp
WHATSAPP_SESSION_PATH=./whatsapp-session
```

3. **Inicie o sistema:**
```bash
npm start
```

4. **Acesse a interface:**
   - Abra http://localhost:3000 no navegador

## 📱 Como Usar

### 1. Conectar WhatsApp
1. Clique em "Conectar" na interface
2. Escaneie o QR Code com seu WhatsApp
3. Aguarde a confirmação de conexão

### 2. Visualizar Agendamentos
- Os agendamentos pendentes aparecerão automaticamente
- Use os filtros e checkboxes para selecionar

### 3. Enviar Mensagens
- **Individual**: Clique no ícone de envio ao lado do agendamento
- **Em massa**: Selecione múltiplos agendamentos e clique "Enviar Selecionados"
- **Personalizada**: Digite uma mensagem customizada no campo de texto

### 4. Confirmar Agendamentos
- Clique no ícone de confirmação para marcar como confirmado no banco
- Agendamentos confirmados não aparecerão mais na lista

## 🔧 API Endpoints

### WhatsApp
    - `POST /api/messages/whatsapp/mode` - Alternar entre `web` e `business`
    - `GET /api/messages/whatsapp/phone-numbers` - (Cloud API) Listar números da WABA
    - `POST /api/messages/whatsapp/register-phone` - (Cloud API) Tentar registrar/listar

### WhatsApp On-Premises (Business API On-Prem)
    - `POST /api/messages/waba-onprem/request-code` → Encaminha para `POST /v1/account` (cc, phone_number, method, cert)
    - `POST /api/messages/waba-onprem/verify`      → Encaminha para `POST /v1/account/verify` (code, cert, pin, vname)

### Agendamentos

### Variáveis de ambiente adicionais

Para Cloud API (já utilizadas):

```
WHATSAPP_MODE=business
WHATSAPP_ACCESS_TOKEN=EAAG...
WHATSAPP_PHONE_NUMBER_ID=771944609345651
WHATSAPP_BUSINESS_ACCOUNT_ID=1876870716520569
WHATSAPP_API_VERSION=v18.0
```

Para On‑Premises (se você tiver o cliente hospedado):

```
WABA_ONPREM_BASE_URL=https://seu-servidor-waba:443
WABA_ONPREM_USERNAME=admin
WABA_ONPREM_PASSWORD=senha
WABA_ONPREM_CERT_BASE64=coloque_o_cert_em_base64_aqui
WABA_ONPREM_CC=55
WABA_ONPREM_PHONE=3431993069
WABA_ONPREM_METHOD=sms
```
- `GET /api/messages/appointments/stats` - Estatísticas
- `POST /api/messages/appointments/:id/confirm` - Confirmar agendamento

### Mensagens
- `POST /api/messages/send/:id` - Enviar para agendamento específico
- `POST /api/messages/send/bulk` - Disparo em massa
- `POST /api/messages/test` - Teste de mensagem

## 📝 Template de Mensagem Padrão

```
🏥 *Confirmação de Agendamento*

Olá *[NOME_PACIENTE]*!

Você tem um agendamento marcado:
📅 *Data:* [DATA]
🕐 *Horário:* [HORARIO]
🔬 *Procedimento:* [PROCEDIMENTO]

Para confirmar seu agendamento, responda *SIM*.
Para reagendar, entre em contato conosco.

_Esta é uma mensagem automática do sistema de agendamentos._
```

## 🛡️ Segurança e Boas Práticas

- **Intervalo entre mensagens**: 3 segundos para evitar bloqueios
- **Sessão persistente**: WhatsApp mantém login entre reinicializações
- **Validação de números**: Verifica números inválidos antes do envio
- **Log detalhado**: Todas as ações são registradas no console

## 🚨 Troubleshooting

### WhatsApp não conecta
- Verifique se o Chrome está instalado
- Limpe a pasta `whatsapp-session`
- Restart o sistema

### Erro de banco de dados
- Verifique as credenciais no `.env`
- Confirme se as tabelas existem
- Teste a conectividade de rede

### Mensagens não enviadas
- Verifique o formato dos números (com código do país)
- Confirme se o WhatsApp está conectado
- Verifique se os números são válidos

## 🔄 Scripts Disponíveis

- `npm start` - Inicia o sistema
- `npm run dev` - Modo desenvolvimento

## 🏥 Funcionalidades Específicas para Agendamentos Médicos

- **Busca automática** de agendamentos não confirmados
- **Formatação de datas** em português brasileiro
- **Template médico** com informações do procedimento
- **Sistema de confirmação** integrado ao banco
- **Estatísticas** de agendamentos confirmados/pendentes

## 📊 Monitoramento

A interface fornece:
- Status em tempo real do WhatsApp
- Contador de agendamentos pendentes/confirmados
- Log visual das mensagens enviadas
- Controle individual e em massa

## ⏱️ Cron de busca e disparo automático

O sistema inclui um cron opcional que busca novos agendamentos na view `schedule_v` e envia automaticamente o template de confirmação.

Como habilitar:

1. Configure no `.env`:

```
CRON_ENABLED=true
CRON_INTERVAL_MS=60000         # Frequência de varredura (1 min)
CRON_LOOKBACK_DAYS=1           # Cobertura de inserções atrasadas (passado)
CRON_LOOKAHEAD_DAYS=14         # Janela futura de agendamentos
CRON_BATCH_SIZE=30             # Máximo por ciclo
DEFAULT_CONFIRM_TEMPLATE_NAME=confirmacao_personalizada
DEFAULT_CONFIRM_TEMPLATE_LOCALE=pt_BR
```

2. Inicie o servidor (`npm start`). Ao subir, o cron inicia e faz um ciclo imediato.

Rotas de administração:

- `GET /api/messages/cron/status` → Status do cron (habilitado, rodando, última execução)
- `POST /api/messages/cron/run` → Disparo manual imediato de um ciclo

Deduplicação:
- O cron não reenvia para agendamentos que já possuem registro na tabela `message_logs` com `type='template'` e `status` diferente de `failed`.

## ♻️ Cron de retentativa e sincronização

Para garantir que falhas temporárias sejam corrigidas automaticamente, o projeto inclui um segundo cron que varre a tabela `message_logs`, identifica envios de template marcados como `failed` e tenta novamente com backoff exponencial. Ele também revisita registros de confirmação/desmarcação para garantir que o estado no banco esteja alinhado.

Variáveis principais no `.env`:

```
RETRY_CRON_ENABLED=true                # Habilita o cron de retentativa
RETRY_CRON_INTERVAL_MS=300000          # Intervalo entre ciclos (5 min)
RETRY_CRON_BATCH_SIZE=20               # Máximo de registros reprocessados por ciclo
RETRY_CRON_MAX_ATTEMPTS=3              # Limite de tentativas antes de desistir
RETRY_CRON_BACKOFF_BASE_SECONDS=90     # Base do backoff exponencial entre tentativas
RETRY_CRON_SYNC_STATES=true            # Reaplica confirmações/cancelamentos quando necessário
RETRY_CRON_STATE_BATCH_SIZE=20         # Lote para sincronização de estados
RETRY_CRON_STATE_LOOKBACK_MINUTES=1440 # Janela de busca (ex.: 24h)
```

Logs reprocessados com sucesso recebem status `*_synced`, evitando ciclos desnecessários. Falhas repetidas são reagendadas com um `next_retry_at`, que cresce exponencialmente.

## ⏰ Cron de lembrete pré-consulta

Para enviar um lembrete automático (ex.: 1 dia antes), habilite o cron dedicado e informe o template Utility aprovado:

```
REMINDER_CRON_ENABLED=true
REMINDER_CRON_INTERVAL_MS=300000       # A cada 5 minutos
REMINDER_CRON_LEAD_DAYS=1              # Antecedência: 1 dia
REMINDER_CRON_BATCH_SIZE=40            # Máximo por ciclo
REMINDER_CRON_REQUIRE_CONFIRMED=false  # Defina true se quiser lembrar apenas confirmados
REMINDER_TEMPLATE_NAME=lembrete_consulta_cdcenter
REMINDER_TEMPLATE_LOCALE=pt_BR
```

O serviço busca agendamentos ativos na janela alvo, evita duplicidades consultando `message_logs` (`type='reminder'`) e usa os mesmos placeholders do template de confirmação: paciente, data, horário e procedimento.

## 🔐 Painel Zeus Chat (Admin)

O painel administrativo fornece visualização em tempo real dos disparos, webhook recebidos e status dos crons.

- **URL:** `https://seu-servidor/admin`
- **Login:** definido via variáveis no `.env`
- **Recursos:** cards de métricas, status dos crons, tabela de logs de envio, tabela de webhooks recentes.

Variáveis necessárias:

```
ADMIN_USER=admin                 # Usuário de acesso
ADMIN_PASS=defina_sua_senha      # Senha obrigatória
ADMIN_SESSION_SECRET=troque_este_valor
ADMIN_DISPLAY_NAME=Operações Zeus Chat
ADMIN_SESSION_MAX_AGE=28800000   # (opcional) tempo da sessão em ms
```

> ⚠️ Configure `ADMIN_PASS` e `ADMIN_SESSION_SECRET` antes de expor o painel em produção. Sem esses valores o login é bloqueado.

Os dados apresentados são alimentados pela tabela `message_logs` e pelo arquivo `logs/webhook-events.json`. Para limpar o histórico dos webhooks basta remover esse arquivo (o serviço recria automaticamente).

## 🤝 Suporte

Para suporte técnico:
1. Verifique os logs no console
2. Confirme as configurações do banco
3. Teste a conectividade WhatsApp
4. Consulte a documentação da API

---

**Desenvolvido para facilitar a comunicação com pacientes e reduzir faltas em agendamentos médicos.**