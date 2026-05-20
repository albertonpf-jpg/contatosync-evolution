function createAgentLogEntry({
  conversationId = '',
  step = '',
  inputSummary = '',
  outputSummary = '',
  confidence = 0,
  sourcesUsed = [],
  decision = '',
  timestamp = new Date().toISOString()
} = {}) {
  return {
    conversationId,
    step,
    inputSummary: String(inputSummary || '').slice(0, 500),
    outputSummary: String(outputSummary || '').slice(0, 500),
    confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : 0,
    sourcesUsed: Array.isArray(sourcesUsed) ? sourcesUsed : [],
    decision: String(decision || '').slice(0, 500),
    timestamp
  };
}

function logAgentStep(payload = {}, logger = console) {
  const entry = createAgentLogEntry(payload);
  const label = {
    message_normalizer: '[MESSAGE NORMALIZED]',
    lightweight_router: '[LIGHTWEIGHT ROUTER]',
    source_decision: '[SOURCE DECISION]',
    retrieval: '[RETRIEVAL STARTED]',
    rag: '[RAG RETRIEVAL]',
    site: '[SITE RETRIEVAL]',
    file: '[FILE RETRIEVAL]',
    api: '[API TOOL EXECUTION]',
    catalog: '[CATALOG RETRIEVAL]',
    memory: '[CONVERSATION MEMORY]',
    ranker: '[EVIDENCE RANKED]',
    composer: '[ANSWER COMPOSER]',
    guardrail: '[CONFIDENCE GUARDRAIL]',
    clarification: '[CLARIFICATION QUESTION]',
    discovery: '[DISCOVERY QUESTION]',
    explicit_handoff: '[EXPLICIT HUMAN HANDOFF]'
  }[entry.step] || '[AGENT LOG]';

  logger.log(label + ' ' + JSON.stringify(entry));
  return entry;
}

module.exports = {
  createAgentLogEntry,
  logAgentStep
};
