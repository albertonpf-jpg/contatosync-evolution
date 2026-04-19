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

// Middleware básico - SEM RATE LIMITING
app.use(cors({
  origin: "*",
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

console.log('🚀 ContatoSync com BAILEYS na porta', PORT);
console.log('✅ WhatsApp direto, sem Evolution API');
console.log('📱 QR Codes nativos do Baileys');
console.log('🔓 Rate limiting REMOVIDO');

// Debug endpoint - sem auth
app.get('/debug/conversations/:email', async (req, res) => {
  try {
    const email = req.params.email;
    const { supabaseAdmin } = require('./src/config/supabase');

    // Buscar cliente por email
    const { data: client } = await supabaseAdmin
      .from('evolution_clients')
      .select('id')
      .eq('email', email)
      .single();

    if (!client) {
      return res.json({ error: 'Cliente não encontrado', email });
    }

    // Buscar conversas
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

// Debug sessões Baileys - sem auth
app.get('/debug/baileys-sessions', (req, res) => {
  try {
    const baileysService = require('./src/services/baileysService');
    const sessions = baileysService.getAllSessions();

    res.json({
      sessions,
      count: sessions.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Criar sessão WhatsApp - sem auth
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

// Obter QR Code - sem auth
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

// Debug endpoint para verificar estado do Baileys
app.get('/debug/baileys', (req, res) => {
  const baileysService = require('./src/services/baileysService');

  // Verificar status real de todas as sessões
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

// Capturar logs em buffer para debug remoto
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

// Debug endpoint para forçar verificação de sessão específica
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

// Endpoint interno para atualizar status no banco
app.put('/internal/sessions/:sessionName/status', async (req, res) => {
  const { sessionName } = req.params;
  const { status, reason, timestamp } = req.body;

  try {
    const { executeWithRLS } = require('./src/config/supabase');
    const { createClient } = require('@supabase/supabase-js');

    // Usar service role para acesso interno
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE
    );

    const { error } = await supabase
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

// Rotas públicas
app.use('/api/auth', authRoutes);
app.use('/api/webhooks', webhooksRoutes);

// Rotas protegidas (todas com auth)
app.use('/api/clients', auth, clientsRoutes);
app.use('/api/contacts', auth, contactsRoutes);
app.use('/api/conversations', auth, conversationsRoutes);
app.use('/api/messages', auth, messagesRoutes);
app.use('/api/ai', auth, aiRoutes);
app.use('/api/activities', auth, activitiesRoutes);
app.use('/api/integrations', auth, integrationsRoutes);
app.use('/api/sessions', auth, sessionsRoutes);
app.use('/api/whatsapp', auth, whatsappRoutes);

// Endpoints internos (sem auth)
app.post('/internal/messages/process', async (req, res) => {
  try {
    const { sessionName, phone, content, messageType, whatsappMessageId, pushName } = req.body;

    // Buscar sessão no banco para obter client_id
    const { supabaseAdmin } = require('./src/config/supabase');
    const { data: session } = await supabaseAdmin
      .from('evolution_sessions')
      .select('*')
      .eq('session_name', sessionName)
      .single();

    if (!session) {
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    // Buscar ou criar contato
    let { data: contact } = await supabaseAdmin
      .from('evolution_contacts')
      .select('*')
      .eq('client_id', session.client_id)
      .eq('phone', phone)
      .single();

    if (!contact) {
      const { v4: uuidv4 } = require('uuid');
      const { data: newContact } = await supabaseAdmin
        .from('evolution_contacts')
        .insert([{
          id: uuidv4(),
          client_id: session.client_id,
          phone: phone,
          name: pushName || `Contato ${phone}`,
          status: 'active',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }])
        .select('*')
        .single();
      contact = newContact;
    }

    // Buscar ou criar conversa
    let { data: conversation } = await supabaseAdmin
      .from('evolution_conversations')
      .select('*')
      .eq('client_id', session.client_id)
      .eq('contact_id', contact.id)
      .single();

    if (!conversation) {
      const { v4: uuidv4 } = require('uuid');
      const { data: newConv } = await supabaseAdmin
        .from('evolution_conversations')
        .insert([{
          id: uuidv4(),
          client_id: session.client_id,
          contact_id: contact.id,
          status: 'active',
          last_message_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }])
        .select('*')
        .single();
      conversation = newConv;
    }

    // Salvar mensagem
    const { v4: uuidv4 } = require('uuid');
    await supabaseAdmin
      .from('evolution_messages')
      .insert([{
        id: uuidv4(),
        conversation_id: conversation.id,
        client_id: session.client_id,
        contact_id: contact.id,
        content: content,
        message_type: messageType,
        direction: 'in',
        status: 'received',
        whatsapp_message_id: whatsappMessageId,
        created_at: new Date().toISOString()
      }]);

    // Atualizar conversa
    await supabaseAdmin
      .from('evolution_conversations')
      .update({
        last_message_at: new Date().toISOString(),
        unread_count: supabaseAdmin.sql`unread_count + 1`,
        updated_at: new Date().toISOString()
      })
      .eq('id', conversation.id);

    console.log(`✅ Mensagem processada: ${contact.name} - ${content.substring(0, 30)}`);
    res.json({ success: true });

  } catch (error) {
    console.error('❌ Erro processando mensagem:', error);
    res.status(500).json({ error: error.message });
  }
});

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