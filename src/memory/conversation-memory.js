function summarizeConversationMemory(history = [], limit = 12) {
  return (Array.isArray(history) ? history : [])
    .slice(-limit)
    .map(item => {
      const author = item.direction === 'out' || item.is_from_ai ? 'IA' : 'Cliente';
      return `${author}: ${String(item.content || '').trim()}`;
    })
    .filter(line => !/:\s*$/.test(line))
    .join('\n');
}

async function retrieveConversationMemory({ message = {} } = {}) {
  const content = summarizeConversationMemory(message.conversationHistory || []);
  if (!content) return [];
  return [{
    sourceType: 'conversation_memory',
    sourceName: 'historico recente da conversa',
    content,
    score: 0.5,
    metadata: {
      conversationId: message.conversationId || ''
    },
    isDynamic: false
  }];
}

module.exports = {
  summarizeConversationMemory,
  retrieveConversationMemory
};
