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

    if (fs.existsSync(this.authDir)) {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.authDir, { recursive: true });
    console.log('🧹 Baileys sessions dir limpo no startup');

    this.startHeartbeat();
  }

  startHeartbeat() {
    setInterval(() => { this.checkAllConnections(); }, 60000);
    console.log('💓 Heartbeat iniciado - verificação a cada 60s');
  }

  async checkAllConnections() {
    for (const [sessionName, session] of this.sessions.entries()) {
      if (session.status === 'connected') {
        await this.testConnection(sessionName);
      }
    }
  }

  async testConnection(sessionName) {
    const session = this.sessions.get(sessionName);
    if (!session || session.status !== 'connected') return;
    try {
      if (!session.socket || !session.socket.user || !session.socket.user.id) {
        throw new Error('Socket ou user info não disponível');
      }
      console.log(`✅ Conexão ${sessionName} ativa`);
      session.lastHeartbeat = new Date().toISOString();
    } catch (error) {
      console.log(`❌ Conexão ${sessionName} falhou no teste:`, error.message);
      session.status = 'disconnected';
      session.lastError = error.message;
    }
  }

  async createSession(sessionName, webhookUrl = null) {
    try {
      console.log(`📱 Criando sessão Baileys: ${sessionName}`);
      this.sessions.set(sessionName, {
        socket: null, saveCreds: null, status: 'connecting', qrCode: null, createdAt: new Date()
      });
      this._connectSession(sessionName, webhookUrl).catch(err => {
        console.error(`❌ Erro background: ${sessionName}:`, err.message);
        const s = this.sessions.get(sessionName);
        if (s) s.status = 'error';
      });
      return { sessionName, status: 'created', message: 'Sessão criada' };
    } catch (error) {
      console.error(`Erro ao criar sessão ${sessionName}:`, error);
      throw error;
    }
  }

  async _connectSession(sessionName, webhookUrl = null) {
    try {
      const sessionDir = path.join(this.authDir, sessionName);
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      const { version } = await fetchLatestBaileysVersion();
      console.log(`✅ Baileys version: ${version}, auth loaded for: ${sessionName}`);

      const sock = makeWASocket({
        version,
        logger: makeSilentLogger(),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, makeSilentLogger()),
        },
        printQRInTerminal: false,
        browser: ['ContatoSync', 'Chrome', '120.0.0'],
        connectTimeoutMs: 60000
      });

      const session = this.sessions.get(sessionName);
      if (session) {
        session.socket = sock;
        session.saveCreds = saveCreds;
      }

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const s = this.sessions.get(sessionName);

        if (qr) {
          const qrBase64 = await QRCode.toDataURL(qr);
          this.qrCodes.set(sessionName, qrBase64);
          if (s) { s.qrCode = qrBase64; s.status = 'qr_ready'; }
          console.log(`📱 QR Code gerado para: ${sessionName}`);
        }

        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = code !== DisconnectReason.loggedOut;
          console.log(`❌ Conexão fechada ${sessionName}, code=${code}, reconnect=${shouldReconnect}`);
          if (s) { s.status = 'disconnected'; s.qrCode = null; }
          this.qrCodes.delete(sessionName);
          if (shouldReconnect) {
            console.log(`🔄 Tentando reconectar ${sessionName} em 3s...`);
            setTimeout(() => this._connectSession(sessionName, webhookUrl), 3000);
          } else {
            console.log(`🚫 ${sessionName} foi deslogado - removendo sessão`);
            this.sessions.delete(sessionName);
            this._updateDatabaseStatus(sessionName, 'disconnected', 'logout');
          }
        } else if (connection === 'open') {
          console.log(`✅ Sessão ${sessionName} conectada!`);
          if (s) {
            s.status = 'connected';
            s.qrCode = null;
            s.lastActivity = new Date().toISOString();
          }
          this.qrCodes.delete(sessionName);
          console.log(`📱 Estado final da sessão ${sessionName}: connected`);
        } else if (connection === 'connecting') {
          console.log(`🔄 ${sessionName} conectando...`);
          if (s) s.status = 'connecting';
        }
      });

      sock.ev.on('creds.update', saveCreds);

      // ============================================================
      // HANDLER DE MENSAGENS — CORRIGIDO: fix LID via senderPn
      // ============================================================
      sock.ev.on('messages.upsert', async (m) => {
        const messages = m.messages || [];
        for (const msg of messages) {
          if (!msg.key.fromMe && msg.message) {
            await this._processIncomingMessage(sessionName, msg);
          }
        }
      });

      console.log(`✅ Eventos registrados para: ${sessionName}`);
    } catch (err) {
      console.error(`💀 _connectSession CRASH ${sessionName}:`, err.message);
      const s = this.sessions.get(sessionName);
      if (s) s.status = 'error';
    }
  }

  async getQRCode(sessionName, _retries = 0) {
    const session = this.sessions.get(sessionName);
    const qrCode = this.qrCodes.get(sessionName);
    if (!session) throw new Error('Sessão não encontrada');
    if (!qrCode && (session.status === 'connecting' || session.status === 'qr_ready') && _retries < 10) {
      console.log(`⏳ Aguardando QR ${sessionName}... ${_retries + 1}/10`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return this.getQRCode(sessionName, _retries + 1);
    }
    return { base64: qrCode || null, qr: qrCode || null, qrcode: qrCode || null, status: session.status, sessionName };
  }

  getSessionStatus(sessionName) {
    const session = this.sessions.get(sessionName);
    if (!session) return { sessionName, status: 'not_found', state: 'close' };
    let state = 'close';
    if (session.status === 'connected') state = 'open';
    else if (session.status === 'connecting' || session.status === 'qr_ready') state = 'connecting';
    return {
      sessionName, status: session.status, state,
      hasQR: !!session.qrCode, createdAt: session.createdAt,
      socketState: session.socket?.ws?.readyState || 'no_socket'
    };
  }

  async sendTextMessage(sessionName, phone, message) {
    const session = this.sessions.get(sessionName);
    if (!session || session.status !== 'connected') throw new Error('Sessão não conectada');
    let jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
    const result = await session.socket.sendMessage(jid, { text: message });
    return { success: true, messageId: result.key.id, to: jid, message, timestamp: new Date() };
  }

  getAllSessions() {
    const sessions = [];
    for (const [name, session] of this.sessions.entries()) {
      const statusInfo = this.getSessionStatus(name);
      sessions.push({
        sessionName: name, status: statusInfo.status, state: statusInfo.state,
        hasQR: !!session.qrCode, createdAt: session.createdAt
      });
    }
    return sessions;
  }

  verifyAllSessions() {
    for (const [sessionName] of this.sessions.entries()) {
      this.getSessionStatus(sessionName);
    }
  }

  async deleteSession(sessionName) {
    const session = this.sessions.get(sessionName);
    if (session && session.socket) {
      try { session.socket.end(); } catch(e) {}
    }
    this.sessions.delete(sessionName);
    this.qrCodes.delete(sessionName);
    const sessionDir = path.join(this.authDir, sessionName);
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true });
    return { success: true, message: 'Sessão deletada' };
  }

  async forceCheckConnection(sessionName) {
    const session = this.sessions.get(sessionName);
    if (!session) return { error: 'Sessão não encontrada' };
    await this.testConnection(sessionName);
    await new Promise(resolve => setTimeout(resolve, 1000));
    return this.getSessionStatus(sessionName);
  }

  // ============================================================
  // PROCESSAR MENSAGEM — CORRIGIDO: LID fix + phone extraction
  // ============================================================
  async _processIncomingMessage(sessionName, message) {
    try {
      const session = this.sessions.get(sessionName);
      if (!session) return;

      const remoteJid = message.key?.remoteJid || '';

      // ========== FIX LID ==========
      // WhatsApp pode enviar remoteJid como LID (ex: 166507946496046@lid)
      // Número real fica em message.key.senderPn ou participant
      let phone = '';

      if (remoteJid.endsWith('@lid')) {
        // LID: usar senderPn que contém número real
        phone = message.key?.senderPn || '';
        if (!phone) {
          // Fallback: tentar participant
          phone = message.key?.participant?.replace('@s.whatsapp.net', '') || '';
        }
        console.log(`📞 LID detectado: ${remoteJid} → senderPn: ${phone}`);
      } else {
        // Número normal
        phone = remoteJid.replace('@s.whatsapp.net', '').replace('@g.us', '');
      }

      // Ignorar mensagens de grupo por enquanto
      if (remoteJid.endsWith('@g.us')) {
        console.log(`👥 Mensagem de grupo ignorada: ${remoteJid}`);
        return;
      }

      // Limpar phone — só dígitos
      phone = phone.replace(/\D/g, '');

      if (!phone) {
        console.log(`⚠️ Phone vazio, ignorando mensagem. remoteJid: ${remoteJid}`);
        return;
      }

      const messageContent =
        message.message?.conversation ||
        message.message?.extendedTextMessage?.text ||
        message.message?.imageMessage?.caption ||
        '[Mídia]';

      console.log(`📩 Mensagem recebida de ${phone}: ${messageContent.substring(0, 50)}...`);

      // Chamar endpoint interno pra persistir
      const axios = require('axios');
      const PORT = process.env.PORT || 3003;

      await axios.post(`http://localhost:${PORT}/internal/messages/process`, {
        sessionName,
        phone,
        content: messageContent,
        messageType: this._getMessageType(message),
        whatsappMessageId: message.key.id,
        pushName: message.pushName
      });

    } catch (error) {
      console.error('❌ Erro processando mensagem:', error.message);
    }
  }

  _getMessageType(message) {
    if (message.message?.imageMessage) return 'image';
    if (message.message?.audioMessage) return 'audio';
    if (message.message?.videoMessage) return 'video';
    if (message.message?.documentMessage) return 'document';
    if (message.message?.stickerMessage) return 'sticker';
    if (message.message?.contactMessage) return 'contact';
    if (message.message?.locationMessage) return 'location';
    return 'text';
  }

  async _updateDatabaseStatus(sessionName, status, reason = 'unknown') {
    try {
      const axios = require('axios');
      const PORT = process.env.PORT || 3003;
      await axios.put(`http://localhost:${PORT}/internal/sessions/${sessionName}/status`, {
        status, reason, timestamp: new Date().toISOString()
      });
      console.log(`✅ Banco atualizado para ${sessionName}: ${status}`);
    } catch (error) {
      console.error(`❌ Erro atualizando banco ${sessionName}:`, error.message);
    }
  }
}

module.exports = new BaileysService();
