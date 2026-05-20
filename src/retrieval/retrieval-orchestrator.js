const { retrieveConversationMemory } = require('../memory/conversation-memory');
const { logAgentStep } = require('../utils/structured-logger');

function normalizeEvidenceList(value, sourceType) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  return list
    .filter(Boolean)
    .map(item => ({
      sourceType: item.sourceType || sourceType,
      sourceName: item.sourceName || item.source_name || sourceType,
      content: String(item.content || item.text || item.contextText || '').trim(),
      score: Number.isFinite(Number(item.score)) ? Number(item.score) : 0.5,
      metadata: item.metadata || {},
      isDynamic: item.isDynamic === true || sourceType === 'api' || sourceType === 'catalog'
    }))
    .filter(item => item.content || Object.keys(item.metadata || {}).length > 0);
}

async function retrieve({ message = {}, query = '', route = {}, retrievalPlan = {}, adapters = {}, logger } = {}) {
  const executeSources = Array.isArray(retrievalPlan.executeSources) ? retrievalPlan.executeSources : [];
  const evidence = [];
  const sourceErrors = [];

  const runSource = async (sourceType, fn) => {
    try {
      const result = await fn();
      const normalized = normalizeEvidenceList(result, sourceType);
      evidence.push(...normalized);
      logSource(message, sourceType, normalized, 'executed', logger);
    } catch (error) {
      sourceErrors.push({ sourceType, message: String(error?.message || error) });
      const failedEvidence = {
        sourceType,
        sourceName: `${sourceType} indisponivel`,
        content: `Nao foi possivel consultar ${sourceType} neste momento.`,
        score: 0.2,
        metadata: { error: String(error?.message || error) },
        isDynamic: sourceType === 'api' || sourceType === 'catalog'
      };
      evidence.push(failedEvidence);
      logSource(message, sourceType, [failedEvidence], 'failed', logger);
    }
  };

  for (const sourceType of executeSources) {
    if (sourceType === 'conversation_memory') {
      await runSource(sourceType, () => retrieveConversationMemory({ message }));
      continue;
    }
    const adapter = adapters[sourceType];
    if (typeof adapter !== 'function') continue;
    await runSource(sourceType, () => adapter({ message, query, route, retrievalPlan }));
  }

  return {
    evidence,
    sourceErrors,
    sourcesUsed: [...new Set(evidence.map(item => item.sourceType))],
    route,
    retrievalPlan
  };
}

function logSource(message = {}, sourceType = '', evidence = [], decision = '', logger = console) {
  const stepMap = {
    rag: 'rag',
    site: 'site',
    file: 'file',
    api: 'api',
    catalog: 'catalog',
    conversation_memory: 'memory'
  };
  logAgentStep({
    conversationId: message.conversationId || '',
    step: stepMap[sourceType] || 'retrieval',
    inputSummary: message.text || '',
    outputSummary: `${evidence.length} evidencias`,
    confidence: evidence[0]?.score || 0,
    sourcesUsed: [sourceType],
    decision
  }, logger);
}

module.exports = {
  retrieve,
  normalizeEvidenceList,
  logSource
};
