const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

/**
 * Serviço Baileys para WhatsApp
 */
class BaileysService {
  constructor() {
    this.sessions = new Map();
    this.qrCodes = new Map();
    this.authDir = path.join(__dirname, '../../baileys_sessions');

    // Criar diretório se não existir
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }
  }

  /**
   * Criar nova sessão WhatsApp
   */
  async createSession(sessionName, webhookUrl = null) {
    try {
      console.log(`📱 Criando sessão Baileys: ${sessionName}`);

      // Registrar sessão imediatamente (antes de conectar)
      this.sessions.set(sessionName, {
        socket: null,
        saveCreds: null,
        status: 'connecting',
        qrCode: null,
        createdAt: new Date()
      });

      // Iniciar conexão em background (não bloqueia o request HTTP)
      this._connectSession(sessionName, webhookUrl).catch(err => {
        console.error(`❌ Erro background ao conectar ${sessionName}:`, err.message);
        const session = this.sessions.get(sessionName);
        if (session) session.status = 'error';
      });

      return {
        sessionName,
        status: 'created',
        message: 'Sessão criada com sucesso'
      };

    } catch (error) {
      console.error(`Erro ao criar sessão ${sessionName}:`, error);
      throw error;
    }
  }

  /**
   * Conectar sessão em background (não-bloqueante)
   */
  async _connectSession(sessionName, webhookUrl = null) {
    const sessionDir = path.join(this.authDir, sessionName);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      browser: ['ContatoSync', 'Chrome', '1.0.0'],
      connectTimeoutMs: 60000,
      logger: {
        level: 'warn',
        child: () => ({ level: 'warn', trace: () => {}, debug: () => {}, info: () => {}, warn: (...args) => console.log('⚠️ Baileys warn:', ...args), error: (...args) => console.error('❌ Baileys error:', ...args), fatal: (...args) => console.error('💀 Baileys fatal:', ...args) })
      }
    });

    // Atualizar sessão com socket real
    const session = this.sessions.get(sessionName);
    if (session) {
      session.socket = sock;
      session.saveCreds = saveCreds;
    }

      // Eventos do socket
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const session = this.sessions.get(sessionName);

        if (qr) {
          // Gerar QR Code base64
          const qrBase64 = await QRCode.toDataURL(qr);
          this.qrCodes.set(sessionName, qrBase64);

          if (session) {
            session.qrCode = qrBase64;
            session.status = 'qr_ready';
          }

          console.log(`📱 QR Code gerado para: ${sessionName}`);
        }

        if (connection === 'close') {
          const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
          console.log('Conexão fechada devido a ', lastDisconnect?.error, ', reconectando ', shouldReconnect);

          if (shouldReconnect) {
            // Reconectar se não foi logout
            setTimeout(() => this._connectSession(sessionName, webhookUrl), 3000);
          } else {
            // Remover sessão se foi logout
            this.sessions.delete(sessionName);
            this.qrCodes.delete(sessionName);
          }
        } else if (connection === 'open') {
          console.log(`✅ Sessão ${sessionName} conectada!`);
          if (session) {
            session.status = 'connected';
            session.qrCode = null; // Limpar QR após conectar
          }
          this.qrCodes.delete(sessionName); // QR não é mais necessário
        }
      });

      // Salvar credenciais quando atualizadas
      sock.ev.on('creds.update', saveCreds);
  }

  /**
   * Obter QR Code da sessão
   */
  async getQRCode(sessionName, _retries = 0) {
    const session = this.sessions.get(sessionName);
    const qrCode = this.qrCodes.get(sessionName);

    if (!session) {
      throw new Error('Sessão não encontrada');
    }

    // Aumentado para 10 tentativas (20 segundos total) - Railway é mais lento
    if (!qrCode && (session.status === 'connecting' || session.status === 'qr_ready') && _retries < 10) {
      console.log(`⏳ Aguardando QR Code para ${sessionName}... tentativa ${_retries + 1}/10`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return this.getQRCode(sessionName, _retries + 1);
    }

    console.log(`📱 getQRCode resultado: session=${sessionName}, hasQR=${!!qrCode}, status=${session.status}, retries=${_retries}`);

    return {
      base64: qrCode || null,
      qr: qrCode || null,
      qrcode: qrCode || null,
      status: session.status,
      sessionName
    };
  }

  /**
   * Verificar status da sessão
   */
  getSessionStatus(sessionName) {
    const session = this.sessions.get(sessionName);

    if (!session) {
      return {
        sessionName,
        status: 'not_found',
        state: 'close'
      };
    }

    let state = 'close';
    if (session.status === 'connected') state = 'open';
    else if (session.status === 'connecting' || session.status === 'qr_ready') state = 'connecting';

    return {
      sessionName,
      status: session.status,
      state,
      hasQR: !!session.qrCode,
      createdAt: session.createdAt
    };
  }

  /**
   * Enviar mensagem de texto
   */
  async sendTextMessage(sessionName, phone, message) {
    const session = this.sessions.get(sessionName);

    if (!session || session.status !== 'connected') {
      throw new Error('Sessão não conectada');
    }

    try {
      // Formatar número (adicionar @s.whatsapp.net se necessário)
      let jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;

      // Enviar mensagem
      const result = await session.socket.sendMessage(jid, { text: message });

      return {
        success: true,
        messageId: result.key.id,
        to: jid,
        message,
        timestamp: new Date()
      };

    } catch (error) {
      console.error(`Erro ao enviar mensagem via ${sessionName}:`, error);
      throw error;
    }
  }

  /**
   * Listar todas as sessões
   */
  getAllSessions() {
    const sessions = [];

    for (const [name, session] of this.sessions.entries()) {
      sessions.push({
        sessionName: name,
        status: session.status,
        hasQR: !!session.qrCode,
        createdAt: session.createdAt
      });
    }

    return sessions;
  }

  /**
   * Deletar sessão
   */
  async deleteSession(sessionName) {
    const session = this.sessions.get(sessionName);

    if (session) {
      // Fechar socket se estiver aberto
      if (session.socket) {
        session.socket.end();
      }

      // Remover da memória
      this.sessions.delete(sessionName);
      this.qrCodes.delete(sessionName);

      // Remover arquivos de auth
      const sessionDir = path.join(this.authDir, sessionName);
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true });
      }
    }

    return { success: true, message: 'Sessão deletada' };
  }
}

module.exports = new BaileysService();