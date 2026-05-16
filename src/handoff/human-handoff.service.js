function create({ message = {}, route = {}, evidence = {}, draftAnswer = {}, reason = 'cliente pediu explicitamente atendimento humano' } = {}) {
  if (route.explicitHumanRequest !== true) {
    return {
      skipped: true,
      reason: 'handoff bloqueado: cliente nao pediu atendimento humano explicitamente'
    };
  }

  return {
    conversationId: message.conversationId || '',
    customerPhone: message.customerPhone || '',
    customerName: message.customerName || '',
    originalMessage: message.text || '',
    intent: 'human_request',
    reason,
    evidenceSummary: Array.isArray(evidence.topEvidence)
      ? evidence.topEvidence.map(item => `${item.sourceType}: ${String(item.content || '').slice(0, 120)}`).join('\n')
      : '',
    draftAnswer: draftAnswer.text || '',
    recentConversation: Array.isArray(message.conversationHistory) ? message.conversationHistory.slice(-12) : [],
    createdAt: new Date().toISOString(),
    response: 'Certo, vou te encaminhar para um atendente.'
  };
}

module.exports = {
  create
};
