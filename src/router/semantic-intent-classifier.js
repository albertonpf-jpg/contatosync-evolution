const { ROUTER_INTENTS } = require('../types/agent.types');
const { normalizeDepartmentConfig } = require('../agent/department-config');

const DEFAULT_THRESHOLD = 0.68;

function hasText(value) {
  return String(value || '').trim().length > 0;
}

function getClassifierModel(config = {}) {
  return String(config.intent_classifier_model || config.model || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
}

function getClassifierProvider(model = '') {
  const normalized = String(model || '').trim().toLowerCase();
  if (normalized.includes('claude') || normalized.includes('anthropic')) return 'claude';
  return 'openai';
}

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
  const allowedSources = new Set(['api', 'catalog', 'rag', 'site', 'file', 'files', 'conversation_memory']);
  const sourceRequirements = Array.isArray(raw.sourceRequirements || raw.requiredSources || raw.sources)
    ? (raw.sourceRequirements || raw.requiredSources || raw.sources)
      .map(String)
      .map(source => source === 'file' ? 'files' : source)
      .filter(source => allowedSources.has(source))
      .slice(0, 7)
    : [];
  return {
    intent,
    departmentId: typeof raw.departmentId === 'string' ? raw.departmentId.trim() : '',
    confidence,
    reason: String(raw.reason || fallbackReason || '').slice(0, 500),
    missingInfo: Array.isArray(raw.missingInfo) ? raw.missingInfo.map(String).slice(0, 5) : [],
    ambiguity: typeof raw.ambiguity === 'string' ? raw.ambiguity.slice(0, 300) : '',
    nextBestDepartments: Array.isArray(raw.nextBestDepartments) ? raw.nextBestDepartments.map(String).slice(0, 3) : [],
    command: String(raw.command || raw.action || '').slice(0, 80),
    sourceRequirements: [...new Set(sourceRequirements)],
    searchQuery: String(raw.searchQuery || raw.retrievalQuery || '').slice(0, 500),
    responseGoal: String(raw.responseGoal || raw.goal || '').slice(0, 500),
    resolutionCriteria: Array.isArray(raw.resolutionCriteria)
      ? raw.resolutionCriteria.map(String).slice(0, 5)
      : [],
    source: 'semantic'
  };
}

function resolveDepartmentIdForIntent(intent = 'unknown', config = {}) {
  const departments = normalizeDepartmentConfig(config);
  const enabledEntries = Object.entries(departments).filter(([, department]) => department.enabled !== false);
  const match = enabledEntries.find(([, department]) => Array.isArray(department.intents) && department.intents.includes(intent));
  if (match) return match[0];
  if (intent === 'human_request' && departments.handoff?.enabled !== false) return 'handoff';
  if (departments.support?.enabled !== false) return 'support';
  return enabledEntries[0]?.[0] || 'support';
}

function buildClassifierPrompt({ message = {}, config = {} } = {}) {
  const departments = normalizeDepartmentConfig(config);
  const agentLines = Object.entries(departments).map(([id, department]) => {
    const examples = Array.isArray(department.activationExamples) ? department.activationExamples.join(' | ') : '';
    const boundaryRules = Array.isArray(department.boundaryRules) ? department.boundaryRules.join(' | ') : '';
    const exclusions = Array.isArray(department.exclusionExamples) ? department.exclusionExamples.join(' | ') : '';
    const intents = Array.isArray(department.intents) ? department.intents.join(', ') : '';
    return [
      `- ${id} (${department.name})`,
      `  Objetivo: ${department.objective}`,
      `  Intencoes aceitas: ${intents || 'definidas pelo sistema'}`,
      `  Quando acionar: ${department.semanticDescription || department.objective}`,
      examples ? `  Exemplos de acionamento: ${examples}` : '',
      boundaryRules ? `  Nao acionar quando: ${boundaryRules}` : '',
      exclusions ? `  Exemplos que pertencem a outro setor: ${exclusions}` : ''
    ].filter(Boolean).join('\n');
  }).join('\n');

  const history = Array.isArray(message.conversationHistory)
    ? message.conversationHistory.slice(-6).map(item => `${item.direction || 'msg'}: ${item.content || item.text || ''}`).join('\n')
    : '';

  return [
    'Classifique semanticamente a intencao da mensagem de WhatsApp.',
    'Pense como um roteador de atendimento: primeiro identifique o resultado que o cliente quer, depois escolha o setor que tem permissao para resolver esse resultado.',
    'Nao dependa de palavra-chave exata; entenda sinonimos, contexto, gírias e frases incompletas.',
    'Escolha exatamente uma intent desta lista: faq, policy, product, order_status, scheduling, billing, support, human_request, complaint, unknown.',
    'Escolha tambem o departmentId do agente responsavel usando exatamente um dos IDs listados abaixo.',
    'O departmentId precisa ser coerente com as intencoes aceitas pelo agente. Se houver duvida entre setores, use baixa confianca e explique em ambiguity.',
    'Respeite "Nao acionar quando" e exemplos de exclusao de cada agente; eles tem prioridade sobre exemplos positivos parecidos.',
    'Use human_request somente quando o cliente pedir explicitamente uma pessoa/atendente/humano.',
    'Se a mensagem estiver vaga demais para decidir com seguranca, use unknown, confidence abaixo do limite e preencha missingInfo com "intent".',
    'Nunca escolha um agente so porque apareceu uma palavra parecida; se o objetivo do cliente nao estiver claro, peca esclarecimento.',
    'Se a mensagem estiver ambigua, use unknown ou faq com baixa confianca.',
    '',
    'Agentes disponiveis:',
    agentLines,
    '',
    history ? `Historico recente:\n${history}\n` : '',
    `Mensagem atual: ${message.text || message.content || ''}`,
    '',
    'Responda somente JSON neste formato:',
    '{"intent":"product","departmentId":"sales","confidence":0.0,"reason":"motivo curto","missingInfo":[],"ambiguity":"","nextBestDepartments":[]}'
  ].join('\n');
}

function buildSemanticPlannerPrompt({ message = {}, config = {} } = {}) {
  const departments = normalizeDepartmentConfig(config);
  const agentLines = Object.entries(departments).map(([id, department]) => {
    const examples = Array.isArray(department.activationExamples) ? department.activationExamples.join(' | ') : '';
    const boundaryRules = Array.isArray(department.boundaryRules) ? department.boundaryRules.join(' | ') : '';
    const exclusions = Array.isArray(department.exclusionExamples) ? department.exclusionExamples.join(' | ') : '';
    const intents = Array.isArray(department.intents) ? department.intents.join(', ') : '';
    return [
      `- ${id} (${department.name})`,
      `  Objetivo: ${department.objective}`,
      `  Intencoes aceitas: ${intents || 'definidas pelo sistema'}`,
      `  Quando acionar: ${department.semanticDescription || department.objective}`,
      examples ? `  Exemplos de acionamento: ${examples}` : '',
      boundaryRules ? `  Nao acionar quando: ${boundaryRules}` : '',
      exclusions ? `  Exemplos que pertencem a outro setor: ${exclusions}` : ''
    ].filter(Boolean).join('\n');
  }).join('\n');

  const history = Array.isArray(message.conversationHistory)
    ? message.conversationHistory.slice(-8).map(item => `${item.direction || 'msg'}: ${item.content || item.text || ''}`).join('\n')
    : '';

  return [
    'Gere uma decisao semantica executavel para atendimento no WhatsApp.',
    'A decisao nao e uma busca de palavra-chave: entenda o problema que o cliente quer resolver considerando historico, ofertas anteriores, frustracoes, correcoes e mudancas de assunto.',
    'Depois escolha uma acao, a intent, o setor responsavel e as fontes que precisam ser consultadas para resolver de verdade.',
    'Use raciocinio contextual: se a mensagem atual depende do que foi dito antes, mantenha o fluxo ativo do historico e monte searchQuery com o assunto anterior.',
    'Nao responda unknown apenas porque a mensagem atual esta curta; use o historico recente para inferir o objetivo.',
    'Use unknown somente quando, mesmo com historico, nao der para saber qual problema o cliente quer resolver sem arriscar uma resposta errada.',
    'Escolha exatamente uma intent desta lista: faq, policy, product, order_status, scheduling, billing, support, human_request, complaint, unknown.',
    'Escolha tambem o departmentId do agente responsavel usando exatamente um dos IDs listados abaixo.',
    'O departmentId precisa ser coerente com as intencoes aceitas pelo agente. Se houver duvida entre setores, use baixa confianca e explique em ambiguity.',
    'Respeite "Nao acionar quando" e exemplos de exclusao de cada agente; eles tem prioridade sobre exemplos positivos parecidos.',
    'Use human_request somente quando o cliente pedir explicitamente uma pessoa/atendente/humano.',
    'sourceRequirements deve listar apenas as fontes necessarias para resolver: catalog para produtos/fotos/estoque; api para pedido/pagamento/agenda; rag/files/site para politicas e conhecimento; conversation_memory quando historico for necessario.',
    'searchQuery deve ser uma busca semantica completa para as fontes, juntando o pedido atual com o contexto anterior quando isso for necessario.',
    'responseGoal deve dizer o que a resposta final precisa resolver, nao a frase que sera enviada.',
    'resolutionCriteria deve listar quais evidencias precisam existir para responder sem inventar.',
    '',
    'Agentes disponiveis:',
    agentLines,
    '',
    history ? `Historico recente:\n${history}\n` : '',
    `Mensagem atual: ${message.text || message.content || ''}`,
    '',
    'Responda somente JSON neste formato:',
    '{"command":"answer_with_sources","intent":"product","departmentId":"sales","confidence":0.0,"reason":"motivo curto","sourceRequirements":["catalog","rag","conversation_memory"],"searchQuery":"pedido semantico para consulta","responseGoal":"objetivo da resposta","resolutionCriteria":["evidencia necessaria"],"missingInfo":[],"ambiguity":"","nextBestDepartments":[]}'
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
        instructions: 'Voce e um planejador semantico de atendimento. Retorne apenas JSON valido.',
        input: [{ role: 'user', content: prompt }],
        max_output_tokens: 420
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

async function callClaudeClassifier({ apiKey, model, prompt, timeoutMs = 8000 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model || 'claude-3-haiku',
        system: 'Voce e um planejador semantico de atendimento. Retorne apenas JSON valido.',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 420
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `Claude HTTP ${response.status}`);
    const text = Array.isArray(data.content) ? data.content.map(item => item.text || '').join('\n') : '';
    return parseJsonObject(text);
  } finally {
    clearTimeout(timeout);
  }
}

function buildSemanticIntentReadiness(config = {}, client = {}) {
  const enabled = config.semantic_intent_enabled !== false;
  const runtime = config._intentRuntimeContext || {};
  const model = getClassifierModel(config);
  const provider = getClassifierProvider(model);
  const hasCustomClassifier = typeof runtime.classifyIntent === 'function';
  const hasOpenAIKey = hasText(runtime.openaiApiKey || config.intent_classifier_api_key || client.openai_api_key || process.env.OPENAI_API_KEY);
  const hasClaudeKey = hasText(runtime.claudeApiKey || client.claude_api_key || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY);
  const issues = [];

  if (!enabled) {
    issues.push({
      severity: 'warning',
      code: 'semantic_intent_disabled',
      message: 'Classificador semantico esta desativado; o roteamento usa apenas fallback local e regras.'
    });
  } else if (!hasCustomClassifier && provider === 'openai' && !hasOpenAIKey) {
    issues.push({
      severity: 'error',
      code: 'semantic_classifier_missing_openai_key',
      message: 'Classificador semantico usa modelo OpenAI, mas nao ha chave OpenAI configurada; o roteamento caira para fallback local.'
    });
  } else if (!hasCustomClassifier && provider === 'claude' && !hasClaudeKey) {
    issues.push({
      severity: 'error',
      code: 'semantic_classifier_missing_claude_key',
      message: 'Classificador semantico usa modelo Claude, mas nao ha chave Claude configurada; o roteamento caira para fallback local.'
    });
  }

  const ready = enabled && (hasCustomClassifier || (provider === 'openai' ? hasOpenAIKey : hasClaudeKey));
  return {
    enabled,
    ready,
    provider: hasCustomClassifier ? 'custom' : provider,
    model,
    mode: ready ? 'semantic_llm' : (enabled ? 'local_fallback_only' : 'disabled'),
    detail: ready
      ? `classificador semantico operacional via ${hasCustomClassifier ? 'runtime customizado' : provider}`
      : 'classificador semantico nao operacional',
    issues,
    summary: {
      errors: issues.filter(issue => issue.severity === 'error').length,
      warnings: issues.filter(issue => issue.severity === 'warning').length
    }
  };
}

async function classifyIntentSemantically(message = {}) {
  const config = message.effectiveConfig || message.config || {};
  if (config.semantic_intent_enabled === false) {
    return { skipped: true, reason: 'semantic_intent_disabled' };
  }

  const runtime = config._intentRuntimeContext || {};
  if (typeof runtime.classifyIntent === 'function') {
    const result = await runtime.classifyIntent({ message, config });
    const classification = normalizeClassification(result, 'classificador semantico customizado');
    return {
      skipped: false,
      classification: {
        ...classification,
        departmentId: classification.departmentId || resolveDepartmentIdForIntent(classification.intent, config)
      }
    };
  }

  const prompt = buildSemanticPlannerPrompt({ message, config });
  const model = getClassifierModel(config);
  const provider = getClassifierProvider(model);
  const timeoutMs = Number(config.intent_classifier_timeout_ms || 8000);
  let raw = null;

  if (provider === 'claude') {
    const apiKey = runtime.claudeApiKey || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { skipped: true, reason: 'no_semantic_classifier_claude_key' };
    raw = await callClaudeClassifier({ apiKey, model, prompt, timeoutMs });
  } else {
    const apiKey = runtime.openaiApiKey || config.intent_classifier_api_key || process.env.OPENAI_API_KEY;
    if (!apiKey) return { skipped: true, reason: 'no_semantic_classifier_openai_key' };
    raw = await callOpenAIClassifier({ apiKey, model, prompt, timeoutMs });
  }

  if (!raw) return { skipped: true, reason: 'invalid_semantic_classifier_json' };
  const classification = normalizeClassification(raw, 'classificacao semantica por LLM');
  return {
    skipped: false,
    classification: {
      ...classification,
      departmentId: classification.departmentId || resolveDepartmentIdForIntent(classification.intent, config)
    }
  };
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
  buildSemanticPlannerPrompt,
  buildSemanticIntentReadiness,
  normalizeClassification,
  resolveDepartmentIdForIntent
};
