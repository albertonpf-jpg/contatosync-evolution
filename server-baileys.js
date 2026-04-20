const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const authRoutes = require('./src/routes/auth');
const clientsRoutes = require('./src/routes/clients');
const contactsRoutes = require('./src/routes/contacts');
const conversationsRoutes = require('./src/routes/conversations');
const messagesRoutes = require('./src/routes/messages');
const aiRoutes = require('./src/routes/ai');
const activitiesRoutes = require('./src/routes/activities');
const integrationsRoutes = require('./src/routes/integrations');
const sessionsRoutes = require('./src/routes/sessions');
const whatsappRoutes = require('./src/routes/whatsapp');
const webhooksRoutes = require('./src/routes/webhooks');
const { auth } = require('./src/middleware/auth');
const socketAuth = require('./src/middleware/socketAuth');
const { initializeSocket } = require('./src/services/socketService');

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

// Middleware básico
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

console.log('🚀 ContatoSync com BAILEYS na porta', PORT);
console.log('✅ WhatsApp direto, sem Evolution API');
console.log('📱 QR Codes nativos do Baileys');

// ========================
// DEBUG ENDPOINTS (sem auth)
// ========================

app.get('/debug/conversations/:email', async (req, res) => {
  try {
    const email = req.params.email;
    const { supabaseAdmin } = require('./src/config/supabase');

    const { data: client } = await supabaseAdmin
      .from('evolution_clients')
      .select('id')
      .eq('email', email)
      .single();

    if (!client) {
      return res.json({ error: 'Cliente não encontrado', email });
    }

    const { data: conversations } = await supabaseAdmin
      .from('evolution_conversations')
      .select(`
        *,
        evolution_contacts!inner(name, phone)
      `)
      .eq('client_id', client.id)
      .order('last_message_at', { ascending: false });

    res.json({
      email,
      client_id: client.id,
      conversations: conversations || [],
      count: conversations?.length || 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/debug/baileys-sessions', (req, res) => {
  try {
    const baileysService = require('./src/services/baileysService');
    const sessions = baileysService.getAllSessions();
    res.json({ sessions, count: sessions.length, timestamp: new Date().toISOString() });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.post('/debug/create-session', async (req, res) => {
  try {
    const { sessionName } = req.body;
    const baileysService = require('./src/services/baileysService');
    const result = await baileysService.createSession(sessionName || 'whatsapp_alberto_principal');
    res.json({
      success: true,
      result,
      message: 'Aguarde 3 segundos e acesse /debug/qr para obter QR Code'
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/debug/qr/:sessionName?', async (req, res) => {
  try {
    const sessionName = req.params.sessionName || 'whatsapp_alberto_principal';
    const baileysService = require('./src/services/baileysService');
    const qr = await baileysService.getQRCode(sessionName);

    if (qr.base64) {
      res.send(`
        <html>
        <body style="text-align: center; font-family: Arial;">
          <h2>📱 WhatsApp QR Code - ContatoSync</h2>
          <p><strong>Sessão:</strong> ${sessionName}</p>
          <p><strong>Status:</strong> ${qr.status}</p>
          <img src="${qr.base64}" alt="QR Code" style="max-width: 400px; border: 2px solid #25D366;">
          <h3>INSTRUÇÕES:</h3>
          <ol style="text-align: left; max-width: 400px; margin: 0 auto;">
            <li>Abra WhatsApp no celular</li>
            <li>Menu (3 pontos) → Aparelhos conectados</li>
            <li>Conectar um aparelho → Escanear código QR</li>
            <li>Escaneie o código acima</li>
          </ol>
          <p style="margin-top: 20px;">
            <button onclick="location.reload()">🔄 Atualizar QR</button>
          </p>
        </body>
        </html>
      `);
    } else {
      res.json({
        error: 'QR Code não disponível',
        status: qr.status,
        sessionName,
        message: 'Tente criar sessão primeiro: POST /debug/create-session'
      });
    }
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    message: 'ContatoSync com Baileys - Completo',
    service: 'Baileys WhatsApp'
  });
});

app.get('/debug/baileys', (req, res) => {
  const baileysService = require('./src/services/baileysService');
  baileysService.verifyAllSessions();
  const sessions = baileysService.getAllSessions();
  const qrCodes = {};
  for (const [name, qr] of baileysService.qrCodes.entries()) {
    qrCodes[name] = qr ? `data:image... (${qr.length} chars)` : null;
  }
  res.json({
    totalSessions: sessions.length,
    sessions,
    qrCodesAvailable: Object.keys(qrCodes),
    qrCodesDetail: qrCodes,
    memoryUsage: process.memoryUsage(),
    uptime: process.uptime()
  });
});

// ========================
// LOG BUFFER (debug remoto)
// ========================

const logBuffer = [];
const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  logBuffer.push({ t: Date.now(), level: 'log', msg });
  if (logBuffer.length > 200) logBuffer.shift();
  originalLog.apply(console, args);
};

console.error = (...args) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  logBuffer.push({ t: Date.now(), level: 'error', msg });
  if (logBuffer.length > 200) logBuffer.shift();
  originalError.apply(console, args);
};

app.get('/debug/logs', (req, res) => {
  const last = parseInt(req.query.last) || 50;
  res.json(logBuffer.slice(-last));
});

app.get('/debug/ping/:sessionName', async (req, res) => {
  const baileysService = require('./src/services/baileysService');
  const { sessionName } = req.params;
  try {
    const result = await baileysService.forceCheckConnection(sessionName);
    res.json({ sessionName, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================
// ENDPOINTS INTERNOS (sem auth)
// ========================

// Atualizar status sessão no banco
app.put('/internal/sessions/:sessionName/status', async (req, res) => {
  const { sessionName } = req.params;
  const { status, reason, timestamp } = req.body;

  try {
    const { supabaseAdmin } = require('./src/config/supabase');

    const { error } = await supabaseAdmin
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

    console.log(`✅ Banco atualizado: ${sessionName} → ${status}`);
    res.json({ success: true, sessionName, status });
  } catch (error) {
    console.error('Erro endpoint interno:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// PROCESSAR MENSAGEM RECEBIDA — CORRIGIDO
// ============================================================
app.post('/internal/messages/process', async (req, res) => {
  try {
    const { sessionName, phone, content, messageType, whatsappMessageId, pushName } = req.body;

    const { supabaseAdmin } = require('./src/config/supabase');
    const { v4: uuidv4 } = require('uuid');
    const now = new Date().toISOString();

    // 1. Buscar sessão → client_id
    const { data: session } = await supabaseAdmin
      .from('evolution_sessions')
      .select('*')
      .eq('session_name', sessionName)
      .single();

    if (!session) {
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    // 2. Buscar ou criar contato
    let { data: contact } = await supabaseAdmin
      .from('evolution_contacts')
      .select('*')
      .eq('client_id', session.client_id)
      .eq('phone', phone)
      .single();

    if (!contact) {
      const { data: newContact, error: contactError } = await supabaseAdmin
        .from('evolution_contacts')
        .insert([{
          id: uuidv4(),
          client_id: session.client_id,
          phone: phone,
          name: pushName || `Contato ${phone}`,
          source: 'whatsapp',
          status: 'active',
          last_message_at: now,
          created_at: now,
          updated_at: now
        }])
        .select('*')
        .single();

      if (contactError) {
        console.error('❌ Erro criando contato:', contactError);
        return res.status(500).json({ error: 'Erro criando contato', details: contactError });
      }
      contact = newContact;
      console.log(`👤 Novo contato criado: ${contact.name} (${phone})`);
    } else {
      // Atualizar nome se pushName veio e contato tinha nome genérico
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

    // 3. Buscar ou criar conversa — CORRIGIDO: inclui contact_name, phone, jid
    const jid = `${phone}@s.whatsapp.net`;

    let { data: conversation } = await supabaseAdmin
      .from('evolution_conversations')
      .select('*')
      .eq('client_id', session.client_id)
      .eq('contact_id', contact.id)
      .single();

    if (!conversation) {
      const { data: newConv, error: convError } = await supabaseAdmin
        .from('evolution_conversations')
        .insert([{
          id: uuidv4(),
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
        console.error('❌ Erro criando conversa:', convError);
        return res.status(500).json({ error: 'Erro criando conversa', details: convError });
      }
      conversation = newConv;
      console.log(`💬 Nova conversa criada: ${contact.name}`);
    } else {
      // CORRIGIDO: incremento manual do unread_count (supabaseAdmin.sql não existe)
      const newUnread = (conversation.unread_count || 0) + 1;
      const newTotal = (conversation.total_messages || 0) + 1;

      const { error: updateError } = await supabaseAdmin
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
        console.error('❌ Erro atualizando conversa:', updateError);
      }
    }

    // 4. Salvar mensagem — CORRIGIDO: inclui sent_at
    const { error: msgError } = await supabaseAdmin
      .from('evolution_messages')
      .insert([{
        id: uuidv4(),
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
      console.error('❌ Erro salvando mensagem:', msgError);
      return res.status(500).json({ error: 'Erro salvando mensagem', details: msgError });
    }

    console.log(`✅ Mensagem processada: ${contact.name} (${phone}) - ${content.substring(0, 50)}`);

    // 5. Emitir evento WebSocket (se io disponível)
    try {
      const { getIO } = require('./src/services/socketService');
      const socketIO = getIO();
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
      // Socket não crítico — ignorar
    }

    res.json({ success: true, conversation_id: conversation.id, contact_id: contact.id });

  } catch (error) {
    console.error('❌ Erro processando mensagem:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================
// ROTAS PÚBLICAS
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
app.use((err, req, res, next) => {
  console.error('Erro:', err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado' });
});

server.listen(PORT, () => {
  console.log(`🌟 Servidor Baileys COMPLETO em http://localhost:${PORT}`);
  console.log('📡 WebSocket ativo');
  console.log('📱 Baileys ready para WhatsApp!');
});

module.exports = { app, server, io };
