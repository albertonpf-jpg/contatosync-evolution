function build({ message = {}, route = {} } = {}) {
  const sources = [];
  const add = (sourceType, reason, priority) => {
    if (!sources.some(source => source.sourceType === sourceType)) {
      sources.push({ sourceType, reason, priority, execute: true });
    }
  };

  const missingData = inferMissingData(message, route);
  const missingProductContext = missingData.includes('product');
  const missingOrderContext = missingData.includes('order_number');

  if (route.needsConversationMemory) add('conversation_memory', 'contexto recente ajuda a resolver pronomes e continuacoes', 10);
  if (route.needsApi && !missingOrderContext) add('api', 'pergunta depende de dado vivo ou transacional', 100);
  if (route.needsCatalog && !missingProductContext) add('catalog', 'pergunta depende de produto, estoque, preco ou variacao', 90);
  if (route.needsRag) add('rag', 'resposta precisa ser fundamentada em conhecimento configurado', 70);
  if (route.needsFiles) add('file', 'arquivos oficiais podem conter regras ou detalhes institucionais', 60);
  if (route.needsSite) add('site', 'site e URLs configuradas podem conter informacoes institucionais', 50);

  const executeSources = sources
    .sort((a, b) => b.priority - a.priority)
    .map(source => source.sourceType);

  return {
    executeSources,
    skippedSources: Array.isArray(route.blockedSources) ? route.blockedSources : [],
    sources,
    needsClarifyingData: missingData,
    reason: 'Plano construido a partir da matriz do router leve; fontes dinamicas so entram quando a intencao exige.'
  };
}

function inferMissingData(message = {}, route = {}) {
  const text = String(message.text || '');
  const history = Array.isArray(message.conversationHistory) ? message.conversationHistory : [];
  if (route.intent === 'order_status' && !/\b\d{4,}\b|pedido\s*#?\s*\w+/i.test(text)) {
    return ['order_number'];
  }
  if (route.intent === 'product' && /\b(mais op[cç][oõ]es|outras op[cç][oõ]es|me de mais|me dê mais)\b/i.test(text) && history.length === 0) {
    return ['product'];
  }
  if (route.intent === 'product' && /^(quanto custa|quanto fica|tem disponivel|tem disponível|tem)$/i.test(text.trim())) {
    return ['product'];
  }
  if (/\bminha cidade|nessa cidade|pra minha cidade|para minha cidade|isso vale\b/i.test(text) && !/\b[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+)?\b/.test(text.replace(/^Isso\b/i, ''))) {
    return ['city'];
  }
  return [];
}

module.exports = {
  build,
  inferMissingData
};
