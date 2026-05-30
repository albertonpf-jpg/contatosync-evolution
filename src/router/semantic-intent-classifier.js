const { ROUTER_INTENTS } = require('../types/agent.types');
const { normalizeDepartmentConfig } = require('../agent/department-config');

const DEFAULT_THRESHOLD = 0.68;

function parseJsonObject(value = '') {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_) {
      return null;
    }
  }
}

function normalizeClassification(raw = {}, fallbackReason = '') {
  const intent = ROUTER_INTENTS.includes(raw.intent) ? raw.intent : 'unknown';
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence || 0)));
  return {
    intent,
    confidence,
    reason: String(raw.reason || fallbackReason || '').slice(0, 500),
    missingInfo: Array.isArray(raw.missingInfo) ? raw.missingInfo.map(String).slice(0, 5) : [],
    source: 'semantic'
  };
}

function buildClassifierPrompt({ message = {}, config = {} } = {}) {
  const departments = normalizeDepartmentConfig(config);
  const agentLines = Object.entries(departments).map(([id, department]) => {
    const examples = Array.isArray(department.activationExamples) ? department.activationExamples.join(' | ') : '';
    const intents = Array.isArray(department.intents) ? department.intents.join(', ') : '';
    return [
      `- ${id} (${department.name})`,
      `  Objetivo: ${department.objective}`,
      `  Intencoes aceitas: ${intents || 'definidas pelo sistema'}`,
      `  Quando acionar: ${department.semanticDescription || department.objective}`,
      examples ? `  Exemplos: ${examples}` : ''
    ].filter(Boolean).join('\n');
  }).join('\n');

  const history = Array.isArray(message.conversationHistory)
    ? message.conversationHistory.slice(-6).map(item => `${item.direction || 'msg'}: ${item.content || item.text || ''}`).join('\n')
    : '';

  return [
    'Classifique semanticamente a intencao da mensagem de WhatsApp.',
    'Nao dependa de palavra-chave exata; entenda sinonimos, contexto, gírias e frases incompletas.',
    'Escolha exatamente uma intent desta lista: faq, policy, product, order_status, scheduling, billing, support, human_request, complaint, unknown.',
    'Use human_request somente quando o cliente pedir explicitamente uma pessoa/atendente/humano.',
    'Se a mensagem estiver ambigua, use unknown ou faq com baixa confianca.',
    '',
    'Agentes disponiveis:',
    agentLines,
    '',
    history ? `Historico recente:\n${history}\n` : '',
    `Mensagem atual: ${message.text || message.content || ''}`,
    '',
    'Responda somente JSON neste formato:',
    '{"intent":"product","confidence":0.0,"reason":"motivo curto","missingInfo":[]}'
  ].join('\n');
}

async function callOpenAIClassifier({ apiKey, model, prompt, timeoutMs = 8000 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        instructions: 'Voce e um classificador de intencao. Retorne apenas JSON valido.',
        input: [{ role: 'user', content: prompt }],
        max_output_tokens: 220
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${response.status}`);
    const text = data.output_text
      || (Array.isArray(data.output) ? data.output.flatMap(item => item.content || []).map(item => item.text || '').join('\n') : '');
    return parseJsonObject(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function classifyIntentSemantically(message = {}) {
  const config = message.effectiveConfig || message.config || {};
  if (config.semantic_intent_enabled === false) {
    return { skipped: true, reason: 'semantic_intent_disabled' };
  }

  const runtime = config._intentRuntimeContext || {};
  if (typeof runtime.classifyIntent === 'function') {
    const result = await runtime.classifyIntent({ message, config });
    return { skipped: false, classification: normalizeClassification(result, 'classificador semantico customizado') };
  }

  const apiKey = runtime.openaiApiKey || config.intent_classifier_api_key || process.env.OPENAI_API_KEY;
  if (!apiKey) return { skipped: true, reason: 'no_semantic_classifier_api_key' };

  const prompt = buildClassifierPrompt({ message, config });
  const model = config.intent_classifier_model || config.model || 'gpt-4o-mini';
  const raw = await callOpenAIClassifier({
    apiKey,
    model,
    prompt,
    timeoutMs: Number(config.intent_classifier_timeout_ms || 8000)
  });
  if (!raw) return { skipped: true, reason: 'invalid_semantic_classifier_json' };
  return { skipped: false, classification: normalizeClassification(raw, 'classificacao semantica por LLM') };
}

function getSemanticThreshold(config = {}) {
  const value = Number(config.intent_confidence_threshold);
  if (!Number.isFinite(value)) return DEFAULT_THRESHOLD;
  return Math.max(0.4, Math.min(0.95, value));
}

module.exports = {
  classifyIntentSemantically,
  getSemanticThreshold,
  buildClassifierPrompt,
  normalizeClassification
};
