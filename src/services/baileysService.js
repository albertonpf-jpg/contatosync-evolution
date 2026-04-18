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

    // Iniciar heartbeat para verificar conexões ativas
    this.startHeartbeat();
  }

  startHeartbeat() {
    // Verificar todas as sessões a cada 60 segundos
    setInterval(() => {
      this.checkAllConnections();
    }, 60000);
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
      console.log(`🔍 Testando conexão ${sessionName}...`);

      // Tentar acessar informações básicas que falham se desconectado
      if (!session.socket || !session.socket.user || !session.socket.user.id) {
        throw new Error('Socket ou user info não disponível');
      }

      console.log(`✅ Conexão ${sessionName} ativa`);

      // Marcar última verificação bem-sucedida
      session.lastHeartbeat = new Date().toISOString();

    } catch (error) {
      console.log(`❌ Conexão ${sessionName} falhou no teste:`, error.message);
      console.log(`🔄 Marcando ${sessionName} como desconectado`);

      // Marcar como desconectado
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

            // ATUALIZAR BANCO: marcar como desconectado
            this._updateDatabaseStatus(sessionName, 'disconnected', 'logout');
          }
        } else if (connection === 'open') {
          console.log(`✅ Sessão ${sessionName} conectada!`);
          console.log(`🔄 Status sendo atualizado: ${s?.status} -> connected`);
          if (s) {
            s.status = 'connected';
            s.qrCode = null;
            s.lastActivity = new Date().toISOString(); // Marcar atividade
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

    // REMOVER verificação por enquanto - está dando falso positivo
    // if (session.status === 'connected') {
    //   const socketExists = session.socket && session.socket.ws;
    //   if (!socketExists) {
    //     console.log(`⚠️ Socket ${sessionName} não existe, updating status`);
    //     session.status = 'disconnected';
    //     actualStatus = 'disconnected';
    //   }
    // }

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

  // Verificação ativa de conexão (timeout detection)
  _verifyActiveConnection(sessionName) {
    const session = this.sessions.get(sessionName);
    if (!session || session.status !== 'connected') return;

    // Evitar verificação muito frequente
    const now = Date.now();
    if (session.lastCheck && (now - session.lastCheck) < 30000) return; // 30s interval
    session.lastCheck = now;

    console.log(`🔍 Verificação timeout para ${sessionName}...`);

    // Verificar se há atividade recente (ex: última mensagem, evento)
    const lastActivity = session.lastActivity || session.createdAt;
    const timeSinceActivity = now - new Date(lastActivity).getTime();

    // Se não há atividade há mais de 5 minutos, considerar suspeito
    if (timeSinceActivity > 300000) { // 5 minutos
      console.log(`⏰ ${sessionName} sem atividade há ${Math.round(timeSinceActivity/1000/60)}min`);

      // Tentar um teste mais simples - verificar se user info ainda existe
      try {
        if (session.socket && session.socket.user) {
          console.log(`✅ User info OK para ${sessionName}`);
          session.lastActivity = new Date().toISOString();
        } else {
          console.log(`❌ User info perdido para ${sessionName}, marcando como desconectado`);
          session.status = 'disconnected';
        }
      } catch (error) {
        console.log(`❌ Erro verificando user info ${sessionName}:`, error.message);
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

  // Atualizar status no banco de dados
  async _updateDatabaseStatus(sessionName, status, reason = 'unknown') {
    try {
      console.log(`📊 Atualizando banco: ${sessionName} → ${status} (${reason})`);

      // Como não temos acesso direto ao Supabase aqui, vamos usar um endpoint interno
      // Alternativa: emitir evento para ser capturado pelo endpoint
      const axios = require('axios');

      // URL interna para atualizar status (mesmo servidor)
      const response = await axios.put(`http://localhost:${process.env.PORT || 3003}/internal/sessions/${sessionName}/status`, {
        status: status,
        reason: reason,
        timestamp: new Date().toISOString()
      });

      console.log(`✅ Banco atualizado para ${sessionName}: ${status}`);

    } catch (error) {
      console.error(`❌ Erro atualizando banco ${sessionName}:`, error.message);
      // Não falhar o processo principal se banco falha
    }
  }
}

module.exports = new BaileysService();
