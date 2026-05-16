async function handleIncomingWhatsAppMessage(rawMessage, orchestrator) {
  if (!orchestrator || typeof orchestrator.handleIncomingWhatsAppMessage !== 'function') {
    throw new Error('whatsapp_agent_orchestrator_missing');
  }
  return orchestrator.handleIncomingWhatsAppMessage(rawMessage);
}

module.exports = {
  handleIncomingWhatsAppMessage
};
