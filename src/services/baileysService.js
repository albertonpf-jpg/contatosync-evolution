const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { createStoredFile, sanitizeFileName } = require('../utils/mediaStore');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  downloadContentFromMessage,
  extractMessageContent,
  getContentType
} = require('@whiskeysockets/baileys');

function makeSilentLogger() {
  const noop = () => {};
  return {
    level: 'silent',
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
    child: () => makeSilentLogger()
  };
}

function fileSizeOrZero(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}

const MAX_SENT_MESSAGE_CACHE = 200;

class BaileysService {
  constructor() {
    this.sessions = new Map();
    this.qrCodes = new Map();
    this.authDir = process.env.BAILEYS_AUTH_DIR
      || process.env.RAILWAY_VOLUME_MOUNT_PATH
      || path.join(__dirname, '../../baileys_sessions');
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }
    console.log('Baileys sessions dir: ' + this.authDir);
    this.startHeartbeat();
  }

  _rememberSentMessage(sessionName, key, message) {
    const id = typeof key === 'string' ? key : key?.id;
    if (!id || !message) return;
    const session = this.sessions.get(sessionName);
    if (!session) return;
    if (!session.sentMessages) session.sentMessages = new Map();
    session.sentMessages.set(id, message);
    while (session.sentMessages.size > MAX_SENT_MESSAGE_CACHE) {
      const oldestKey = session.sentMessages.keys().next().value;
      session.sentMessages.delete(oldestKey);
    }
  }

  _getSentMessage(sessionName, key) {
    const id = key?.id || key;
    if (!id) return undefined;
    return this.sessions.get(sessionName)?.sentMessages?.get(id);
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
        } catch (err) {
          console.log('Sessao ' + name + ' perdeu conexao: ' + err.message);
          session.status = 'disconnected';
          this._updateDatabaseStatus(name, 'disconnected', 'heartbeat_failed');
        }
      }
    }
  }

  async createSession(sessionName, webhookUrl = null) {
    console.log('Criando sessao Baileys: ' + sessionName);
    this.sessions.set(sessionName, {
      socket: null, saveCreds: null, status: 'connecting',
      qrCode: null, createdAt: new Date(),
      lidToPhone: new Map(),
      contactsStore: new Map(),
      sentMessages: new Map()
    });
    this._connectSession(sessionName, webhookUrl).catch(err => {
      console.error('Erro background ' + sessionName + ':', err.message);
      const s = this.sessions.get(sessionName);
      if (s) s.status = 'error';
    });
    return { sessionName, status: 'created', message: 'Sessao criada' };
  }

  _isRealPhone(phone) {
    const digits = (phone || '').replace(/\D/g, '');
    return digits.startsWith('55') && digits.length >= 12 && digits.length <= 13;
  }

  _jidToDigits(jid) {
    return (jid || '').split('@')[0].replace(/\D/g, '');
  }

  _normalizeLidJid(value) {
    if (!value) return '';
    const digits = this._jidToDigits(value);
    return digits ? digits + '@lid' : '';
  }

  _extractPhoneJid(value) {
    if (!value) return '';
    if (typeof value === 'string') {
      return value.endsWith('@s.whatsapp.net') ? value : '';
    }
    return '';
  }

  async _rememberLidMapping(sessionName, lidValue, phoneValue, source) {
    const lidJid = this._normalizeLidJid(lidValue);
    const phoneDigits = this._jidToDigits(phoneValue);
    if (!lidJid || !this._isRealPhone(phoneDigits)) return '';

    const session = this.sessions.get(sessionName);
    if (session?.lidToPhone) {
      const lidNum = this._jidToDigits(lidJid);
      session.lidToPhone.set(lidJid, phoneDigits);
      session.lidToPhone.set(lidNum, phoneDigits);
    }

    console.log('[LID MAP] ' + lidJid + ' -> ' + phoneDigits + ' (' + source + ')');
    await this._persistResolvedLidPhone(sessionName, lidJid, this._jidToDigits(lidJid), phoneDigits);
    return phoneDigits;
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
        connectTimeoutMs: 120000, defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000, markOnlineOnConnect: false,
        syncFullHistory: false, shouldSyncHistoryMessage: () => false,
        maxMsgRetryCount: 3, retryRequestDelayMs: 250,
        shouldIgnoreJid: () => false, linkPreviewImageThumbnailWidth: 192,
        transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 },
        getMessage: async (key) => {
          const cachedMessage = this._getSentMessage(sessionName, key);
          if (!cachedMessage) {
            console.warn('[BAILEYS] getMessage sem cache id=' + (key?.id || 'unknown'));
          }
          return cachedMessage;
        }
      });

      const session = this.sessions.get(sessionName);
      if (session) { session.socket = sock; session.saveCreds = saveCreds; }

      // ── CAPTURA DE CONTATOS — alimenta lidToPhone e contactsStore ──
      sock.ev.on('contacts.upsert', async (contacts) => {
        const s = this.sessions.get(sessionName);
        if (!s) return;
        if (!s.lidToPhone) s.lidToPhone = new Map();
        if (!s.contactsStore) s.contactsStore = new Map();

        for (const contact of contacts) {
          if (contact.id) s.contactsStore.set(contact.id, contact);
          if (contact.phoneNumber) s.contactsStore.set(contact.phoneNumber, contact);
          if (contact.lid) s.contactsStore.set(this._normalizeLidJid(contact.lid), contact);

          const phoneJid = this._extractPhoneJid(contact.phoneNumber) || this._extractPhoneJid(contact.id);
          const lidJid = contact.lid || (contact.id && contact.id.endsWith('@lid') ? contact.id : '');
          if (phoneJid && lidJid) {
            await this._rememberLidMapping(sessionName, lidJid, phoneJid, 'contacts.upsert');
          }
        }
        console.log('[LID MAP] Total: ' + s.lidToPhone.size + ' | Store: ' + s.contactsStore.size);
      });

      sock.ev.on('contacts.update', async (updates) => {
        const s = this.sessions.get(sessionName);
        if (!s) return;
        if (!s.lidToPhone) s.lidToPhone = new Map();
        if (!s.contactsStore) s.contactsStore = new Map();
        for (const contact of updates) {
          if (contact.id) {
            const existing = s.contactsStore.get(contact.id) || {};
            s.contactsStore.set(contact.id, { ...existing, ...contact });
          }
          if (contact.phoneNumber) s.contactsStore.set(contact.phoneNumber, { ...(s.contactsStore.get(contact.phoneNumber) || {}), ...contact });
          if (contact.lid) s.contactsStore.set(this._normalizeLidJid(contact.lid), { ...(s.contactsStore.get(this._normalizeLidJid(contact.lid)) || {}), ...contact });

          const phoneJid = this._extractPhoneJid(contact.phoneNumber) || this._extractPhoneJid(contact.id);
          const lidJid = contact.lid || (contact.id && contact.id.endsWith('@lid') ? contact.id : '');
          if (phoneJid && lidJid) {
            await this._rememberLidMapping(sessionName, lidJid, phoneJid, 'contacts.update');
          }
        }
      });

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const s = this.sessions.get(sessionName);

        if (qr) {
          const qrBase64 = await QRCode.toDataURL(qr);
          this.qrCodes.set(sessionName, qrBase64);
          if (s) { s.qrCode = qrBase64; s.status = 'qr_ready'; }
          this._updateDatabaseStatus(sessionName, 'qr_pending', 'qr_generated');
          console.log('QR Code gerado para: ' + sessionName);
        }

        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = code !== DisconnectReason.loggedOut;
          console.log('Conexao fechada ' + sessionName + ' code=' + code);
          if (s) { s.status = 'disconnected'; s.qrCode = null; }
          this.qrCodes.delete(sessionName);
          this._updateDatabaseStatus(sessionName, 'disconnected', 'connection_closed_' + (code || 'unknown'));
          if (shouldReconnect) {
            setTimeout(() => this._connectSession(sessionName, webhookUrl), 3000);
          } else {
            const sessionDir2 = path.join(this.authDir, sessionName);
            try { if (fs.existsSync(sessionDir2)) fs.rmSync(sessionDir2, { recursive: true, force: true }); } catch (e) {}
            if (s) s.status = 'connecting';
            setTimeout(() => this._connectSession(sessionName, webhookUrl), 3000);
          }
        } else if (connection === 'open') {
          console.log('SESSAO CONECTADA! ' + sessionName);
          if (s) { s.status = 'connected'; s.qrCode = null; s.lastActivity = new Date().toISOString(); s.connectedAt = new Date().toISOString(); }
          this.qrCodes.delete(sessionName);
          this._updateDatabaseStatus(sessionName, 'connected', 'whatsapp_connected');
        } else if (connection === 'connecting') {
          if (s) s.status = 'connecting';
          this._updateDatabaseStatus(sessionName, 'connecting', 'connection_update');
        }
      });

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('messages.upsert', async (m) => {
        const messages = m.messages || [];
        for (const msg of messages) {
          if (msg.key.fromMe && msg.message) {
            this._rememberSentMessage(sessionName, msg.key, msg.message);
          } else if (m.type === 'notify' && msg.message) {
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
      if (_retries > 0) return { base64: null, qr: null, qrcode: null, status: 'disconnected', sessionName };
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
    if (!session) return { sessionName, status: 'not_found', state: 'close' };
    if (session.status === 'connected') {
      try { if (!session.socket?.user?.id) { session.status = 'disconnected'; } } catch (err) { session.status = 'disconnected'; }
    } else if (session.status === 'connecting' || session.status === 'qr_ready') {
      try {
        if (session.socket?.user?.id) {
          session.status = 'connected'; session.connectedAt = new Date().toISOString();
          this._updateDatabaseStatus(sessionName, 'connected', 'force_detected');
        }
      } catch (err) {}
    }
    let state = 'close';
    if (session.status === 'connected') state = 'open';
    else if (session.status === 'connecting' || session.status === 'qr_ready') state = 'connecting';
    return { sessionName, status: session.status, state, hasQR: !!session.qrCode, createdAt: session.createdAt };
  }

  async sendTextMessage(sessionName, jidOrPhone, message) {
    const session = this.sessions.get(sessionName);
    if (!session) throw new Error('Sessao nao encontrada: ' + sessionName);
    if (session.status !== 'connected') {
      if (session.socket?.user?.id) { session.status = 'connected'; }
      else { throw new Error('Sessao nao conectada. Status: ' + session.status); }
    }
    const jid = jidOrPhone.includes('@') ? jidOrPhone : jidOrPhone.replace(/\D/g, '') + '@s.whatsapp.net';
    const result = await session.socket.sendMessage(jid, { text: message });
    this._rememberSentMessage(sessionName, result?.key, result?.message || { conversation: message });
    return { success: true, messageId: result.key.id, to: jid, message, timestamp: new Date() };
  }

  async sendMediaMessage(sessionName, jidOrPhone, media) {
    const session = this.sessions.get(sessionName);
    if (!session) throw new Error('Sessao nao encontrada: ' + sessionName);
    if (session.status !== 'connected') {
      if (session.socket?.user?.id) { session.status = 'connected'; }
      else { throw new Error('Sessao nao conectada. Status: ' + session.status); }
    }

    const jid = jidOrPhone.includes('@') ? jidOrPhone : jidOrPhone.replace(/\D/g, '') + '@s.whatsapp.net';
    let mediaPath = media.path;
    let mimetype = String(media.mimetype || 'application/octet-stream').split(';')[0].trim();
    const caption = media.caption || '';
    const fileName = sanitizeFileName(media.fileName || media.originalName || 'arquivo');
    const type = this._normalizeOutgoingMediaType(media.messageType, mimetype, fileName);
    console.log('[MEDIA SEND] source path=' + mediaPath + ' exists=' + fs.existsSync(mediaPath) + ' size=' + fileSizeOrZero(mediaPath));
    if (type === 'audio' && mimetype !== 'audio/ogg' && mimetype !== 'audio/opus') {
      const converted = await this._convertAudioForWhatsApp(mediaPath);
      mediaPath = converted.path;
      mimetype = converted.mimetype;
      console.log('[MEDIA SEND] converted path=' + mediaPath + ' exists=' + fs.existsSync(mediaPath) + ' size=' + fileSizeOrZero(mediaPath));
    }
    const buffer = fs.readFileSync(mediaPath);
    let payload;

    if (type === 'image') {
      payload = { image: buffer, mimetype, caption };
    } else if (type === 'video' || type === 'gif') {
      payload = { video: buffer, mimetype, caption, gifPlayback: type === 'gif' || mimetype === 'image/gif' };
    } else if (type === 'audio') {
      payload = { audio: { url: mediaPath }, mimetype, ptt: !!media.ptt };
    } else if (type === 'sticker') {
      payload = { sticker: buffer, mimetype };
    } else {
      payload = { document: buffer, mimetype, fileName, caption };
    }

    console.log('[MEDIA SEND] type=' + type + ' mime=' + mimetype + ' size=' + buffer.length + ' to=' + jid);
    const result = await session.socket.sendMessage(jid, payload);
    this._rememberSentMessage(sessionName, result?.key, result?.message);
    console.log('[MEDIA SEND] sent id=' + (result?.key?.id || 'unknown') + ' type=' + type + ' mime=' + mimetype);
    return { success: true, messageId: result.key.id, to: jid, messageType: type, timestamp: new Date() };
  }

  async _convertAudioForWhatsApp(inputPath) {
    if (!ffmpegPath) throw new Error('ffmpeg nao disponivel para converter audio');
    const outputPath = inputPath.replace(/\.[^.]+$/, '') + '-whatsapp.ogg';
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, [
        '-y',
        '-i', inputPath,
        '-vn',
        '-c:a', 'libopus',
        '-b:a', '32k',
        '-ar', '48000',
        '-ac', '1',
        '-f', 'ogg',
        outputPath
      ], (error, _stdout, stderr) => {
        if (error) {
          error.message = error.message + (stderr ? ' | ' + stderr.slice(-500) : '');
          reject(error);
          return;
        }
        resolve();
      });
    });
    const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
    if (!size) throw new Error('conversao de audio gerou arquivo vazio');
    console.log('[MEDIA SEND] audio converted to ogg/opus size=' + size);
    return { path: outputPath, mimetype: 'audio/ogg' };
  }

  getAllSessions() {
    const sessions = [];
    for (const [name] of this.sessions.entries()) {
      const info = this.getSessionStatus(name);
      sessions.push({ sessionName: name, status: info.status, state: info.state, hasQR: info.hasQR, createdAt: info.createdAt });
    }
    return sessions;
  }

  verifyAllSessions() { for (const [name] of this.sessions.entries()) this.getSessionStatus(name); }

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
      const { emitConversationUpdate, emitContactUpdate } = require('./socketService');
      const now = new Date().toISOString();
      const { data: sessionRow } = await supabaseAdmin.from('evolution_sessions').select('client_id').eq('session_name', sessionName).single();
      let realPhoneContact = null;
      if (sessionRow?.client_id) {
        const realContactResult = await supabaseAdmin
          .from('evolution_contacts')
          .select('*')
          .eq('client_id', sessionRow.client_id)
          .eq('phone', realPhone)
          .single();
        realPhoneContact = realContactResult.data || null;
      }

      if (realPhoneContact) {
        await supabaseAdmin
          .from('evolution_conversations')
          .update({ contact_id: realPhoneContact.id, contact_name: realPhoneContact.name, phone: realPhone, updated_at: now })
          .eq('client_id', sessionRow.client_id)
          .eq('phone', lidNum);
        if (lidJid) {
          await supabaseAdmin
            .from('evolution_conversations')
            .update({ contact_id: realPhoneContact.id, contact_name: realPhoneContact.name, phone: realPhone, updated_at: now })
            .eq('client_id', sessionRow.client_id)
            .eq('jid', lidJid);
        }
        const { data: lidContacts } = await supabaseAdmin
          .from('evolution_contacts')
          .select('id')
          .eq('client_id', sessionRow.client_id)
          .eq('phone', lidNum);
        const lidContactIds = (lidContacts || []).map(contact => contact.id);
        if (lidContactIds.length > 0) {
          await supabaseAdmin
            .from('evolution_messages')
            .update({ contact_id: realPhoneContact.id })
            .eq('client_id', sessionRow.client_id)
            .in('contact_id', lidContactIds);
        }
        await supabaseAdmin
          .from('evolution_contacts')
          .delete()
          .eq('client_id', sessionRow.client_id)
          .eq('phone', lidNum);
        emitContactUpdate(sessionRow.client_id, { ...realPhoneContact, phone: realPhone, updated_at: now });
      }

      // Atualizar contatos com LID como telefone
      let contactsQuery = supabaseAdmin
        .from('evolution_contacts')
        .update({ phone: realPhone, updated_at: now })
        .eq('phone', lidNum)
        .select('*');
      if (sessionRow?.client_id) contactsQuery = contactsQuery.eq('client_id', sessionRow.client_id);
      const { data: updatedContacts, error: contactErr } = await contactsQuery;
      if (contactErr) throw contactErr;
      for (const contact of (updatedContacts || [])) {
        if (sessionRow?.client_id) emitContactUpdate(sessionRow.client_id, contact);
      }

      // Atualizar conversas com LID como telefone
      let conversationsQuery = supabaseAdmin.from('evolution_conversations').update({ phone: realPhone, updated_at: now }).eq('phone', lidNum).select('*');
      if (sessionRow?.client_id) conversationsQuery = conversationsQuery.eq('client_id', sessionRow.client_id);
      const { data: updatedConversations, error: convErr } = await conversationsQuery;
      if (convErr) throw convErr;

      // Atualizar conversas pelo JID @lid
      if (lidJid && sessionRow?.client_id) {
        const { data: jidConversations } = await supabaseAdmin
          .from('evolution_conversations')
          .update({ phone: realPhone, updated_at: now })
          .eq('client_id', sessionRow.client_id)
          .eq('jid', lidJid)
          .select('*');
        for (const conv of (jidConversations || [])) {
          emitConversationUpdate(sessionRow.client_id, {
            ...conv,
            evolution_contacts: { phone: realPhone }
          });
        }
      }
      for (const conv of (updatedConversations || [])) {
        if (sessionRow?.client_id) {
          emitConversationUpdate(sessionRow.client_id, {
            ...conv,
            evolution_contacts: { phone: realPhone }
          });
        }
      }
      console.log('[LID PERSIST] ' + lidNum + ' -> ' + realPhone);
    } catch (dbErr) { console.error('Erro persistindo resolucao LID:', dbErr.message); }
  }

  async _processIncomingMessage(sessionName, message) {
    try {
      const remoteJid = message.key?.remoteJid || '';
      if (remoteJid.endsWith('@g.us')) return;
      const sessionObj = this.sessions.get(sessionName);
      const sock = sessionObj?.socket;
      let phone = '';
      let isLid = false;

      if (remoteJid.endsWith('@lid')) {
        isLid = true;
        const lidNum = remoteJid.replace('@lid', '').replace(/\D/g, '');

        // T1: alternate PN fields from newer Baileys versions.
        const altPhoneJids = [
          message.key?.remoteJidAlt,
          message.key?.participantAlt,
          message.key?.senderPn,
          message.key?.participantPn
        ].filter(Boolean);

        for (const candidate of altPhoneJids) {
          const candidateDigits = this._jidToDigits(candidate);
          if (this._isRealPhone(candidateDigits)) {
            phone = await this._rememberLidMapping(sessionName, remoteJid, candidate, 'message.key.alt');
            break;
          }
        }

        // T2: mapa memória
        if (!phone && sessionObj?.lidToPhone) {
          phone = sessionObj.lidToPhone.get(remoteJid) || sessionObj.lidToPhone.get(lidNum) || '';
          if (phone && this._isRealPhone(phone)) {
            console.log('[LID T2] mapa: ' + remoteJid + ' -> ' + phone);
          } else { phone = ''; }
        }

        // T3: contactsStore (varredura de todos os contatos em memória)
        if (!phone && sessionObj?.contactsStore) {
          for (const [cid, contact] of sessionObj.contactsStore.entries()) {
            const cLid = contact.lid || (contact.id && contact.id.endsWith('@lid') ? contact.id : '');
            const cLidJid = cLid.endsWith('@lid') ? cLid : cLid + '@lid';
            if (cLidJid === remoteJid || cLid.replace('@lid', '').replace(/\D/g, '') === lidNum) {
              const phoneJid = this._extractPhoneJid(contact.phoneNumber) || this._extractPhoneJid(cid);
              if (phoneJid) {
                const cp = this._jidToDigits(phoneJid);
                if (this._isRealPhone(cp)) {
                  phone = await this._rememberLidMapping(sessionName, remoteJid, phoneJid, 'contactsStore');
                  break;
                }
              }
            }
          }
        }

        // T4: participant
        if (!phone) {
          const participant = message.key?.participant || '';
          phone = this._jidToDigits(participant);
          if (participant.endsWith('@s.whatsapp.net') && this._isRealPhone(phone)) {
            phone = await this._rememberLidMapping(sessionName, remoteJid, participant, 'participant');
          } else { phone = ''; }
        }

        // T5: banco de dados
        if (!phone && lidNum) {
          try {
            const { supabaseAdmin } = require('../config/supabase');
            const { data: ec } = await supabaseAdmin.from('evolution_conversations').select('phone').eq('jid', remoteJid).not('phone', 'is', null).limit(1).single();
            if (ec?.phone && this._isRealPhone(ec.phone)) {
              phone = ec.phone.replace(/\D/g, '');
              console.log('[LID T5a] banco conv: ' + remoteJid + ' -> ' + phone);
            }
            if (!phone) {
              const { data: ex } = await supabaseAdmin.from('evolution_contacts').select('phone').eq('phone', lidNum).limit(1).single();
              if (ex?.phone && ex.phone !== lidNum && this._isRealPhone(ex.phone)) {
                phone = ex.phone.replace(/\D/g, '');
                console.log('[LID T5b] banco contato: ' + remoteJid + ' -> ' + phone);
              }
            }
          } catch (dbErr) { /* nao critico */ }
        }

        // T6: onWhatsApp
        if (!phone && sock && typeof sock.onWhatsApp === 'function') {
          try {
            const lookup = await sock.onWhatsApp(remoteJid);
            if (Array.isArray(lookup) && lookup.length > 0) {
              const rJid = lookup[0]?.jid || '';
              if (rJid.endsWith('@s.whatsapp.net')) {
                const rd = rJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
                if (this._isRealPhone(rd)) {
                  phone = rd;
                  console.log('[LID T6] onWhatsApp: ' + remoteJid + ' -> ' + phone);
                  if (sessionObj?.lidToPhone) { sessionObj.lidToPhone.set(remoteJid, phone); sessionObj.lidToPhone.set(lidNum, phone); }
                  await this._persistResolvedLidPhone(sessionName, remoteJid, lidNum, phone);
                }
              }
            }
          } catch (onWaErr) { console.log('[LID T6] falhou: ' + onWaErr.message); }
        }

        // T7: sock.store?.contacts (legado)
        if (!phone && sock?.store?.contacts) {
          try {
            for (const [cid, contact] of Object.entries(sock.store.contacts)) {
              if (contact.lid === remoteJid && cid.endsWith('@s.whatsapp.net')) {
                const cd = cid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
                if (this._isRealPhone(cd)) {
                  phone = cd;
                  console.log('[LID T7] store: ' + remoteJid + ' -> ' + phone);
                  if (sessionObj?.lidToPhone) { sessionObj.lidToPhone.set(remoteJid, phone); sessionObj.lidToPhone.set(lidNum, phone); }
                  await this._persistResolvedLidPhone(sessionName, remoteJid, lidNum, phone);
                  break;
                }
              }
            }
          } catch (storeErr) {}
        }

        // Fallback
        if (!phone) {
          phone = lidNum;
          console.log('[LID FALLBACK] ' + remoteJid + ' -> usando LID: ' + phone);
        }
      } else {
        phone = remoteJid.replace('@s.whatsapp.net', '');
        if (message.key?.remoteJidAlt && String(message.key.remoteJidAlt).endsWith('@lid') && this._isRealPhone(phone)) {
          await this._rememberLidMapping(sessionName, message.key.remoteJidAlt, remoteJid, 'non-lid-alt');
        }
      }

      phone = phone.replace(/\D/g, '');
      if (!phone) { console.log('Phone vazio, ignorando. remoteJid: ' + remoteJid); return; }

      const messageType = this._getMessageType(message);
      const mediaInfo = await this._downloadIncomingMedia(sessionName, message, messageType, sock);
      const messageContent = extractMessageContent(message.message) || message.message || {};
      const content = messageContent.conversation
        || messageContent.extendedTextMessage?.text
        || messageContent.imageMessage?.caption
        || messageContent.videoMessage?.caption
        || messageContent.documentMessage?.caption
        || (messageType === 'document' ? mediaInfo?.originalName : '')
        || this._fallbackContentForType(messageType);
      console.log('Msg de ' + phone + ': ' + content.substring(0, 50));

      const axios = require('axios');
      const PORT = process.env.PORT || 3003;
      await axios.post('http://localhost:' + PORT + '/internal/messages/process', {
        sessionName, phone, remoteJid, content,
        messageType,
        whatsappMessageId: message.key.id,
        pushName: message.pushName,
        isLid: isLid,
        mediaUrl: mediaInfo?.publicPath || '',
        mediaMimeType: mediaInfo?.mimetype || '',
        mediaFileName: mediaInfo?.originalName || ''
      });
    } catch (error) { console.error('Erro processando mensagem:', error.message); }
  }

  _normalizeOutgoingMediaType(messageType, mimetype, fileName) {
    const type = String(messageType || '').toLowerCase();
    const name = String(fileName || '').toLowerCase();
    if (type === 'gif') return 'gif';
    if (type === 'sticker' || name.endsWith('.webp')) return 'sticker';
    if (type === 'image' || mimetype.startsWith('image/')) return mimetype === 'image/gif' ? 'gif' : 'image';
    if (type === 'video' || mimetype.startsWith('video/')) return 'video';
    if (type === 'audio' || mimetype.startsWith('audio/')) return 'audio';
    return 'document';
  }

  _fallbackContentForType(messageType) {
    const labels = {
      image: '[Imagem]',
      audio: '[Audio]',
      video: '[Video]',
      gif: '[GIF]',
      document: '[Arquivo]',
      sticker: '[Figurinha]'
    };
    return labels[messageType] || '[Midia]';
  }

  _getMediaNode(message, messageType) {
    const msg = extractMessageContent(message.message) || message.message || {};
    if (messageType === 'image') return msg.imageMessage;
    if (messageType === 'audio') return msg.audioMessage;
    if (messageType === 'video' || messageType === 'gif') return msg.videoMessage;
    if (messageType === 'document') return msg.documentMessage;
    if (messageType === 'sticker') return msg.stickerMessage;
    return null;
  }

  async _downloadIncomingMedia(sessionName, message, messageType, sock) {
    if (messageType === 'text') return null;
    const mediaNode = this._getMediaNode(message, messageType);
    if (!mediaNode) {
      console.warn('[MEDIA] No media node for type=' + messageType + ' id=' + (message.key?.id || 'unknown'));
      return null;
    }

    try {
      let buffer = await downloadMediaMessage(
        message,
        'buffer',
        {},
        { logger: makeSilentLogger(), reuploadRequest: sock?.updateMediaMessage?.bind(sock) }
      ).catch(err => {
        console.warn('[MEDIA] downloadMediaMessage failed: ' + err.message);
        return null;
      });

      if (!buffer || !buffer.length) {
        const mediaKind = messageType === 'gif' ? 'video' : messageType;
        const stream = await downloadContentFromMessage(mediaNode, mediaKind);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        buffer = Buffer.concat(chunks);
      }
      if (!buffer || !buffer.length) return null;

      const mimetype = String(mediaNode.mimetype || (messageType === 'sticker' ? 'image/webp' : 'application/octet-stream')).split(';')[0].trim();
      const originalName = mediaNode.fileName || mediaNode.title || `${messageType}-${message.key?.id || Date.now()}`;
      const stored = createStoredFile(buffer, {
        clientId: sessionName,
        messageType,
        mimetype,
        originalName
      });
      console.log('[MEDIA] saved type=' + messageType + ' mime=' + stored.mimetype + ' size=' + stored.size + ' url=' + stored.publicPath);
      return stored;
    } catch (err) {
      console.error('Erro baixando midia recebida:', err.message);
      if (mediaNode.jpegThumbnail) {
        try {
          const thumbBuffer = Buffer.isBuffer(mediaNode.jpegThumbnail)
            ? mediaNode.jpegThumbnail
            : Buffer.from(mediaNode.jpegThumbnail);
          if (thumbBuffer.length > 0) {
            return createStoredFile(thumbBuffer, {
              clientId: sessionName,
              messageType,
              mimetype: 'image/jpeg',
              originalName: `${messageType}-thumbnail-${message.key?.id || Date.now()}.jpg`
            });
          }
        } catch (thumbErr) {
          console.error('Erro salvando thumbnail da midia:', thumbErr.message);
        }
      }
      return null;
    }
  }

  _getMessageType(message) {
    const content = extractMessageContent(message.message) || message.message || {};
    const contentType = getContentType(content);
    if (contentType === 'imageMessage') return 'image';
    if (contentType === 'audioMessage') return 'audio';
    if (contentType === 'videoMessage') return content.videoMessage?.gifPlayback ? 'gif' : 'video';
    if (contentType === 'documentMessage') return 'document';
    if (contentType === 'stickerMessage') return 'sticker';
    return 'text';
  }

  async _updateDatabaseStatus(sessionName, status, reason) {
    try {
      const axios = require('axios');
      const PORT = process.env.PORT || 3003;
      await axios.put('http://localhost:' + PORT + '/internal/sessions/' + sessionName + '/status', {
        status, reason: reason || 'unknown', timestamp: new Date().toISOString()
      });
    } catch (error) { console.error('Erro atualizando banco ' + sessionName + ':', error.message); }
  }
}

module.exports = new BaileysService();
