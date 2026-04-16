# ContatoSync Evolution API

Backend API completo para o sistema ContatoSync Evolution - solução multi-cliente de gestão WhatsApp com CRM e IA integrada.

## 🚀 Características

- **Multi-tenant**: Sistema multi-cliente com RLS (Row Level Security)
- **Autenticação JWT**: Autenticação segura com tokens JWT
- **WebSocket**: Comunicação em tempo real
- **IA Integrada**: Suporte para OpenAI e Claude API
- **CRM Completo**: Gestão de contatos, conversas e pipeline
- **Integrações**: Suporte a APIs externas
- **Segurança**: Rate limiting, validações e sanitização

## 📋 Pré-requisitos

- Node.js 18+
- Supabase (PostgreSQL)
- Contas API: OpenAI/Claude (pelos clientes)

## 🛠️ Instalação

1. **Clone e instale dependências:**
```bash
npm install
```

2. **Configure variáveis de ambiente:**
```bash
cp .env.example .env
# Edite o arquivo .env com suas configurações
```

3. **Execute o schema SQL no Supabase:**
- Use o arquivo `contatosync-evolution-database.sql`
- Execute no SQL Editor do Supabase

4. **Inicie o servidor:**
```bash
# Desenvolvimento
npm run dev

# Produção
npm start
```

## 🔧 Configuração

### Variáveis de Ambiente

```env
# Servidor
PORT=3000
NODE_ENV=production
FRONTEND_URL=https://seu-frontend.com

# Supabase
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_ANON_KEY=sua_chave_anonima
SUPABASE_SERVICE_ROLE=sua_chave_service_role

# JWT
JWT_SECRET=sua_chave_secreta_muito_forte
JWT_EXPIRES_IN=30d
```

## 📚 Documentação da API

### Autenticação

#### POST `/api/auth/register`
Registrar novo cliente

**Body:**
```json
{
  "email": "cliente@exemplo.com",
  "password": "senha123",
  "name": "Nome do Cliente",
  "company": "Empresa Ltda",
  "phone": "+55 11 99999-9999",
  "plan": "basic"
}
```

#### POST `/api/auth/login`
Fazer login

**Body:**
```json
{
  "email": "cliente@exemplo.com",
  "password": "senha123"
}
```

### Clientes

#### GET `/api/clients/profile`
Obter perfil completo do cliente

#### PUT `/api/clients/profile`
Atualizar perfil

#### GET `/api/clients/stats`
Estatísticas do cliente

### Contatos

#### GET `/api/contacts`
Listar contatos (com paginação e filtros)

**Query params:**
- `page`: Página (padrão: 1)
- `limit`: Itens por página (padrão: 20)
- `search`: Buscar por nome ou telefone
- `source`: Filtrar por origem
- `saved_to_google`: Filtrar por salvos no Google
- `saved_to_icloud`: Filtrar por salvos no iCloud

#### POST `/api/contacts`
Criar novo contato

**Body:**
```json
{
  "phone": "+5511999999999",
  "name": "Nome do Contato",
  "source": "whatsapp"
}
```

#### PUT `/api/contacts/:id`
Atualizar contato

#### DELETE `/api/contacts/:id`
Excluir contato

### Conversas

#### GET `/api/conversations`
Listar conversas

**Query params:**
- `status`: active, closed, archived
- `priority`: low, normal, high, urgent
- `lead_stage`: new, contacted, qualified, proposal, won, lost

#### POST `/api/conversations`
Criar nova conversa

#### PUT `/api/conversations/:id`
Atualizar conversa

### Mensagens

#### GET `/api/messages`
Listar mensagens

#### POST `/api/messages`
Criar nova mensagem

#### GET `/api/messages/conversation/:conversation_id`
Obter mensagens de uma conversa

### IA

#### GET `/api/ai/config`
Obter configuração de IA

#### PUT `/api/ai/config`
Atualizar configuração de IA

#### POST `/api/ai/test`
Testar resposta de IA

#### GET `/api/ai/logs`
Obter logs de IA

#### GET `/api/ai/stats`
Estatísticas de uso da IA

### Atividades

#### GET `/api/activities`
Listar atividades do cliente

#### GET `/api/activities/stats`
Estatísticas de atividades

#### GET `/api/activities/timeline`
Timeline de atividades

### Integrações

#### GET `/api/integrations`
Listar integrações

#### POST `/api/integrations`
Criar nova integração

#### PUT `/api/integrations/:id`
Atualizar integração

#### POST `/api/integrations/:id/test`
Testar integração

### Sessões

#### GET `/api/sessions/whatsapp/status`
Status da conexão WhatsApp

#### POST `/api/sessions/whatsapp/connect`
Conectar WhatsApp

#### POST `/api/sessions/whatsapp/disconnect`
Desconectar WhatsApp

## 🔌 WebSocket Events

### Cliente → Servidor

- `get_status`: Obter status de conexão
- `mark_message_read`: Marcar mensagem como lida
- `typing`: Indicar que está digitando
- `ping`: Manter conexão ativa

### Servidor → Cliente

- `new_message`: Nova mensagem recebida
- `conversation_updated`: Conversa atualizada
- `new_contact`: Novo contato salvo
- `ai_response`: Resposta de IA gerada
- `whatsapp_status`: Status WhatsApp atualizado
- `whatsapp_qr`: QR Code para conexão

## 🔒 Segurança

### Rate Limiting

- **Login**: 5 tentativas por 15 minutos
- **Registro**: 3 tentativas por hora
- **IA**: 10 requests por minuto
- **Mensagens**: 60 por minuto

### Validações

- Joi schema validation
- Input sanitization
- Content-Type validation
- Payload size limits

### Autenticação

- JWT tokens
- Row Level Security (RLS)
- Device fingerprinting
- Session management

## 🏗️ Estrutura do Projeto

```
src/
├── config/
│   └── supabase.js          # Configuração Supabase
├── middleware/
│   ├── auth.js              # Autenticação JWT
│   ├── socketAuth.js        # Auth WebSocket
│   └── security.js          # Middleware de segurança
├── routes/
│   ├── auth.js              # Rotas de autenticação
│   ├── clients.js           # Gestão de clientes
│   ├── contacts.js          # Gestão de contatos
│   ├── conversations.js     # Gestão de conversas
│   ├── messages.js          # Gestão de mensagens
│   ├── ai.js                # Configuração de IA
│   ├── activities.js        # Log de atividades
│   ├── integrations.js      # Integrações externas
│   └── sessions.js          # Gestão de sessões
├── services/
│   └── socketService.js     # Serviços WebSocket
├── utils/
│   ├── validation.js        # Schemas de validação
│   ├── response.js          # Utilitários de resposta
│   └── helpers.js           # Funções auxiliares
└── server.js                # Servidor principal
```

## 📊 Database Schema

O sistema utiliza 9 tabelas principais:

1. **evolution_clients**: Dados dos clientes
2. **evolution_contacts**: Contatos salvos
3. **evolution_conversations**: Conversas ativas
4. **evolution_messages**: Mensagens trocadas
5. **evolution_ai_config**: Configuração de IA
6. **evolution_ai_log**: Logs de IA
7. **evolution_activities**: Histórico de atividades
8. **evolution_sessions**: Sessões ativas
9. **evolution_integrations**: Integrações externas

## 🚀 Deploy

### Railway

1. Conecte o repositório GitHub
2. Configure as variáveis de ambiente
3. Deploy automático a cada push

### Vercel

1. `npm install -g vercel`
2. `vercel --prod`

### Docker

```bash
# Build
docker build -t contatosync-api .

# Run
docker run -p 3000:3000 --env-file .env contatosync-api
```

## 🧪 Testes

```bash
# Executar testes
npm test

# Executar com coverage
npm run test:coverage
```

## 📝 Scripts Disponíveis

- `npm start`: Iniciar em produção
- `npm run dev`: Iniciar em desenvolvimento
- `npm test`: Executar testes
- `npm run lint`: Verificar código

## 🤝 Contribuição

1. Fork o projeto
2. Crie uma branch para sua feature
3. Commit suas mudanças
4. Push para a branch
5. Abra um Pull Request

## 📄 Licença

MIT License - veja o arquivo LICENSE para detalhes.

## 📞 Suporte

- Email: albertonpf@gmail.com
- GitHub: albertonpf-jpg
- Website: plannedmidia.com.br

---

**ContatoSync Evolution** - Transformando a gestão de WhatsApp empresarial 🚀