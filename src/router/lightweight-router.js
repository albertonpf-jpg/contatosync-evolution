const { ROUTER_INTENTS, SOURCE_TYPES } = require('../types/agent.types');
const { classifyIntentSemantically, getSemanticThreshold } = require('./semantic-intent-classifier');

const HUMAN_REQUEST_PATTERNS = [
  /\b(quero|preciso|pode|poderia|me)\s+(falar|fala|passa|passar|transferir|transfere|encaminhar|encaminha)\s+(com|para|pra)?\s*(um|uma)?\s*(atendente|pessoa|humano|suporte humano)\b/i,
  /\b(chama|chame|aciona|acione)\s+(um|uma)?\s*(humano|atendente|pessoa)\b/i,
  /\bnao quero falar com robo\b/i,
  /\batendimento humano\b/i,
  /\bme transfere\b/i
];

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function hasAny(text = '', patterns = []) {
  return patterns.some(pattern => pattern.test(text));
}

function inferIntent(text = '', normalizedMessage = {}) {
  const raw = String(text || '');
  const normalized = normalizeText(raw);
  if (hasAny(raw, HUMAN_REQUEST_PATTERNS)) return { intent: 'human_request', confidence: 0.95, reason: 'Cliente pediu explicitamente atendimento humano.' };

  const hasQuestion = /\?|\b(como|qual|quando|onde|porque|por que|quanto|voc[eê]s|aceita|faz|tem|posso|precisa)\b/i.test(raw);
  const productSignals = /\b(produto|camiseta|blusa|cal[cç]a|vestido|conjunto|look|moletom|tamanho|tam\b|cor|modelo|pre[cç]o|quanto custa|disponivel|dispon[ií]vel|estoque|op[cç][oõ]es|fotos?)\b/i.test(raw);
  const orderSignals = /\b(pedido|rastreio|rastreamento|entrega do pedido|meu pedido|chegou|saiu|status)\b/i.test(raw);
  const schedulingSignals = /\b(agendar|agenda|horario marcado|marcar|retirada agendada)\b/i.test(raw);
  const billingSignals = /\b(cobran[cç]a|boleto|nota fiscal|reembolso|paguei|pagamento do pedido)\b/i.test(raw);
  const complaintSignals = /\b(reclama[cç][aã]o|problema|defeito|veio errado|nao gostei|atrasou|quebrado|troca)\b/i.test(raw);
  const policySignals = /\b(hor[aá]rio|funcionamento|retirada|entrega|frete|pix|cart[aã]o|cnpj|cpf|garantia|troca|devolu[cç][aã]o|pedido minimo|pedido m[ií]nimo|atacado|comprar|compra)\b/i.test(raw);

  if (orderSignals) return { intent: 'order_status', confidence: 0.84, reason: 'Cliente perguntou sobre dado dinâmico de pedido.' };
  if (productSignals) return { intent: 'product', confidence: 0.82, reason: 'Cliente perguntou sobre produto, disponibilidade, preço ou variação.' };
  if (schedulingSignals) return { intent: 'scheduling', confidence: 0.78, reason: 'Cliente pediu informação que pode depender de agenda.' };
  if (billingSignals) return { intent: 'billing', confidence: 0.76, reason: 'Cliente perguntou sobre cobrança ou pagamento transacional.' };
  if (complaintSignals) return { intent: 'complaint', confidence: 0.72, reason: 'Cliente relatou problema ou insatisfação.' };
  if (policySignals) return { intent: 'policy', confidence: 0.78, reason: 'Cliente fez pergunta sobre regra ou informação da empresa.' };
  if (hasQuestion) return { intent: 'faq', confidence: 0.62, reason: 'Cliente fez uma pergunta geral que deve ser fundamentada nas fontes.' };
  if (normalizedMessage.media) return { intent: 'support', confidence: 0.58, reason: 'Mensagem contém mídia e pode precisar de contexto adicional.' };
  if (normalized) return { intent: 'unknown', confidence: 0.45, reason: 'Mensagem não traz intenção suficiente antes das fontes.' };
  return { intent: 'unknown', confidence: 0.3, reason: 'Mensagem vazia ou insuficiente.' };
}

function buildSourceFlags(intent, explicitHumanRequest) {
  const flags = {
    needsRag: false,
    needsApi: false,
    needsCatalog: false,
    needsSite: false,
    needsFiles: false,
    needsConversationMemory: true,
    needsHuman: explicitHumanRequest
  };

  if (explicitHumanRequest) return flags;

  if (intent === 'product') {
    flags.needsCatalog = true;
    flags.needsRag = true;
    flags.needsSite = true;
    return flags;
  }

  if (['order_status', 'billing', 'scheduling'].includes(intent)) {
    flags.needsApi = true;
    flags.needsRag = true;
    flags.needsSite = true;
    flags.needsFiles = true;
    return flags;
  }

  if (['faq', 'policy', 'support', 'complaint', 'unknown'].includes(intent)) {
    flags.needsRag = true;
    flags.needsSite = true;
    flags.needsFiles = true;
    return flags;
  }

  return flags;
}

async function route(normalizedMessage = {}) {
  const text = normalizedMessage.text || normalizedMessage.content || '';
  const fallbackInferred = inferIntent(text, normalizedMessage);
  let inferred = fallbackInferred;
  let semanticResult = null;
  let routerMode = 'rules';

  if (fallbackInferred.intent !== 'human_request') {
    try {
      semanticResult = await classifyIntentSemantically(normalizedMessage);
      const threshold = getSemanticThreshold(normalizedMessage.effectiveConfig || {});
      if (!semanticResult.skipped && semanticResult.classification?.confidence >= threshold) {
        inferred = semanticResult.classification;
        routerMode = 'semantic';
      } else if (!semanticResult.skipped) {
        routerMode = 'rules_after_low_confidence_semantic';
      }
    } catch (error) {
      semanticResult = { skipped: true, reason: String(error?.message || error) };
      routerMode = 'rules_after_semantic_error';
    }
  }

  const intent = ROUTER_INTENTS.includes(inferred.intent) ? inferred.intent : 'unknown';
  const explicitHumanRequest = intent === 'human_request';
  const flags = buildSourceFlags(intent, explicitHumanRequest);

  const requiredSources = SOURCE_TYPES
    .filter(source => {
      if (source === 'rag') return flags.needsRag;
      if (source === 'api') return flags.needsApi;
      if (source === 'catalog') return flags.needsCatalog;
      if (source === 'site') return flags.needsSite;
      if (source === 'file') return flags.needsFiles;
      if (source === 'conversation_memory') return flags.needsConversationMemory;
      return false;
    })
    .map(source => source === 'file' ? 'files' : source);

  const blockedSources = SOURCE_TYPES
    .map(source => source === 'file' ? 'files' : source)
    .filter(source => !requiredSources.includes(source) && source !== 'policy' && source !== 'faq');

  const sourcePriority = ['api', 'catalog', 'rag', 'file', 'site', 'faq', 'conversation_memory']
    .map(source => source === 'file' ? 'files' : source)
    .filter(source => requiredSources.includes(source));

  return {
    intent,
    needsRag: flags.needsRag,
    needsApi: flags.needsApi,
    needsCatalog: flags.needsCatalog,
    needsSite: flags.needsSite,
    needsFiles: flags.needsFiles,
    needsConversationMemory: flags.needsConversationMemory,
    needsHuman: explicitHumanRequest === true,
    explicitHumanRequest,
    requiredSources,
    blockedSources,
    sourcePriority,
    confidence: inferred.confidence,
    reason: inferred.reason,
    routerMode,
    semantic: semanticResult && !semanticResult.skipped ? {
      intent: semanticResult.classification.intent,
      confidence: semanticResult.classification.confidence,
      reason: semanticResult.classification.reason
    } : null,
    semanticSkippedReason: semanticResult?.skipped ? semanticResult.reason : '',
    fallbackIntent: fallbackInferred.intent
  };
}

module.exports = {
  route,
  normalizeText,
  inferIntent
};
