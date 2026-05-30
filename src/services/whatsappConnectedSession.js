function isConnectedStatus(status = {}) {
  return status?.state === 'open' || status?.status === 'connected';
}

function resolveConnectedWhatsAppSession(dbSessions = [], baileysService) {
  const sessions = Array.isArray(dbSessions) ? dbSessions : [];
  for (const dbSession of sessions) {
    const sessionName = dbSession?.session_name || dbSession?.sessionName || '';
    if (!sessionName) continue;
    const status = baileysService.getSessionStatus(sessionName);
    if (isConnectedStatus(status)) {
      return { sessionName, status };
    }
  }
  return null;
}

function buildNoConnectedSessionError(dbSessions = []) {
  const hasSession = Array.isArray(dbSessions) && dbSessions.length > 0;
  return {
    message: hasSession
      ? 'Nenhuma sessao WhatsApp conectada. Abra WhatsApp, gere o QR Code e escaneie antes de enviar mensagens.'
      : 'Nenhuma sessao WhatsApp configurada. Crie e conecte uma sessao antes de enviar mensagens.',
    statusCode: hasSession ? 409 : 404,
    code: hasSession ? 'WHATSAPP_SESSION_NOT_CONNECTED' : 'WHATSAPP_SESSION_NOT_CONFIGURED'
  };
}

module.exports = {
  isConnectedStatus,
  resolveConnectedWhatsAppSession,
  buildNoConnectedSessionError
};
