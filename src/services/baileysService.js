const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

function makeSilentLogger() {
  const noop = () => {};
  return {
    level: 'silent',
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
    child: () => makeSilentLogger()
  };
}

class BaileysService {
  constructor() {
    this.sessions = new Map();
    this.qrCodes = new Map();
    this.authDir = path.join(__dirname, '../../baileys_sessions');
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }
    console.log('Baileys sessions dir: ' + this.authDir);
    this.startHeartbeat();
  }

  startHeartbeat() {
    setInterval(() => { this.checkAllConnections(); }, 10000);
    console.log('Heartbeat iniciado - 10s');
  }

  async checkAllConnections() {
    for (const [name, session] of this.sessions.entries()) {
      if (session.status === 'connected') {
        try {
          if (!session.socket?.user?.id) throw new Error('no user');
          session.lastHeartbeat = new Date().toISOString();
          console.log(`✅ Sessão ${name} heartbeat OK`);
        } catch (err) {
          console.log(`❌ Sessão ${name} perdeu conexão: ${err.message}`);
          session.status = 'disconnected';
          this._updateDatabaseStatus(name, 'disconnected', 'heartbeat_failed');
        }
      }
    }
  }

  async createSession(sessionName, webhookUrl = null) {
    console.log('Criando sessao Baileys: ' + sessionName);
    this.sessions.set(sessionName, {
      socket: null,
      saveCreds: null,
      status: 'connecting',
      qrCode: null,
      createdAt: new Date(),
      lidToPhone: new Map()
    });
    this._connectSession(sessionName, webhookUrl).catch(err => {
      console.error('Erro background ' + sessionName + ':', err.message);
      const s = this.sessions.get(sessionName);
      if (s) s.status = 'error';
    });
    return { sessionName, status: 'created', message: 'Sessao criada' };
  }

  async _connectSession(sessionName, webhookUrl = null) {
    try {
      const sessionDir = path.join(this.authDir, sessionName);
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      let version;
      try {
        const vResult = await fetchLatestBaileysVersion();
        version = vResult.version;
      } catch (vErr) {
        version = [2, 3000, 1015901307];
        console.log('fetchLatestBaileysVersion falhou, usando fallback: ' + version);
      }
      console.log('Baileys version: ' + version + ' for: ' + sessionName);

      const sock = makeWASocket({
        version,
        logger: makeSilentLogger(),
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, makeSilentLogger()) },
        printQRInTerminal: false,
        browser: ['ContatoSync Evolution', 'Desktop', '1.0.0'],
        connectTimeoutMs: 120000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        maxMsgRetryCount: 3,
        msgRetryCounterCache: undefined,
        retryRequestDelayMs: 250,
        shouldIgnoreJid: () => false,
        linkPreviewImageThumbnailWidth: 192,
        transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 },
        getMessage: async (key) => {
          return { conversation: 'hello' };
        }
      });

      const session = this.sessions.get(sessionName);
      if (session) { session.socket = sock; session.saveCreds = saveCreds; }

      // Sincronizar contatos para resolver LID -> numero real e persistir no banco
      sock.ev.on('contacts.upsert', async (contacts) => {
        const s = this.sessions.get(sessionName);
        if (!s || !s.lidToPhone) return;
        for (const contact of contacts) {
          // Formato: contact.id = "55xxx@s.whatsapp.net", contact.lid = "123@lid"
          if (contact.id && contact.id.endsWith('@s.whatsapp.net') && contact.lid) {
            const ph = contact.id.replace('@s.whatsapp.net', '').replace(/\D/g, '');
            if (ph && ph.length <= 15) {
              const lidNum = contact.lid.replace('@lid', '').replace(/\D/g, '');
              s.lidToPhone.set(contact.lid, ph);
              console.log('LID mapeado: ' + contact.lid + ' -> ' + ph);
              await this._persistResolvedLidPhone(sessionName, contact.lid, lidNum, ph);
            }
          }
        }
        console.log('Total LID mappings: ' + s.lidToPhone.size);
      });

      sock.ev.on('contacts.update', async (updates) => {
        const s = this.sessions.get(sessionName);
        if (!s || !s.lidToPhone) return;
        for (const contact of updates) {
          if (contact.id && contact.id.endsWith('@s.whatsapp.net') && contact.lid) {
            const ph = contact.id.replace('@s.whatsapp.net', '').replace(/\D/g, '');
            if (ph) {
              const lidNum = contact.lid.replace('@lid', '').replace(/\D/g, '');
              s.lidToPhone.set(contact.lid, ph);
              await this._persistResolvedLidPhone(sessionName, contact.lid, lidNum, ph);
            }
          }
        }
      });

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, isNewLogin } = update;
        const s = this.sessions.get(sessionName);

        console.log(`🔄 CONNECTION UPDATE ${sessionName}:`, {
          connection,
          isNewLogin,
          hasQr: !!qr,
          hasLastDisconnect: !!lastDisconnect,
          currentStatus: s?.status
        });

        if (qr) {
          const qrBase64 = await QRCode.toDataURL(qr);
          this.qrCodes.set(sessionName, qrBase64);
          if (s) { s.qrCode = qrBase64; s.status = 'qr_ready'; }
          console.log('✅ QR Code gerado para: ' + sessionName);
        }

        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = code !== DisconnectReason.loggedOut;
          console.log('❌ Conexao fechada ' + sessionName + ' code=' + code);
          if (s) { s.status = 'disconnected'; s.qrCode = null; }
          this.qrCodes.delete(sessionName);
          if (shouldReconnect) {
            setTimeout(() => this._connectSession(sessionName, webhookUrl), 3000);
          } else {
            const sessionDir = path.join(this.authDir, sessionName);
            try {
              if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
              console.log('Credenciais removidas (logout): ' + sessionName);
            } catch (e) { console.error('Erro ao limpar credenciais:', e.message); }
            if (s) s.status = 'connecting';
            setTimeout(() => this._connectSession(sessionName, webhookUrl), 3000);
          }
        } else if (connection === 'open') {
          console.log('🎉 SESSAO CONECTADA! ' + sessionName);
          if (s) {
            s.status = 'connected';
            s.qrCode = null;
            s.lastActivity = new Date().toISOString();
            s.connectedAt = new Date().toISOString();
            console.log('📱 Status sessão atualizado para CONNECTED:', sessionName);
          }
          this.qrCodes.delete(sessionName);
          this._updateDatabaseStatus(sessionName, 'connected', 'whatsapp_connected');
        } else if (connection === 'connecting') {
          console.log('🔄 Conectando... ' + sessionName);
          if (s) s.status = 'connecting';
        }
      });

      sock.ev.on('creds.update', saveCreds);

      // HANDLER MENSAGENS - apenas novas (type=notify)
      sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const messages = m.messages || [];
        for (const msg of messages) {
          if (!msg.key.fromMe && msg.message) {
            await this._processIncomingMessage(sessionName, msg);
          }
        }
      });

      console.log('Eventos registrados para: ' + sessionName);
    } catch (err) {
      console.error('_connectSession CRASH ' + sessionName + ':', err.message);
      const s = this.sessions.get(sessionName);
      if (s) s.status = 'error';
    }
  }

  async getQRCode(sessionName, _retries = 0) {
    const session = this.sessions.get(sessionName);
    const qrCode = this.qrCodes.get(sessionName);
    if (!session) {
      if (_retries > 0) {
        return { base64: null, qr: null, qrcode: null, status: 'disconnected', sessionName };
      }
      throw new Error('Sessao nao encontrada');
    }
    if (!qrCode && (session.status === 'connecting' || session.status === 'qr_ready') && _retries < 20) {
      await new Promise(r => setTimeout(r, 2000));
      return this.getQRCode(sessionName, _retries + 1);
    }
    return { base64: qrCode || null, qr: qrCode || null, qrcode: qrCode || null, status: session.status, sessionName };
  }

  getSessionStatus(sessionName) {
    const session = this.sessions.get(sessionName);
    if (!session) {
      console.log(`❌ Sessão ${sessionName} não encontrada`);
      return { sessionName, status: 'not_found', state: 'close' };
    }

    console.log(`🔍 GET STATUS ${sessionName}:`, {
      currentStatus: session.status,
      hasSocket: !!session.socket,
      hasUser: !!session.socket?.user,
      wsReadyState: session.socket?.ws?.readyState,
      hasQrCode: !!session.qrCode
    });

    if (session.status === 'connected') {
      try {
        if (!session.socket?.user?.id) {
          session.status = 'disconnected';
          console.log(`🔄 Status ${sessionName} atualizado: connected -> disconnected (no user)`);
        }
      } catch (err) {
        session.status = 'disconnected';
        console.log(`🔄 Status ${sessionName} erro: ${err.message}`);
      }
    } else if (session.status === 'connecting' || session.status === 'qr_ready') {
      try {
        if (session.socket?.user?.id) {
          console.log(`🔥 Conexao detectada para ${sessionName}!`);
          session.status = 'connected';
          session.connectedAt = new Date().toISOString();
          this._updateDatabaseStatus(sessionName, 'connected', 'force_detected');
        }
      } catch (err) {
        console.log(`Error force check ${sessionName}:`, err.message);
      }
    }

    let state = 'close';
    if (session.status === 'connected') state = 'open';
    else if (session.status === 'connecting' || session.status === 'qr_ready') state = 'connecting';

    const result = { sessionName, status: session.status, state, hasQR: !!session.qrCode, createdAt: session.createdAt };
    console.log(`📤 RETORNANDO STATUS ${sessionName}:`, result);
    return result;
  }

  async sendTextMessage(sessionName, jidOrPhone, message) {
    const session = this.sessions.get(sessionName);
    if (!session) throw new Error('Sessao nao encontrada: ' + sessionName);

    // Aceitar qr_ready quando socket ja tem user (status desatualizado)
    if (session.status !== 'connected') {
      if (session.socket?.user?.id) {
        session.status = 'connected';
        console.log('Status corrigido para connected antes de enviar: ' + sessionName);
      } else {
        throw new Error('Sessao nao conectada. Status: ' + session.status);
      }
    }

    const jid = jidOrPhone.includes('@') ? jidOrPhone : jidOrPhone.replace(/\D/g, '') + '@s.whatsapp.net';
    console.log('Enviando para JID: ' + jid);
    const result = await session.socket.sendMessage(jid, { text: message });
    return { success: true, messageId: result.key.id, to: jid, message, timestamp: new Date() };
  }

  getAllSessions() {
    const sessions = [];
    for (const [name] of this.sessions.entries()) {
      const info = this.getSessionStatus(name);
      sessions.push({ sessionName: name, status: info.status, state: info.state, hasQR: info.hasQR, createdAt: info.createdAt });
    }
    return sessions;
  }

  verifyAllSessions() {
    for (const [name] of this.sessions.entries()) this.getSessionStatus(name);
  }

  async deleteSession(sessionName) {
    const session = this.sessions.get(sessionName);
    if (session?.socket) try { session.socket.end(); } catch {}
    this.sessions.delete(sessionName);
    this.qrCodes.delete(sessionName);
    const dir = path.join(this.authDir, sessionName);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
    return { success: true };
  }

  async forceCheckConnection(sessionName) {
    const session = this.sessions.get(sessionName);
    if (!session) return { error: 'Sessao nao encontrada' };
    await this.checkAllConnections();
    await new Promise(r => setTimeout(r, 1000));
    return this.getSessionStatus(sessionName);
  }

  async _persistResolvedLidPhone(sessionName, lidJid, lidNum, realPhone) {
    try {
      const { supabaseAdmin } = require('../config/supabase');
      const { emitConversationUpdate } = require('./socketService');
      const now = new Date().toISOString();

      const { data: sessionRow } = await supabaseAdmin
        .from('evolution_sessions')
        .select('client_id')
        .eq('session_name', sessionName)
        .single();

      await supabaseAdmin.from('evolution_contacts')
        .update({ phone: realPhone, updated_at: now })
        .eq('phone', lidNum);

      let conversationsQuery = supabaseAdmin
        .from('evolution_conversations')
        .update({ phone: realPhone, updated_at: now })
        .eq('phone', lidNum)
        .select('*');

      if (sessionRow?.client_id) {
        conversationsQuery = conversationsQuery.eq('client_id', sessionRow.client_id);
      }

      const { data: updatedConversations, error: convErr } = await conversationsQuery;

      if (convErr) {
        throw convErr;
      }

      if (lidJid && sessionRow?.client_id) {
        const { data: jidConversations } = await supabaseAdmin
          .from('evolution_conversations')
          .select('*')
          .eq('client_id', sessionRow.client_id)
          .eq('jid', lidJid)
          .eq('phone', realPhone);

        for (const conv of (jidConversations || [])) {
          emitConversationUpdate(sessionRow.client_id, conv);
        }
      }

      for (const conv of (updatedConversations || [])) {
        if (sessionRow?.client_id) {
          emitConversationUpdate(sessionRow.client_id, conv);
        }
      }

      console.log('DB atualizado com telefone real: ' + lidNum + ' -> ' + realPhone);
    } catch (dbErr) {
      console.error('Erro persistindo resolucao LID:', dbErr.message);
    }
  }

  async _processIncomingMessage(sessionName, message) {
    try {
      const remoteJid = message.key?.remoteJid || '';

      // Ignorar grupos
      if (remoteJid.endsWith('@g.us')) return;

      let phone = '';
      let isLid = false;

      if (remoteJid.endsWith('@lid')) {
        isLid = true;
        const lidNum = remoteJid.replace('@lid', '').replace(/\D/g, '');

        // Tentativa 1: senderPn (campo direto da mensagem - Baileys 6+)
        phone = message.key?.senderPn || '';
        if (phone) {
          phone = phone.replace(/\D/g, '');
          console.log('LID resolvido via senderPn: ' + remoteJid + ' -> ' + phone);
        }

        // Tentativa 2: mapa LID->phone em memoria (construido via contacts.upsert)
        if (!phone) {
          const sessionObj = this.sessions.get(sessionName);
          phone = sessionObj?.lidToPhone?.get(remoteJid) || '';
          if (phone) console.log('LID resolvido via mapa: ' + remoteJid + ' -> ' + phone);
        }

        // Tentativa 3: participant
        if (!phone) {
          phone = (message.key?.participant || '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
        }

        // Tentativa 4: buscar no banco se esse LID ja foi resolvido antes
        if (!phone && lidNum) {
          try {
            const { supabaseAdmin } = require('../config/supabase');
            // Buscar conversa com esse JID que ja tenha phone real
            const { data: existingConv } = await supabaseAdmin
              .from('evolution_conversations')
              .select('phone')
              .eq('jid', remoteJid)
              .not('phone', 'is', null)
              .limit(1)
              .single();

            if (existingConv?.phone) {
              const existingDigits = existingConv.phone.replace(/\D/g, '');
              if (existingDigits.length >= 10 && existingDigits.length <= 13) {
                phone = existingDigits;
                console.log('LID resolvido via banco (conversa existente): ' + remoteJid + ' -> ' + phone);
              }
            }
          } catch (dbErr) {
            // Nao critico
          }
        }

        // Fallback: usar o numero numerico do LID como identificador unico
        if (!phone) {
          phone = lidNum;
          console.log('LID sem resolucao, usando ID como identificador: ' + phone);
        }

        console.log('LID detectado: ' + remoteJid + ' -> phone final: ' + phone);
      } else {
        phone = remoteJid.replace('@s.whatsapp.net', '');
      }

      phone = phone.replace(/\D/g, '');
      if (!phone) {
        console.log('Phone vazio apos extracao, ignorando. remoteJid: ' + remoteJid);
        return;
      }

      const content = message.message?.conversation
        || message.message?.extendedTextMessage?.text
        || message.message?.imageMessage?.caption
        || '[Midia]';

      console.log('Mensagem recebida de ' + phone + ': ' + content.substring(0, 50));

      const axios = require('axios');
      const PORT = process.env.PORT || 3003;
      await axios.post('http://localhost:' + PORT + '/internal/messages/process', {
        sessionName,
        phone,
        remoteJid,
        content,
        messageType: this._getMessageType(message),
        whatsappMessageId: message.key.id,
        pushName: message.pushName
      });
    } catch (error) {
      console.error('Erro processando mensagem:', error.message);
    }
  }

  _getMessageType(message) {
    if (message.message?.imageMessage) return 'image';
    if (message.message?.audioMessage) return 'audio';
    if (message.message?.videoMessage) return 'video';
    if (message.message?.documentMessage) return 'document';
    if (message.message?.stickerMessage) return 'sticker';
    return 'text';
  }

  async _updateDatabaseStatus(sessionName, status, reason) {
    try {
      const axios = require('axios');
      const PORT = process.env.PORT || 3003;
      await axios.put('http://localhost:' + PORT + '/internal/sessions/' + sessionName + '/status', {
        status, reason: reason || 'unknown', timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Erro atualizando banco ' + sessionName + ':', error.message);
    }
  }
}

module.exports = new BaileysService();
