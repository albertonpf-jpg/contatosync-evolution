const { ROUTER_INTENTS, SOURCE_TYPES } = require('../types/agent.types');
const { classifyIntentSemantically, getSemanticThreshold, resolveDepartmentIdForIntent } = require('./semantic-intent-classifier');
const { classifyByConfiguredAgents } = require('./configured-agent-classifier');

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

function hasRecentProductContext(history = []) {
  if (!Array.isArray(history)) return false;
  return history
    .slice(-10)
    .some(item => {
      const content = normalizeText(item?.content || '');
      return /\b(produto|produtos|catalogo|opcao|opcoes|modelo|modelos|foto|fotos|roupa|roupas|vestido|vestidos|conjunto|conjuntos|blusa|blusas|camiseta|camisetas|moletom|moletons|tenis|calcado|calcados|sapato|sapatos)\b/i.test(content);
    });
}

function inferIntent(text = '', normalizedMessage = {}) {
  const raw = String(text || '');
  const normalized = normalizeText(raw);
  const earlyProductContext = hasRecentProductContext(normalizedMessage.conversationHistory);
  if (/\b(mais modelos?|modelos? diferentes?|outras? opcoes|outros? modelos?|mais opcoes|mais fotos?|fotos? diferentes?|sao os mesmos|sao iguais|mesmos modelos?|diferentes?)\b/i.test(normalized)
    && (earlyProductContext || /\b(modelos?|opcoes|fotos?|produto|produtos|catalogo|tenis|calcados?|sapatos?)\b/i.test(normalized))) {
    return { intent: 'product', confidence: 0.84, reason: 'Cliente pediu mais opcoes ou modelos diferentes mantendo o contexto de produto.' };
  }
  if (/\b(tenis|calcado|calcados|sapato|sapatos)\b/i.test(normalized)) {
    return { intent: 'product', confidence: 0.82, reason: 'Cliente perguntou sobre produto, disponibilidade, preco ou variacao.' };
  }
  if (hasAny(raw, HUMAN_REQUEST_PATTERNS)) return { intent: 'human_request', confidence: 0.95, reason: 'Cliente pediu explicitamente atendimento humano.' };

  const hasQuestion = /\?|\b(como|qual|quando|onde|porque|por que|quanto|voc[eê]s|aceita|faz|tem|posso|precisa)\b/i.test(raw);
  const productSignals = /\b(produtos?|camiseta|blusa|cal[cç]a|vestido|conjunto|look|moletom|tamanho|tam\b|cor|modelo|pre[cç]o|quanto custa|disponivel|dispon[ií]vel|estoque|op[cç][oõ]es|fotos?)\b/i.test(raw);
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

function applySemanticSourceRequirements(flags = {}, classification = null) {
  const requirements = Array.isArray(classification?.sourceRequirements)
    ? classification.sourceRequirements
    : [];
  if (!requirements.length || classification?.intent === 'unknown') return flags;
  const normalized = new Set(requirements.map(source => source === 'file' ? 'files' : source));
  return {
    needsRag: normalized.has('rag'),
    needsApi: normalized.has('api'),
    needsCatalog: normalized.has('catalog'),
    needsSite: normalized.has('site'),
    needsFiles: normalized.has('files'),
    needsConversationMemory: normalized.has('conversation_memory') || flags.needsConversationMemory === true,
    needsHuman: flags.needsHuman === true
  };
}

function shouldKeepRuleFallback(fallbackInferred = {}, configuredResult = {}) {
  if (!fallbackInferred.intent || fallbackInferred.intent === 'unknown') return false;
  if (!configuredResult || !configuredResult.intent || configuredResult.intent === fallbackInferred.intent) return false;
  if (configuredResult.ambiguity) return fallbackInferred.confidence >= 0.7;
  return Number(fallbackInferred.confidence || 0) >= 0.75
    && Number(configuredResult.confidence || 0) <= Number(fallbackInferred.confidence || 0) + 0.04;
}

function shouldUseHighConfidenceRuleFallback(fallbackInferred = {}, effectiveConfig = {}) {
  if (effectiveConfig.allow_rule_fallback_after_semantic_low_confidence !== true) return false;
  if (!fallbackInferred.intent || fallbackInferred.intent === 'unknown') return false;
  return Number(fallbackInferred.confidence || 0) >= 0.78;
}

function shouldUseSemanticRecovery(fallbackInferred = {}, semanticClassification = {}, effectiveConfig = {}) {
  if (effectiveConfig.semantic_recovery_enabled === false) return false;
  const intent = fallbackInferred.intent || '';
  if (!intent || ['unknown', 'human_request'].includes(intent)) return false;
  if (Number(fallbackInferred.confidence || 0) < 0.78) return false;

  const semanticIntent = semanticClassification?.intent || 'unknown';
  const semanticConfidence = Number(semanticClassification?.confidence || 0);
  const semanticIsUnsure = semanticIntent === 'unknown'
    || Boolean(semanticClassification?.ambiguity)
    || semanticConfidence < getSemanticThreshold(effectiveConfig);
  if (!semanticIsUnsure) return false;

  const recoverableIntents = new Set(['product', 'order_status', 'billing', 'scheduling', 'policy', 'faq', 'complaint']);
  if (!recoverableIntents.has(intent)) return false;

  return true;
}

function buildStrictSemanticClarification(reason = 'semantic_classifier_required', semanticClassification = null) {
  return {
    intent: 'unknown',
    departmentId: 'support',
    confidence: 0.3,
    reason,
    missingInfo: Array.isArray(semanticClassification?.missingInfo) ? semanticClassification.missingInfo : [],
    ambiguity: semanticClassification?.ambiguity || 'semantic_classifier_required',
    nextBestDepartments: Array.isArray(semanticClassification?.nextBestDepartments) && semanticClassification.nextBestDepartments.length
      ? semanticClassification.nextBestDepartments
      : ['sales', 'billing', 'scheduling', 'support'],
    scores: []
  };
}

async function route(normalizedMessage = {}) {
  const text = normalizedMessage.text || normalizedMessage.content || '';
  const effectiveConfig = normalizedMessage.effectiveConfig || {};
  const fallbackInferred = inferIntent(text, normalizedMessage);
  let inferred = fallbackInferred;
  let semanticResult = null;
  let configuredResult = null;
  let routerMode = 'rules';
  const strictSemanticIntent = effectiveConfig.semantic_intent_enabled !== false
    && effectiveConfig.require_semantic_intent_classifier === true;

  if (fallbackInferred.intent !== 'human_request') {
    try {
      semanticResult = await classifyIntentSemantically(normalizedMessage);
      const threshold = getSemanticThreshold(effectiveConfig);
      const semanticClassification = semanticResult.classification || {};
      const semanticIsActionable = !semanticResult.skipped
        && semanticClassification.intent !== 'unknown'
        && !semanticClassification.ambiguity
        && semanticClassification.confidence >= threshold;
      if (semanticIsActionable) {
        inferred = semanticResult.classification;
        routerMode = 'semantic';
      } else if (!semanticResult.skipped) {
        if (strictSemanticIntent) {
          if (shouldUseHighConfidenceRuleFallback(fallbackInferred, effectiveConfig)) {
            inferred = fallbackInferred;
            routerMode = 'rules_after_low_confidence_semantic';
          } else if (shouldUseSemanticRecovery(fallbackInferred, semanticClassification, effectiveConfig)) {
            inferred = {
              ...fallbackInferred,
              reason: `recuperacao semantica: ${fallbackInferred.reason || 'intencao operacional clara apesar de baixa confianca do classificador'}`
            };
            routerMode = 'semantic_recovery_after_low_confidence';
          } else {
            const reason = semanticClassification.intent === 'unknown'
              ? 'classificador semantico nao encontrou uma intencao acionavel'
              : 'classificador semantico retornou baixa confianca ou ambiguidade';
            configuredResult = buildStrictSemanticClarification(reason, semanticClassification);
            inferred = configuredResult;
            routerMode = 'clarify_after_low_confidence_semantic';
          }
        } else {
          configuredResult = classifyByConfiguredAgents({ text, config: effectiveConfig, fallbackIntent: fallbackInferred.intent });
          if (shouldKeepRuleFallback(fallbackInferred, configuredResult)) {
            inferred = fallbackInferred;
            routerMode = 'rules_after_low_confidence_semantic';
          } else {
            inferred = configuredResult;
            routerMode = configuredResult.ambiguity ? 'clarify_after_low_confidence_semantic' : 'configured_after_low_confidence_semantic';
          }
        }
      } else {
        if (strictSemanticIntent) {
          configuredResult = buildStrictSemanticClarification(`classificador semantico indisponivel: ${semanticResult.reason || 'sem motivo informado'}`);
          inferred = configuredResult;
          routerMode = 'clarify_after_semantic_skipped';
        } else {
          configuredResult = classifyByConfiguredAgents({ text, config: effectiveConfig, fallbackIntent: fallbackInferred.intent });
          if (shouldKeepRuleFallback(fallbackInferred, configuredResult)) {
            inferred = fallbackInferred;
            routerMode = 'rules_after_semantic_skipped';
          } else {
            inferred = configuredResult;
            routerMode = configuredResult.ambiguity ? 'clarify_after_semantic_skipped' : 'configured_after_semantic_skipped';
          }
        }
      }
    } catch (error) {
      semanticResult = { skipped: true, reason: String(error?.message || error) };
      if (strictSemanticIntent) {
        configuredResult = buildStrictSemanticClarification(`erro no classificador semantico: ${semanticResult.reason}`);
        inferred = configuredResult;
        routerMode = 'clarify_after_semantic_error';
      } else {
        configuredResult = classifyByConfiguredAgents({ text, config: effectiveConfig, fallbackIntent: fallbackInferred.intent });
        if (shouldKeepRuleFallback(fallbackInferred, configuredResult)) {
          inferred = fallbackInferred;
          routerMode = 'rules_after_semantic_error';
        } else {
          inferred = configuredResult;
          routerMode = configuredResult.ambiguity ? 'clarify_after_semantic_error' : 'configured_after_semantic_error';
        }
      }
    }
  }

  const intent = ROUTER_INTENTS.includes(inferred.intent) ? inferred.intent : 'unknown';
  const explicitHumanRequest = intent === 'human_request';
  const semanticDepartmentId = routerMode === 'semantic' && semanticResult && !semanticResult.skipped
    ? (semanticResult.classification.departmentId || resolveDepartmentIdForIntent(intent, effectiveConfig))
    : '';
  const configuredDepartmentId = configuredResult?.departmentId || '';
  const inferredDepartmentId = semanticDepartmentId || configuredDepartmentId || resolveDepartmentIdForIntent(intent, effectiveConfig);
  const routingConflict = semanticResult && !semanticResult.skipped && semanticResult.classification.departmentId
    ? semanticResult.classification.departmentId !== resolveDepartmentIdForIntent(intent, effectiveConfig)
    : false;
  const semanticClassificationForSources = routerMode === 'semantic' && semanticResult && !semanticResult.skipped
    ? semanticResult.classification
    : null;
  const flags = applySemanticSourceRequirements(
    buildSourceFlags(intent, explicitHumanRequest),
    semanticClassificationForSources
  );

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
      departmentId: semanticResult.classification.departmentId || '',
      confidence: semanticResult.classification.confidence,
      reason: semanticResult.classification.reason,
      missingInfo: semanticResult.classification.missingInfo || [],
      ambiguity: semanticResult.classification.ambiguity || '',
      nextBestDepartments: semanticResult.classification.nextBestDepartments || [],
      command: semanticResult.classification.command || '',
      sourceRequirements: semanticResult.classification.sourceRequirements || [],
      searchQuery: semanticResult.classification.searchQuery || '',
      responseGoal: semanticResult.classification.responseGoal || '',
      resolutionCriteria: semanticResult.classification.resolutionCriteria || []
    } : null,
    semanticSkippedReason: semanticResult?.skipped ? semanticResult.reason : '',
    configured: configuredResult ? {
      intent: configuredResult.intent,
      departmentId: configuredResult.departmentId,
      confidence: configuredResult.confidence,
      reason: configuredResult.reason,
      ambiguity: configuredResult.ambiguity || '',
      nextBestDepartments: configuredResult.nextBestDepartments || [],
      scores: (configuredResult.scores || []).slice(0, 5).map(item => ({
        id: item.id,
        intent: item.intent,
        score: Number(item.score || 0),
        exclusionScore: Number(item.exclusionScore || 0)
      }))
    } : null,
    fallbackIntent: fallbackInferred.intent,
    semanticDepartmentId,
    configuredDepartmentId,
    inferredDepartmentId,
    routingConflict
  };
}

module.exports = {
  route,
  normalizeText,
  inferIntent
};
