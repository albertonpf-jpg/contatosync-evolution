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
    origin: "*",
    methods: ["GET", "POST"]
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

// ============================================================
// SESSIONS HEALTH — visibilidade completa do estado das sessões
// ============================================================
app.get('/debug/sessions-health', async function(req, res) {
  try {
    var { supabaseAdmin } = require('./src/config/supabase');
    var baileysService = require('./src/services/baileysService');

    // Todas as sessões do banco
    var { data: dbSessions } = await supabaseAdmin
      .from('evolution_sessions')
      .select('id, session_name, client_id, status, created_at, updated_at')
      .order('client_id');

    // Agrupar por client_id
    var byClient = {};
    for (var sess of (dbSessions || [])) {
      if (!byClient[sess.client_id]) byClient[sess.client_id] = [];
      byClient[sess.client_id].push(sess);
    }

    // Clientes com mais de 1 sessão (violação da regra)
    var duplicates = Object.entries(byClient)
      .filter(function(e) { return e[1].length > 1; })
      .map(function(e) { return { client_id: e[0], count: e[1].length, sessions: e[1] }; });

    // Sessões em memória não registradas no banco
    var memorySessions = baileysService.getAllSessions();
    var dbNames = new Set((dbSessions || []).map(function(s) { return s.session_name; }));
    var memoryOnly = memorySessions.filter(function(s) { return !dbNames.has(s.sessionName); });

    // Sessões no banco não presentes na memória
    var memoryNames = new Set(memorySessions.map(function(s) { return s.sessionName; }));
    var dbOnly = (dbSessions || []).filter(function(s) { return !memoryNames.has(s.session_name); });

    // Enriquecer com emails dos clientes
    var clientIds = [...new Set((dbSessions || []).map(function(s) { return s.client_id; }))];
    var clientMap = {};
    if (clientIds.length > 0) {
      var { data: clients } = await supabaseAdmin
        .from('evolution_clients')
        .select('id, email')
        .in('id', clientIds);
      for (var c of (clients || [])) clientMap[c.id] = c.email;
    }

    var health = duplicates.length === 0 && memoryOnly.length === 0 ? 'OK' : 'INCONSISTENT';

    res.json({
      health: health,
      total_db_sessions: (dbSessions || []).length,
      total_memory_sessions: memorySessions.length,
      clients_with_sessions: Object.keys(byClient).length,
      violations: {
        duplicate_clients: duplicates.map(function(d) {
          return { client_id: d.client_id, email: clientMap[d.client_id] || 'unknown', count: d.count,
            sessions: d.sessions.map(function(s) { return { name: s.session_name, status: s.status, created: s.created_at }; }) };
        }),
        memory_only: memoryOnly.map(function(s) { return { name: s.sessionName, status: s.status }; }),
        db_only: dbOnly.map(function(s) { return { name: s.session_name, status: s.status, client: clientMap[s.client_id] || s.client_id }; })
      },
      sessions_detail: (dbSessions || []).map(function(s) {
        var mem = memorySessions.find(function(m) { return m.sessionName === s.session_name; });
        return {
          session_name: s.session_name,
          client_id: s.client_id,
          email: clientMap[s.client_id] || 'unknown',
          db_status: s.status,
          memory_status: mem ? mem.status : 'not_in_memory',
          connected: mem ? mem.state === 'open' : false
        };
      }),
      timestamp: new Date().toISOString()
    });
  } catch (e) { res.json({ error: e.message, stack: e.stack }); }
});

// ============================================================
// CLEANUP — remove duplicatas, mantém 1 sessão por client
// ============================================================
app.post('/debug/cleanup-sessions', async function(req, res) {
  try {
    var { supabaseAdmin } = require('./src/config/supabase');
    var baileysService = require('./src/services/baileysService');

    var { data: allSessions } = await supabaseAdmin
      .from('evolution_sessions')
      .select('id, session_name, client_id, status, created_at')
      .order('created_at', { ascending: false }); // mais recente primeiro

    var byClient = {};
    for (var sess of (allSessions || [])) {
      if (!byClient[sess.client_id]) byClient[sess.client_id] = [];
      byClient[sess.client_id].push(sess);
    }

    var deleted = [];
    for (var clientId of Object.keys(byClient)) {
      var sessions = byClient[clientId];
      if (sessions.length <= 1) continue;
      // Manter a primeira (mais recente), deletar o resto
      var toDelete = sessions.slice(1);
      for (var old of toDelete) {
        try { await baileysService.deleteSession(old.session_name); } catch(e) {}
        await supabaseAdmin.from('evolution_sessions').delete().eq('id', old.id);
        deleted.push({ session_name: old.session_name, client_id: old.client_id, status: old.status });
      }
    }

    // Sessões em memória sem correspondência no banco
    var dbNames = new Set((allSessions || []).map(function(s) { return s.session_name; }));
    var orphanMemory = baileysService.getAllSessions().filter(function(s) { return !dbNames.has(s.sessionName); });
    var orphanDeleted = [];
    for (var orphan of orphanMemory) {
      try { await baileysService.deleteSession(orphan.sessionName); orphanDeleted.push(orphan.sessionName); } catch(e) {}
    }

    res.json({
      duplicates_removed: deleted,
      orphan_memory_removed: orphanDeleted,
      total_removed: deleted.length + orphanDeleted.length,
      timestamp: new Date().toISOString()
    });
  } catch (e) { res.json({ error: e.message }); }
});

// Mostra detalhes de um client_id (email do dono)
app.get('/debug/client-info/:clientId', async function(req, res) {
  try {
    var { supabaseAdmin } = require('./src/config/supabase');
    var cid = req.params.clientId;
    var { data: client } = await supabaseAdmin.from('evolution_clients').select('id,email,name').eq('id', cid).single();
    var { data: convs } = await supabaseAdmin.from('evolution_conversations').select('id,contact_name,phone,last_message_at').eq('client_id', cid).order('last_message_at', { ascending: false }).limit(10);
    var { data: contacts } = await supabaseAdmin.from('evolution_contacts').select('id,name,phone').eq('client_id', cid).limit(5);
    res.json({ client, convCount: convs ? convs.length : 0, convs: convs || [], contacts: contacts || [] });
  } catch (e) { res.json({ error: e.message }); }
});

// Migra todos os dados de um client_id para outro
// POST /debug/migrate-client  body: { from_client_id, to_email }
app.post('/debug/migrate-client', async function(req, res) {
  try {
    var { supabaseAdmin } = require('./src/config/supabase');
    var fromId = req.body.from_client_id;
    var toEmail = req.body.to_email;
    if (!fromId || !toEmail) return res.json({ error: 'from_client_id e to_email obrigatorios' });
    var { data: toClient } = await supabaseAdmin.from('evolution_clients').select('id').eq('email', toEmail).single();
    if (!toClient) return res.json({ error: 'Cliente destino nao encontrado: ' + toEmail });
    var toId = toClient.id;
    var now = new Date().toISOString();
    var r1 = await supabaseAdmin.from('evolution_conversations').update({ client_id: toId, updated_at: now }).eq('client_id', fromId);
    var r2 = await supabaseAdmin.from('evolution_contacts').update({ client_id: toId, updated_at: now }).eq('client_id', fromId);
    var r3 = await supabaseAdmin.from('evolution_messages').update({ client_id: toId }).eq('client_id', fromId);
    res.json({ ok: true, from: fromId, to: toId, toEmail,
      convs_migrated: !r1.error, contacts_migrated: !r2.error, messages_migrated: !r3.error,
      errors: [r1.error?.message, r2.error?.message, r3.error?.message].filter(Boolean) });
  } catch (e) { res.json({ error: e.message }); }
});

// Mostra todos os sessions no banco (sem filtro de client_id)
app.get('/debug/all-sessions', async function(req, res) {
  try {
    var { supabaseAdmin } = require('./src/config/supabase');
    var { data: sessions } = await supabaseAdmin
      .from('evolution_sessions')
      .select('session_name, client_id, status, created_at');
    var inMemory = require('./src/services/baileysService').getAllSessions();
    res.json({ db_sessions: sessions || [], memory_sessions: inMemory, timestamp: new Date().toISOString() });
  } catch (e) { res.json({ error: e.message }); }
});

// Corrige o client_id de uma session no banco
// POST /debug/fix-session-client  body: { session_name, email }
app.post('/debug/fix-session-client', async function(req, res) {
  try {
    var { supabaseAdmin } = require('./src/config/supabase');
    var { v4: uuidv4 } = require('uuid');
    var sessionName = req.body.session_name;
    var email = req.body.email;
    if (!sessionName || !email) return res.json({ error: 'session_name e email obrigatorios' });

    var { data: client } = await supabaseAdmin
      .from('evolution_clients').select('id').eq('email', email).single();
    if (!client) return res.json({ error: 'Cliente nao encontrado: ' + email });

    var now = new Date().toISOString();
    var { data: existing } = await supabaseAdmin
      .from('evolution_sessions').select('id').eq('session_name', sessionName).single();

    var result;
    if (existing) {
      result = await supabaseAdmin
        .from('evolution_sessions')
        .update({ client_id: client.id, updated_at: now })
        .eq('session_name', sessionName)
        .select();
    } else {
      result = await supabaseAdmin
        .from('evolution_sessions')
        .insert([{ id: uuidv4(), session_name: sessionName, client_id: client.id,
                   status: 'connected', created_at: now, updated_at: now }])
        .select();
    }
    res.json({ ok: true, email, client_id: client.id, sessionName, result: result.data });
  } catch (e) { res.json({ error: e.message }); }
});

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
      .select('id, contact_name, phone, jid, status, last_message_at, unread_count, contact_id')
      .eq('client_id', client.id)
      .order('last_message_at', { ascending: false });

    var { data: sessions } = await supabaseAdmin
      .from('evolution_sessions')
      .select('session_name, client_id, status')
      .eq('client_id', client.id);

    var { data: contacts } = await supabaseAdmin
      .from('evolution_contacts')
      .select('id, name, phone')
      .eq('client_id', client.id)
      .limit(5);

    res.json({
      email: email,
      client_id: client.id,
      conversations: conversations || [],
      convCount: conversations ? conversations.length : 0,
      sessions: sessions || [],
      contacts_sample: contacts || [],
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
    var remoteJid = req.body.remoteJid;
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
    var isLid = req.body.isLid || false;
    var digitsOnlyPhone = (phone || '').replace(/\D/g, '');
    var hasRealPhone = digitsOnlyPhone.startsWith('55') && digitsOnlyPhone.length >= 12 && digitsOnlyPhone.length <= 13;
    var storedPhone = hasRealPhone ? digitsOnlyPhone : '';
    
    // Se é LID não resolvido, NÃO gravar como telefone — preservar o que já existe
    if (isLid && !hasRealPhone) {
      console.log('[MSG] LID nao resolvido: ' + digitsOnlyPhone + ' — telefone sera preservado do contato/conversa existente');
    }

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
      console.error('[MSG CRITICAL] Sessao nao encontrada no banco: ' + sessionName + ' — mensagem descartada');
      return res.status(404).json({ error: 'Sessao nao encontrada' });
    }

    // ── VALIDAÇÃO DE CLIENT_ID ───────────────────────────────
    // Garantir que o client_id da sessão aponta para um cliente real
    var { data: clientOwner } = await supabaseAdmin
      .from('evolution_clients')
      .select('id, email')
      .eq('id', session.client_id)
      .single();

    if (!clientOwner) {
      console.error('[MSG CRITICAL] client_id ' + session.client_id + ' da sessao ' + sessionName + ' nao existe em evolution_clients — mensagem descartada');
      return res.status(500).json({ error: 'client_id invalido na sessao' });
    }

    console.log('[MSG] Sessao validada: ' + sessionName + ' → client: ' + clientOwner.email + ' (' + session.client_id + ')');

    // 2. Buscar por JID primeiro para preservar o mesmo contato em conversas @lid
    var { data: existingConversationByJid } = remoteJid
      ? await supabaseAdmin
          .from('evolution_conversations')
          .select('*')
          .eq('client_id', session.client_id)
          .eq('jid', remoteJid)
          .single()
      : { data: null };

    var contact = null;
    var contactFetchError = null;

    if (existingConversationByJid && existingConversationByJid.contact_id) {
      var existingContactResult = await supabaseAdmin
        .from('evolution_contacts')
        .select('*')
        .eq('client_id', session.client_id)
        .eq('id', existingConversationByJid.contact_id)
        .single();

      contact = existingContactResult.data;
      contactFetchError = existingContactResult.error;
    }

    if (!contact) {
      var contactResult = await supabaseAdmin
        .from('evolution_contacts')
        .select('*')
        .eq('client_id', session.client_id)
        .eq('phone', digitsOnlyPhone)
        .single();

      contact = contactResult.data;
      contactFetchError = contactResult.error;
    }

    if (contactFetchError && contactFetchError.code !== 'PGRST116') {
      console.error('Erro buscando contato:', contactFetchError);
    }

    if (!contact) {
      var newContactId = uuidv4();
      // Se é LID não resolvido, salvar digitsOnlyPhone mas nome via pushName
      var contactPhoneToSave = storedPhone || digitsOnlyPhone;
      var contactNameToSave = pushName || (storedPhone ? ('Contato ' + storedPhone) : 'Contato WhatsApp');
      var { data: newContact, error: contactError } = await supabaseAdmin
        .from('evolution_contacts')
        .insert([{
          id: newContactId,
          client_id: session.client_id,
          phone: contactPhoneToSave,
          name: contactNameToSave,
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
      console.log('Novo contato criado: ' + contact.name + ' (phone: ' + contactPhoneToSave + ', isLid: ' + isLid + ')');
    } else {
      // Atualizar nome se pushName veio e contato tinha nome generico
      if (pushName && contact.name && (contact.name.startsWith('Contato ') || contact.name === 'Contato WhatsApp')) {
        var nextContactUpdate = { name: pushName, updated_at: now };
        // Só atualizar telefone se temos telefone real
        if (storedPhone && contact.phone !== storedPhone) nextContactUpdate.phone = storedPhone;
        await supabaseAdmin
          .from('evolution_contacts')
          .update(nextContactUpdate)
          .eq('id', contact.id);
        contact.name = pushName;
        if (storedPhone) contact.phone = storedPhone;
      } else if (storedPhone && contact.phone !== storedPhone) {
        // Atualizar telefone apenas se o novo é real (não sobrescrever real com LID)
        var contactCurrentIsReal = contact.phone && contact.phone.startsWith('55') && contact.phone.length >= 12 && contact.phone.length <= 13;
        if (!contactCurrentIsReal || hasRealPhone) {
          await supabaseAdmin
            .from('evolution_contacts')
            .update({ phone: storedPhone, updated_at: now })
            .eq('id', contact.id);
          contact.phone = storedPhone;
        }
      }
      // Atualizar last_message_at do contato
      await supabaseAdmin
        .from('evolution_contacts')
        .update({ last_message_at: now, updated_at: now })
        .eq('id', contact.id);
    }

    // 3. Buscar ou criar conversa
    // Usar remoteJid original (preserva @lid para contatos LID)
    var jid = remoteJid || (phone + '@s.whatsapp.net');

    var conversation = existingConversationByJid || null;
    var convFetchError = null;

    if (!conversation) {
      var conversationResult = await supabaseAdmin
        .from('evolution_conversations')
        .select('*')
        .eq('client_id', session.client_id)
        .eq('contact_id', contact.id)
        .single();

      conversation = conversationResult.data;
      convFetchError = conversationResult.error;
    }

    if (convFetchError && convFetchError.code !== 'PGRST116') {
      console.error('Erro buscando conversa:', convFetchError);
    }

    var conversationCreated = false;
    if (!conversation) {
      var newConvId = uuidv4();
      // Usar storedPhone (real) ou digitsOnlyPhone (pode ser LID — será corrigido quando resolver)
      var convPhoneToSave = storedPhone || digitsOnlyPhone;
      var { data: newConv, error: convError } = await supabaseAdmin
        .from('evolution_conversations')
        .insert([{
          id: newConvId,
          client_id: session.client_id,
          contact_id: contact.id,
          jid: jid,
          phone: convPhoneToSave,
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
      conversationCreated = true;
      console.log('Nova conversa criada: ' + contact.name + ' (phone: ' + convPhoneToSave + ', isLid: ' + isLid + ')');
    } else {
      var newUnread = (conversation.unread_count || 0) + 1;
      var newTotal = (conversation.total_messages || 0) + 1;

      // Preservar telefone real existente — só atualizar se o novo é real
      var convCurrentIsReal = conversation.phone && conversation.phone.startsWith('55') && conversation.phone.length >= 12 && conversation.phone.length <= 13;
      var nextConversationPhone = storedPhone || (convCurrentIsReal ? conversation.phone : '') || conversation.phone || '';
      var { error: updateError } = await supabaseAdmin
        .from('evolution_conversations')
        .update({
          last_message_at: now,
          unread_count: newUnread,
          total_messages: newTotal,
          contact_name: contact.name,
          jid: jid,
          phone: nextConversationPhone,
          updated_at: now
        })
        .eq('id', conversation.id);

      if (updateError) {
        console.error('Erro atualizando conversa:', updateError);
      } else {
        conversation.phone = nextConversationPhone;
        conversation.contact_name = contact.name;
        conversation.unread_count = newUnread;
        conversation.total_messages = newTotal;
        conversation.last_message_at = now;
        conversation.updated_at = now;
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

    // 5. Emitir evento WebSocket
    try {
      var { getIO } = require('./src/services/socketService');
      var socketIO = getIO();

      // Filtrar LID: telefone real tem prefixo 55 + 10-11 dígitos (12-13 total)
      var rawDigits = (phone || '').replace(/\D/g, '');
      var displayPhone = (rawDigits.startsWith('55') && rawDigits.length >= 12 && rawDigits.length <= 13)
        ? rawDigits : (storedPhone || '');

      var targetRoom = 'client_' + session.client_id;
      var payload = {
        id: newMsgId,
        conversation_id: conversation.id,
        contact_id: contact.id,
        contact_name: contact.name,
        phone: displayPhone,
        content: content,
        message_type: messageType || 'text',
        direction: 'in',
        status: 'received',
        is_from_ai: false,
        sent_at: now,
        created_at: now,
        timestamp: now,
        // Dados completos da conversa para front criar localmente sem refetch
        conversation: {
          id: conversation.id,
          client_id: session.client_id,
          contact_id: contact.id,
          contact_name: contact.name,
          phone: displayPhone,
          jid: jid,
          status: conversation.status || 'active',
          priority: conversation.priority || 'normal',
          lead_stage: conversation.lead_stage || 'new',
          unread_count: conversation.unread_count || 1,
          total_messages: conversation.total_messages || 1,
          last_message_at: now,
          created_at: conversation.created_at || now,
          updated_at: now,
          evolution_contacts: { name: contact.name, phone: displayPhone }
        },
        conversation_created: conversationCreated
      };
      var conversationPayload = {
        id: conversation.id,
        conversation_id: conversation.id,
        contact_id: contact.id,
        contact_name: contact.name,
        phone: displayPhone,
        jid: jid,
        status: conversation.status || 'active',
        priority: conversation.priority || 'normal',
        lead_stage: conversation.lead_stage || 'new',
        unread_count: conversation.unread_count || 1,
        total_messages: conversation.total_messages || 1,
        last_message_at: now,
        created_at: conversation.created_at || now,
        updated_at: now,
        evolution_contacts: { name: contact.name, phone: displayPhone },
        created: conversationCreated,
        timestamp: now
      };

      if (socketIO) {
        socketIO.to(targetRoom).emit('new_message', payload);
        socketIO.to(targetRoom).emit('conversation_updated', conversationPayload);
        console.log('[SOCKET] new_message emitido → room: ' + targetRoom + ' | session: ' + sessionName + ' | conv: ' + conversation.id + ' | created: ' + conversationCreated);
      } else {
        console.warn('[SOCKET] io nao disponivel — evento nao emitido');
      }
    } catch (socketErr) {
      console.error('[SOCKET] Erro ao emitir:', socketErr.message);
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

async function recoverActiveSessions() {
  try {
    console.log('🔄 Verificando sessoes no banco para recuperacao...');
    const { supabaseAdmin } = require('./src/config/supabase');
    const baileysService = require('./src/services/baileysService');
    const { data: sessions, error } = await supabaseAdmin
      .from('evolution_sessions')
      .select('session_name, webhook_url, status');
    if (error || !sessions || sessions.length === 0) {
      console.log('Nenhuma sessao para recuperar');
      return;
    }
    console.log('🔄 Recuperando ' + sessions.length + ' sessao(oes) do banco...');
    for (const session of sessions) {
      try {
        const inMemory = baileysService.sessions.has(session.session_name);
        if (!inMemory) {
          await baileysService.createSession(session.session_name, session.webhook_url);
          console.log('✅ Sessao recuperada: ' + session.session_name);
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (err) {
        console.error('❌ Erro recuperando ' + session.session_name + ': ' + err.message);
      }
    }
  } catch (err) {
    console.error('❌ Erro na recuperacao de sessoes: ' + err.message);
  }
}

server.listen(PORT, function() {
  console.log('🚀 Servidor Baileys ONLINE na porta:' + PORT);
  setTimeout(recoverActiveSessions, 3000);
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
