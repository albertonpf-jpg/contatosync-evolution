const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

// Importação direta CommonJS igual ao ContatoSync original
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

// Silent logger igual ao ContatoSync original
function makeSilentLogger() {
  const noop = () => {};
  return { level: 'silent', trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => makeSilentLogger() };
}

class BaileysService {
  constructor() {
    this.sessions = new Map();
    this.qrCodes = new Map();
    this.authDir = path.join(__dirname, '../../baileys_sessions');
    // Limpar sessões antigas no startup (Railway reseta filesystem)
    if (fs.existsSync(this.authDir)) {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.authDir, { recursive: true });
    console.log('🧹 Baileys sessions dir limpo no startup');
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
      if (session) { session.socket = sock; session.saveCreds = saveCreds; }

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

          // SEMPRE atualizar status para disconnected quando connection fecha
          if (s) {
            s.status = 'disconnected';
            s.qrCode = null;
          }
          this.qrCodes.delete(sessionName);

          if (shouldReconnect) {
            console.log(`🔄 Tentando reconectar ${sessionName} em 3s...`);
            setTimeout(() => this._connectSession(sessionName, webhookUrl), 3000);
          } else {
            console.log(`🚫 ${sessionName} foi deslogado - removendo sessão`);
            this.sessions.delete(sessionName);
          }
        } else if (connection === 'open') {
          console.log(`✅ Sessão ${sessionName} conectada!`);
          console.log(`🔄 Status sendo atualizado: ${s?.status} -> connected`);
          if (s) {
            s.status = 'connected';
            s.qrCode = null;
            console.log(`🗑️ QR Code removido para ${sessionName}`);
          }
          this.qrCodes.delete(sessionName);
          console.log(`📱 Estado final da sessão ${sessionName}:`, {
            status: s?.status,
            hasQrCode: !!s?.qrCode,
            socketState: sock?.ws?.readyState
          });
        } else if (connection === 'connecting') {
          console.log(`🔄 ${sessionName} conectando...`);
          if (s) { s.status = 'connecting'; }
        }
      });

      sock.ev.on('creds.update', saveCreds);
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

    // Verificar se socket ainda existe e está conectado
    let actualStatus = session.status;

    // Verificação correta para Baileys v6.6.0
    if (session.status === 'connected') {
      // Verificar se socket e ws existem (readyState é undefined no v6.6.0)
      const socketExists = session.socket && session.socket.ws;

      if (!socketExists) {
        console.log(`⚠️ Socket ${sessionName} não existe, updating status`);
        session.status = 'disconnected';
        actualStatus = 'disconnected';
      } else {
        // Verificação adicional: tentar ping ativo (a cada 30s max)
        this._verifyActiveConnection(sessionName);
      }
    }

    let state = 'close';
    if (actualStatus === 'connected') state = 'open';
    else if (actualStatus === 'connecting' || actualStatus === 'qr_ready') state = 'connecting';

    return {
      sessionName,
      status: actualStatus,
      state,
      hasQR: !!session.qrCode,
      createdAt: session.createdAt,
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
      // Verificar status real de cada sessão
      const statusInfo = this.getSessionStatus(name);
      sessions.push({
        sessionName: name,
        status: statusInfo.status,
        state: statusInfo.state,
        hasQR: !!session.qrCode,
        createdAt: session.createdAt
      });
    }
    return sessions;
  }

  // Método para verificar e corrigir status de todas as sessões
  verifyAllSessions() {
    console.log('🔍 Verificando status de todas as sessões...');
    for (const [sessionName] of this.sessions.entries()) {
      this.getSessionStatus(sessionName); // Isso atualiza o status se necessário
    }
  }

  // Verificação ativa de conexão (ping test)
  _verifyActiveConnection(sessionName) {
    const session = this.sessions.get(sessionName);
    if (!session || session.status !== 'connected') return;

    // Evitar ping muito frequente
    const now = Date.now();
    if (session.lastPing && (now - session.lastPing) < 30000) return; // 30s interval
    session.lastPing = now;

    console.log(`🏓 Ping test para ${sessionName}...`);

    try {
      // Tentar uma operação simples que falhará se desconectado
      session.socket.query({
        tag: 'iq',
        attrs: { type: 'get', xmlns: 'w:sync:app:state' },
        content: []
      }).then((result) => {
        console.log(`✅ Ping OK para ${sessionName}`);
        // Conexão está ativa
      }).catch((error) => {
        console.log(`❌ Ping falhou para ${sessionName}:`, error.message);
        // Marcar como desconectado
        if (session.status === 'connected') {
          console.log(`🔄 Marcando ${sessionName} como desconectado devido a ping failure`);
          session.status = 'disconnected';
        }
      });
    } catch (error) {
      console.log(`❌ Erro no ping test ${sessionName}:`, error.message);
      // Socket não responde, marcar como desconectado
      if (session.status === 'connected') {
        session.status = 'disconnected';
      }
    }
  }

  async deleteSession(sessionName) {
    const session = this.sessions.get(sessionName);
    if (session && session.socket) { try { session.socket.end(); } catch(e) {} }
    this.sessions.delete(sessionName);
    this.qrCodes.delete(sessionName);
    const sessionDir = path.join(this.authDir, sessionName);
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true });
    return { success: true, message: 'Sessão deletada' };
  }

  // Método manual para forçar verificação de conexão
  async forceCheckConnection(sessionName) {
    const session = this.sessions.get(sessionName);
    if (!session) return { error: 'Sessão não encontrada' };

    console.log(`🔍 Verificação forçada para ${sessionName}`);

    // Reset do timestamp para forçar ping
    session.lastPing = 0;
    this._verifyActiveConnection(sessionName);

    // Aguardar um pouco e retornar status atualizado
    await new Promise(resolve => setTimeout(resolve, 1000));
    return this.getSessionStatus(sessionName);
  }
}

module.exports = new BaileysService();
