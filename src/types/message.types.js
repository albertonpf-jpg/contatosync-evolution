function createNormalizedMessage(overrides = {}) {
  return {
    conversationId: '',
    clientId: '',
    customerPhone: '',
    customerName: '',
    text: '',
    raw: null,
    media: null,
    conversation: null,
    contact: null,
    conversationHistory: [],
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

module.exports = {
  createNormalizedMessage
};
