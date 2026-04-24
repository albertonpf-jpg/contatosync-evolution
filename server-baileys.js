const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');

console.log('🚀 Iniciando ContatoSync Evolution...');

// Declarar variáveis fora do try/catch
let authRoutes, clientsRoutes, contactsRoutes, conversationsRoutes, messagesRoutes;
let aiRoutes, activitiesRoutes, integrationsRoutes, sessionsRoutes, whatsappRoutes, webhooksRoutes;
let auth, socketAuth, initializeSocket;

try {
  require('dotenv').config();
  console.log('✅ Dotenv carregado');

  authRoutes = require('./src/routes/auth');
  clientsRoutes = require('./src/routes/clients');
  contactsRoutes = require('./src/routes/contacts');
  conversationsRoutes = require('./src/routes/conversations');
  messagesRoutes = require('./src/routes/messages');
  aiRoutes = require('./src/routes/ai');
  activitiesRoutes = require('./src/routes/activities');
  integrationsRoutes = require('./src/routes/integrations');
  sessionsRoutes = require('./src/routes/sessions');
  whatsappRoutes = require('./src/routes/whatsapp');
  webhooksRoutes = require('./src/routes/webhooks');
  ({ auth } = require('./src/middleware/auth'));
  socketAuth = require('./src/middleware/socketAuth');
  ({ initializeSocket } = require('./src/services/socketService'));

  console.log('✅ Todas rotas carregadas');
} catch (err) {
  console.error('❌ ERRO ao carregar dependências:', err);
  console.error(err.stack);
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3003;

// Socket.IO com CORS
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Middleware basico
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

console.log('ContatoSync com BAILEYS na porta ' + PORT);
console.log('WhatsApp direto, sem Evolution API');
console.log('QR Codes nativos do Baileys');

// ========================
// DEBUG ENDPOINTS (sem auth)
// ========================

app.get('/debug/conversations/:email', async (req, res) => {
  try {
    var email = req.params.email;
    var { supabaseAdmin } = require('./src/config/supabase');

    var { data: client } = await supabaseAdmin
      .from('evolution_clients')
      .select('id')
      .eq('email', email)
      .single();

    if (!client) {
      return res.json({ error: 'Cliente nao encontrado', email: email });
    }

    var { data: conversations } = await supabaseAdmin
      .from('evolution_conversations')
      .select('*, evolution_contacts!inner(name, phone)')
      .eq('client_id', client.id)
      .order('last_message_at', { ascending: false });

    res.json({
      email: email,
      client_id: client.id,
      conversations: conversations || [],
      count: conversations ? conversations.length : 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/debug/baileys-sessions', function(req, res) {
  try {
    var baileysService = require('./src/services/baileysService');
    var sessions = baileysService.getAllSessions();
    res.json({ sessions: sessions, count: sessions.length, timestamp: new Date().toISOString() });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.post('/debug/create-session', async function(req, res) {
  try {
    var { sessionName } = req.body;
    var baileysService = require('./src/services/baileysService');
    var result = await baileysService.createSession(sessionName || 'whatsapp_alberto_principal');
    res.json({
      success: true,
      result: result,
      message: 'Aguarde 3 segundos e acesse /debug/qr para obter QR Code'
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/debug/qr/:sessionName?', async function(req, res) {
  try {
    var sessionName = req.params.sessionName || 'whatsapp_alberto_principal';
    var baileysService = require('./src/services/baileysService');
    var qr = await baileysService.getQRCode(sessionName);

    if (qr.base64) {
      var html = '<html><body style="text-align: center; font-family: Arial;">';
      html += '<h2>WhatsApp QR Code - ContatoSync</h2>';
      html += '<p><strong>Sessao:</strong> ' + sessionName + '</p>';
      html += '<p><strong>Status:</strong> ' + qr.status + '</p>';
      html += '<img src="' + qr.base64 + '" alt="QR Code" style="max-width: 400px; border: 2px solid #25D366;">';
      html += '<h3>INSTRUCOES:</h3>';
      html += '<ol style="text-align: left; max-width: 400px; margin: 0 auto;">';
      html += '<li>Abra WhatsApp no celular</li>';
      html += '<li>Menu (3 pontos) - Aparelhos conectados</li>';
      html += '<li>Conectar um aparelho - Escanear codigo QR</li>';
      html += '<li>Escaneie o codigo acima</li>';
      html += '</ol>';
      html += '<p style="margin-top: 20px;">';
      html += '<button onclick="location.reload()">Atualizar QR</button>';
      html += '</p></body></html>';
      res.send(html);
    } else {
      res.json({
        error: 'QR Code nao disponivel',
        status: qr.status,
        sessionName: sessionName,
        message: 'Tente criar sessao primeiro: POST /debug/create-session'
      });
    }
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Health checks - múltiplas rotas para Railway
const healthResponse = {
  status: 'OK',
  timestamp: new Date().toISOString(),
  message: 'ContatoSync Evolution - Baileys',
  service: 'WhatsApp Baileys',
  port: PORT
};

app.get('/', function(req, res) {
  console.log('🏥 Health check: /');
  res.status(200).json(healthResponse);
});

app.get('/health', function(req, res) {
  console.log('🏥 Health check: /health');
  res.status(200).json(healthResponse);
});

app.get('/healthz', function(req, res) {
  console.log('🏥 Health check: /healthz');
  res.status(200).text('OK');
});

app.get('/ready', function(req, res) {
  console.log('🏥 Health check: /ready');
  res.status(200).text('READY');
});

// DEBUG: Teste criação sessão sem auth
app.post('/debug/create-session', async function(req, res) {
  try {
    console.log('🔧 DEBUG - Teste criar sessão sem auth');
    console.log('Body:', req.body);

    const testSession = {
      session_name: 'debug_test',
      display_name: 'debug_test'
    };

    console.log('✅ Endpoint debug funcionando');
    res.json({
      message: 'Debug endpoint OK',
      received: req.body,
      test: testSession
    });
  } catch (err) {
    console.error('❌ DEBUG ERROR:', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.get('/debug/baileys', function(req, res) {
  var baileysService = require('./src/services/baileysService');
  baileysService.verifyAllSessions();
  var sessions = baileysService.getAllSessions();
  var qrCodesInfo = {};
  for (var entry of baileysService.qrCodes.entries()) {
    qrCodesInfo[entry[0]] = entry[1] ? 'data:image... (' + entry[1].length + ' chars)' : null;
  }
  res.json({
    totalSessions: sessions.length,
    sessions: sessions,
    qrCodesAvailable: Object.keys(qrCodesInfo),
    qrCodesDetail: qrCodesInfo,
    memoryUsage: process.memoryUsage(),
    uptime: process.uptime()
  });
});

// ========================
// LOG BUFFER (debug remoto)
// ========================

var logBuffer = [];
var originalLog = console.log;
var originalError = console.error;

console.log = function() {
  var args = Array.prototype.slice.call(arguments);
  var msg = args.map(function(a) { return typeof a === 'string' ? a : JSON.stringify(a); }).join(' ');
  logBuffer.push({ t: Date.now(), level: 'log', msg: msg });
  if (logBuffer.length > 200) logBuffer.shift();
  originalLog.apply(console, args);
};

console.error = function() {
  var args = Array.prototype.slice.call(arguments);
  var msg = args.map(function(a) { return typeof a === 'string' ? a : JSON.stringify(a); }).join(' ');
  logBuffer.push({ t: Date.now(), level: 'error', msg: msg });
  if (logBuffer.length > 200) logBuffer.shift();
  originalError.apply(console, args);
};

app.get('/debug/logs', function(req, res) {
  var last = parseInt(req.query.last) || 50;
  res.json(logBuffer.slice(-last));
});

app.get('/debug/ping/:sessionName', async function(req, res) {
  var baileysService = require('./src/services/baileysService');
  var sessionName = req.params.sessionName;
  try {
    var result = await baileysService.forceCheckConnection(sessionName);
    res.json({ sessionName: sessionName, result: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================
// ENDPOINTS INTERNOS (sem auth)
// ========================

// Atualizar status sessao no banco
app.put('/internal/sessions/:sessionName/status', async function(req, res) {
  var sessionName = req.params.sessionName;
  var status = req.body.status;
  var reason = req.body.reason;
  var timestamp = req.body.timestamp;

  try {
    var { supabaseAdmin } = require('./src/config/supabase');

    var { error } = await supabaseAdmin
      .from('evolution_sessions')
      .update({
        status: status,
        last_seen: timestamp,
        updated_at: timestamp
      })
      .eq('session_name', sessionName);

    if (error) {
      console.error('Erro atualizando banco:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log('Banco atualizado: ' + sessionName + ' -> ' + status);
    res.json({ success: true, sessionName: sessionName, status: status });
  } catch (error) {
    console.error('Erro endpoint interno:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// PROCESSAR MENSAGEM RECEBIDA
// ============================================================
app.post('/internal/messages/process', async function(req, res) {
  try {
    var sessionName = req.body.sessionName;
    var phone = req.body.phone;
    var content = req.body.content;
    var messageType = req.body.messageType;
    var whatsappMessageId = req.body.whatsappMessageId;
    var pushName = req.body.pushName;

    console.log('=== PROCESSANDO MENSAGEM ===');
    console.log('Sessao: ' + sessionName);
    console.log('Phone: ' + phone);
    console.log('Content: ' + (content || '').substring(0, 50));
    console.log('PushName: ' + pushName);

    var { supabaseAdmin } = require('./src/config/supabase');
    var { v4: uuidv4 } = require('uuid');
    var now = new Date().toISOString();

    // 1. Buscar sessao -> client_id
    var { data: session, error: sessionError } = await supabaseAdmin
      .from('evolution_sessions')
      .select('*')
      .eq('session_name', sessionName)
      .single();

    if (sessionError) {
      console.error('Erro buscando sessao:', sessionError);
    }

    if (!session) {
      console.error('Sessao nao encontrada no banco: ' + sessionName);
      return res.status(404).json({ error: 'Sessao nao encontrada' });
    }

    console.log('Sessao encontrada, client_id: ' + session.client_id);

    // 2. Buscar ou criar contato
    var { data: contact, error: contactFetchError } = await supabaseAdmin
      .from('evolution_contacts')
      .select('*')
      .eq('client_id', session.client_id)
      .eq('phone', phone)
      .single();

    if (contactFetchError && contactFetchError.code !== 'PGRST116') {
      console.error('Erro buscando contato:', contactFetchError);
    }

    if (!contact) {
      var newContactId = uuidv4();
      var { data: newContact, error: contactError } = await supabaseAdmin
        .from('evolution_contacts')
        .insert([{
          id: newContactId,
          client_id: session.client_id,
          phone: phone,
          name: pushName || ('Contato ' + phone),
          source: 'whatsapp',
          status: 'active',
          last_message_at: now,
          created_at: now,
          updated_at: now
        }])
        .select('*')
        .single();

      if (contactError) {
        console.error('Erro criando contato:', contactError);
        return res.status(500).json({ error: 'Erro criando contato', details: contactError });
      }
      contact = newContact;
      console.log('Novo contato criado: ' + contact.name + ' (' + phone + ')');
    } else {
      // Atualizar nome se pushName veio e contato tinha nome generico
      if (pushName && contact.name && contact.name.startsWith('Contato ')) {
        await supabaseAdmin
          .from('evolution_contacts')
          .update({ name: pushName, updated_at: now })
          .eq('id', contact.id);
        contact.name = pushName;
      }
      // Atualizar last_message_at do contato
      await supabaseAdmin
        .from('evolution_contacts')
        .update({ last_message_at: now, updated_at: now })
        .eq('id', contact.id);
    }

    // 3. Buscar ou criar conversa
    var jid = phone + '@s.whatsapp.net';

    var { data: conversation, error: convFetchError } = await supabaseAdmin
      .from('evolution_conversations')
      .select('*')
      .eq('client_id', session.client_id)
      .eq('contact_id', contact.id)
      .single();

    if (convFetchError && convFetchError.code !== 'PGRST116') {
      console.error('Erro buscando conversa:', convFetchError);
    }

    if (!conversation) {
      var newConvId = uuidv4();
      var { data: newConv, error: convError } = await supabaseAdmin
        .from('evolution_conversations')
        .insert([{
          id: newConvId,
          client_id: session.client_id,
          contact_id: contact.id,
          jid: jid,
          phone: phone,
          contact_name: contact.name,
          status: 'active',
          priority: 'normal',
          lead_stage: 'new',
          last_message_at: now,
          unread_count: 1,
          total_messages: 1,
          created_at: now,
          updated_at: now
        }])
        .select('*')
        .single();

      if (convError) {
        console.error('Erro criando conversa:', convError);
        return res.status(500).json({ error: 'Erro criando conversa', details: convError });
      }
      conversation = newConv;
      console.log('Nova conversa criada: ' + contact.name);
    } else {
      var newUnread = (conversation.unread_count || 0) + 1;
      var newTotal = (conversation.total_messages || 0) + 1;

      var { error: updateError } = await supabaseAdmin
        .from('evolution_conversations')
        .update({
          last_message_at: now,
          unread_count: newUnread,
          total_messages: newTotal,
          contact_name: contact.name,
          phone: phone,
          jid: jid,
          updated_at: now
        })
        .eq('id', conversation.id);

      if (updateError) {
        console.error('Erro atualizando conversa:', updateError);
      }
    }

    // 4. Salvar mensagem
    var newMsgId = uuidv4();
    var { error: msgError } = await supabaseAdmin
      .from('evolution_messages')
      .insert([{
        id: newMsgId,
        conversation_id: conversation.id,
        client_id: session.client_id,
        contact_id: contact.id,
        content: content,
        message_type: messageType || 'text',
        direction: 'in',
        status: 'received',
        is_from_ai: false,
        whatsapp_message_id: whatsappMessageId,
        sent_at: now,
        created_at: now
      }]);

    if (msgError) {
      console.error('Erro salvando mensagem:', msgError);
      return res.status(500).json({ error: 'Erro salvando mensagem', details: msgError });
    }

    console.log('Mensagem processada: ' + contact.name + ' (' + phone + ') - ' + (content || '').substring(0, 50));

    // 5. Emitir evento WebSocket (se io disponivel)
    try {
      var { getIO } = require('./src/services/socketService');
      var socketIO = getIO();
      if (socketIO) {
        socketIO.to(session.client_id).emit('new_message', {
          conversation_id: conversation.id,
          contact_name: contact.name,
          phone: phone,
          content: content,
          message_type: messageType,
          direction: 'in',
          timestamp: now
        });
      }
    } catch (socketErr) {
      // Socket nao critico
    }

    res.json({ success: true, conversation_id: conversation.id, contact_id: contact.id });

  } catch (error) {
    console.error('Erro processando mensagem:', error);
    console.error('Stack:', error.stack);
    res.status(500).json({ error: error.message });
  }
});

// ========================
// ROTAS PUBLICAS
// ========================
app.use('/api/auth', authRoutes);
app.use('/api/webhooks', webhooksRoutes);

// ========================
// ROTAS PROTEGIDAS
// ========================
app.use('/api/clients', auth, clientsRoutes);
app.use('/api/contacts', auth, contactsRoutes);
app.use('/api/conversations', auth, conversationsRoutes);
app.use('/api/messages', auth, messagesRoutes);
app.use('/api/ai', auth, aiRoutes);
app.use('/api/activities', auth, activitiesRoutes);
app.use('/api/integrations', auth, integrationsRoutes);
app.use('/api/sessions', auth, sessionsRoutes);
app.use('/api/whatsapp', auth, whatsappRoutes);

// Socket.IO auth + init
io.use(socketAuth);
initializeSocket(io);

// Error handler
app.use(function(err, req, res, next) {
  console.error('Erro:', err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// 404 handler
app.use('*', function(req, res) {
  res.status(404).json({ error: 'Endpoint nao encontrado' });
});

server.listen(PORT, function() {
  console.log('🚀 Servidor Baileys ONLINE na porta:' + PORT);
  console.log('📡 WebSocket ativo');
  console.log('💬 Baileys ready para WhatsApp!');
  console.log('🏥 Health endpoints: /, /health, /healthz, /ready');
}).on('error', (err) => {
  console.error('❌ ERRO CRÍTICO servidor:', err);
  process.exit(1);
});

// Captura erros não tratados
process.on('uncaughtException', (err) => {
  console.error('❌ UNCAUGHT EXCEPTION:', err);
  console.error(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION:', reason);
  console.error('Promise:', promise);
  process.exit(1);
});

module.exports = { app: app, server: server, io: io };
