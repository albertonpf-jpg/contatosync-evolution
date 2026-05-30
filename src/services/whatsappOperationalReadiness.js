const CONNECTED_STATES = new Set(['connected', 'open']);
const PENDING_STATES = new Set(['qr_pending', 'connecting', 'pairing']);

function normalizeState(value = '') {
  return String(value || '').trim().toLowerCase();
}

function getRuntimeStatus(baileysService, sessionName = '') {
  if (!baileysService || typeof baileysService.getSessionStatus !== 'function') return null;
  try {
    return baileysService.getSessionStatus(sessionName);
  } catch (_) {
    return null;
  }
}

function buildWhatsAppOperationalReadiness(sessions = [], baileysService = null) {
  const rows = Array.isArray(sessions) ? sessions : [];
  const normalizedSessions = rows.map(row => {
    const runtimeStatus = getRuntimeStatus(baileysService, row.session_name);
    const runtimeState = normalizeState(runtimeStatus?.state || runtimeStatus?.status);
    const dbState = normalizeState(row.status);
    const effectiveState = runtimeState || dbState || 'unknown';
    return {
      id: row.id || '',
      sessionName: row.session_name || '',
      displayName: String(row.session_name || '').replace(/^evo_/, ''),
      whatsappPhone: row.whatsapp_phone || '',
      databaseStatus: dbState || 'unknown',
      runtimeStatus: runtimeState || '',
      state: effectiveState,
      connected: CONNECTED_STATES.has(effectiveState),
      pendingQr: effectiveState === 'qr_pending',
      hasQr: Boolean(runtimeStatus?.hasQR),
      lastSeen: row.last_seen || null,
      updatedAt: row.updated_at || null
    };
  });

  const connectedSessions = normalizedSessions.filter(session => session.connected);
  const pendingSessions = normalizedSessions.filter(session => PENDING_STATES.has(session.state));
  const ready = connectedSessions.length > 0;
  const status = ready
    ? 'ready'
    : pendingSessions.length > 0
      ? 'needs_qr_scan'
      : normalizedSessions.length > 0
        ? 'disconnected'
        : 'no_session';

  return {
    ready,
    status,
    summary: ready
      ? `${connectedSessions.length} sessao(oes) WhatsApp conectada(s).`
      : status === 'needs_qr_scan'
        ? 'WhatsApp ainda precisa escanear o QR Code para atendimento em producao.'
        : status === 'disconnected'
          ? 'Ha sessao WhatsApp cadastrada, mas nenhuma esta conectada ao Baileys.'
          : 'Nenhuma sessao WhatsApp cadastrada para este cliente.',
    counts: {
      total: normalizedSessions.length,
      connected: connectedSessions.length,
      pending: pendingSessions.length,
      disconnected: normalizedSessions.filter(session => !session.connected && !PENDING_STATES.has(session.state)).length
    },
    sessions: normalizedSessions
  };
}

module.exports = {
  buildWhatsAppOperationalReadiness
};
