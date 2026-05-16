const { v4: uuidv4 } = require('uuid');
const { isWithinWorkingHours } = require('../utils/helpers');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { execFile } = require('child_process');

const execFileAsync = promisify(execFile);
const RECENT_PRODUCTS_MEMORY_TTL_MS = 30 * 60 * 1000;
const recentProductsByConversation = new Map();
const pendingStockFiltersByConversation = new Map();
const selectedProductByConversation = new Map();
const pendingProductSelectionByConversation = new Map();
const pendingActionByConversation = new Map();
const lastProductSearchRequestByConversation = new Map();
const ragOnDemandIndexByClient = new Map();
const PENDING_ACTION_TTL_MS = 10 * 60 * 1000;
const RAG_ON_DEMAND_INDEX_TTL_MS = 15 * 60 * 1000;

const DEFAULT_INTEGRATION_CONFIG = {
  facilzap: {
    auth_type: 'bearer',
    products_path: '/produtos',
    catalog_path: '/catalogos',
    orders_path: '/pedidos',
    order_status_path: '/pedidos/{pedido}',
    tracking_path: '/pedidos/{pedido}/codigo-rastreio',
    customers_path: '/clientes',
    stock_path: '/produtos',
    query_param: 'q',
    phone_param: 'telefone',
    order_param: 'codigo',
    public_catalog_url: ''
  },
  ecommerce: {
    auth_type: 'bearer',
    products_path: '',
    catalog_path: '',
    orders_path: '',
    order_status_path: '',
    tracking_path: '',
    customers_path: '',
    stock_path: '',
    query_param: 'q',
    phone_param: 'phone',
    order_param: 'order'
  },
  crm: {
    auth_type: 'bearer',
    customers_path: '',
    orders_path: '',
    query_param: 'q',
    phone_param: 'phone',
    order_param: 'order'
  }
};

function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean);
  return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

function includesAnyKeyword(message, keywords) {
  const text = String(message || '').toLowerCase();
  return normalizeList(keywords).some(keyword => text.includes(keyword.toLowerCase()));
}

function isSimpleGreeting(message) {
  const text = normalizeSearchText(message);
  if (!text) return false;
  const greetingOnly = /^(oi|ola|olá|bom dia|boa tarde|boa noite|bom noite|e ai|eai|tudo bem|td bem|boa)$/.test(String(message || '').trim().toLowerCase());
  if (greetingOnly) return true;
  const tokens = text.split(' ').filter(Boolean);
  const greetingTokens = new Set(['oi', 'ola', 'bom', 'boa', 'dia', 'tarde', 'noite', 'tudo', 'bem', 'td']);
  return tokens.length > 0 && tokens.length <= 4 && tokens.every(token => greetingTokens.has(token));
}

function buildGreetingResponse(message, config = {}) {
  const text = normalizeSearchText(message);
  if (text.includes('boa noite')) return 'Boa noite! Como posso ajudar?';
  if (text.includes('boa tarde')) return 'Boa tarde! Como posso ajudar?';
  if (text.includes('bom dia')) return 'Bom dia! Como posso ajudar?';
  const configured = String(config.greeting_message || '').trim();
  return configured || 'Ola! Como posso ajudar?';
}

function getProviderForModel(model) {
  return String(model || '').toLowerCase().includes('claude') ? 'claude' : 'openai';
}

function normalizeConfiguredModel(model, provider) {
  const value = String(model || '').trim();
  if (!value) return provider === 'claude' ? 'claude-3-haiku-20240307' : 'gpt-4o-mini';

  const claudeAliases = {
    'claude-3-haiku': 'claude-3-haiku-20240307',
    'claude-3-sonnet': 'claude-3-sonnet-20240229',
    'claude-3-opus': 'claude-3-opus-20240229'
  };

  return claudeAliases[value] || value;
}

function getFallbackModel(provider, model) {
  const value = String(model || '').trim();
  if (provider === 'claude') return value === 'claude-3-haiku-20240307' ? '' : 'claude-3-haiku-20240307';
  return value === 'gpt-4o-mini' ? '' : 'gpt-4o-mini';
}

function isUsableProviderApiKey(provider, apiKey) {
  const value = String(apiKey || '').trim();
  if (!value || value === '***') return false;
  if (provider === 'openai') return /^sk-[A-Za-z0-9_-]{20,}$/.test(value);
  if (provider === 'claude') return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(value);
  return value.length >= 20;
}

function buildSystemPrompt(config, contact, conversation) {
  const basePrompt = config.system_prompt || 'Voce e um assistente virtual de atendimento via WhatsApp. Responda em portugues do Brasil, com clareza e objetividade.';
  const totalMessages = Number(conversation?.total_messages || 0);
  const canGreet = conversation?.conversation_created === true || totalMessages <= 1;
  const greeting = config.greeting_message
    ? `\n\nSaudacao configurada: ${config.greeting_message}\nUse essa saudacao somente na primeira resposta do atendimento. Se a conversa ja estiver em andamento, nao cumprimente de novo e responda direto ao assunto do cliente.`
    : '';
  const fallback = config.fallback_message ? `\n\nFallback configurado para casos sem resposta segura: ${config.fallback_message}\nUse esse fallback somente quando o cliente pedir algo que voce realmente nao consegue responder depois de consultar conversa, arquivos, APIs e catalogo. Nunca use fallback para saudacoes simples como oi, bom dia, boa tarde ou boa noite.` : '';
  const triggerKeywords = normalizeList(config.trigger_keywords);
  const triggerContext = triggerKeywords.length > 0
    ? `\n\nAssuntos prioritarios configurados: ${triggerKeywords.join(', ')}. Use isso como contexto de atendimento, mas responda tambem mensagens gerais do cliente.`
    : '';
  const context = [
    'Contexto do atendimento:',
    `- Cliente no WhatsApp: ${contact?.name || conversation?.contact_name || 'Contato sem nome'}`,
    `- Telefone: ${contact?.phone || conversation?.phone || 'nao informado'}`,
    '- Nunca invente precos, estoque, prazos ou politicas.',
    '- Quando houver URLs, arquivos ou integracoes configuradas no motor da IA, use essas fontes antes de concluir que nao encontrou a informacao.',
    '- Se faltar informacao, diga que vai encaminhar para um atendente humano.',
    canGreet ? '- Esta parece ser a primeira resposta deste atendimento; pode cumprimentar uma vez se fizer sentido.' : '- Esta conversa ja esta em andamento; nao envie boas-vindas, saudacao inicial ou apresentacao novamente.',
    '- Responda como mensagem curta de WhatsApp, sem markdown pesado.'
  ].join('\n');

  return `${basePrompt}${greeting}${fallback}${triggerContext}\n\n${context}`;
}

function getStoreDisplayName(config = {}) {
  return String(
    config.store_name
    || config.business_name
    || config.company_name
    || config.assistant_name
    || config.integration_name
    || ''
  ).trim() || 'a loja atendida';
}

function getStorePolicyTopicFromText(message = '', plan = {}) {
  const text = normalizeSearchText([
    message,
    plan.understanding || '',
    ...(Array.isArray(plan.tools) ? plan.tools.map(tool => [tool?.args?.query, tool?.args?.topic, tool?.reason].filter(Boolean).join(' ')) : [])
  ].join(' '));
  if (getMinimumOrderPolicyQuery(text) || /\b(pedido minimo|compra minima|quantidade minima|minimo de compra|valor minimo)\b/i.test(text)) return 'minimum_order';
  if (/\b(cnpj|cpf|documento|cadastro|pessoa fisica|pessoa juridica)\b/i.test(text)) return 'cnpj';
  if (/\b(frete gratis|frete gratuito|gratis|gratuito)\b/i.test(text) && /\b(frete|entrega|envio)\b/i.test(text)) return 'free_shipping';
  if (/\b(entrega|entregam|frete|enviar|enviam|enviamos|envio|motoboy|transportadora|excursao|todo brasil|brasil todo)\b/i.test(text)) return 'shipping_delivery';
  if (/\b(retirada|retirar|pessoalmente|buscar|endereco|localizacao|onde fica|ponto de encontro|local de retirada)\b/i.test(text)) return 'pickup_location';
  if (/\b(troca|devolucao|devolução|defeito|garantia)\b/i.test(text)) return 'exchange_returns';
  if (/\b(pagamento|pagar|pix|cartao|cartão|boleto|parcelamento)\b/i.test(text)) return 'payment';
  if (/\b(prazo|pronto|preparo|separacao|separação|retirar quando|fica pronto)\b/i.test(text)) return 'fulfillment_time';
  return 'store_policy';
}

function getStorePolicyTopicQueries(topic = '', message = '') {
  const normalizedMessage = normalizeSearchText(message);
  const map = {
    minimum_order: ['pedido minimo', 'compra minima', 'quantidade minima', 'minimo de compras', 'valor minimo'],
    cnpj: ['cnpj', 'cpf', 'documento', 'cadastro', 'pessoa fisica', 'pessoa juridica'],
    free_shipping: ['frete gratis', 'frete gratuito', 'entrega gratis', 'envio gratis'],
    shipping_delivery: ['entrega', 'frete', 'envio', 'enviam', 'enviamos', 'todo brasil', 'motoboy', 'transportadora', 'excursao'],
    pickup_location: ['retirada', 'retirar', 'endereco', 'localizacao', 'buscar', 'ponto de encontro', 'local de retirada'],
    exchange_returns: ['troca', 'devolucao', 'defeito', 'garantia'],
    payment: ['pagamento', 'pix', 'cartao', 'boleto', 'parcelamento'],
    fulfillment_time: ['prazo', 'preparo', 'separacao', 'fica pronto']
  };
  const queries = map[topic] || [];
  const messageTokens = getSpecificProductTokens(getSearchTokens(normalizedMessage)).slice(0, 6).join(' ');
  return [...new Set([...queries, topic === 'store_policy' ? messageTokens : ''].filter(Boolean))];
}

function collectClientConfigPolicyTexts(config = {}) {
  const entries = [];
  const fields = [
    ['system_prompt', 'Prompt/configuracao do cliente'],
    ['business_info', 'Configuracao do cliente'],
    ['store_policy', 'Politicas configuradas do cliente'],
    ['store_policies', 'Politicas configuradas do cliente'],
    ['policy_text', 'Politicas configuradas do cliente'],
    ['knowledge_base', 'Base configurada do cliente'],
    ['business_rules', 'Regras configuradas do cliente'],
    ['assistant_instructions', 'Instrucoes configuradas do cliente']
  ];
  for (const [field, sourceName] of fields) {
    const value = config[field];
    if (typeof value === 'string' && value.trim()) {
      entries.push({ sourceField: field, sourceName, text: value.trim() });
    }
  }
  return entries;
}

function splitPolicyEvidenceText(text = '') {
  return String(text || '')
    .replace(/\r/g, '\n')
    .split(/\n+|(?<=[.!?])\s+/)
    .map(line => line.trim().replace(/^[-*]\s*/, ''))
    .filter(line => line.length >= 12)
    .slice(0, 120);
}

function scorePolicyEvidenceSnippet(snippet = '', queries = []) {
  const text = normalizeSearchText(snippet);
  if (!text) return 0;
  let score = 0;
  for (const query of queries) {
    const queryText = normalizeSearchText(query);
    if (!queryText) continue;
    if (text.includes(queryText)) {
      score += 8;
      continue;
    }
    const tokens = getSearchTokens(queryText).filter(token => token.length >= 3);
    for (const token of tokens) {
      if (text.includes(token)) score += 2;
    }
  }
  return score;
}

function classifyEvidenceRelevance(text = '', policyType = '') {
  const normalized = normalizeSearchText(text);
  if (!normalized) return { relevance: 'noise', reason: 'empty' };
  const assistantInstructionPatterns = [
    /\bseu papel e\b/i,
    /\bvoce e\b/i,
    /\bsou o assistente\b/i,
    /\bsempre que a pergunta\b/i,
    /\buse primeiro\b/i,
    /\bnao invente\b/i,
    /\bresponda\b/i,
    /\bnunca\b/i,
    /\bquando houver\b/i,
    /\bsua tarefa\b/i,
    /\bvoce deve\b/i,
    /\bdeve responder\b/i,
    /\bapenas com assuntos relacionados\b/i,
    /\bfontes antes de responder\b/i,
    /\bnao mencione\b/i
  ];
  if (assistantInstructionPatterns.some(pattern => pattern.test(normalized))) {
    return { relevance: 'noise', reason: 'assistant_instruction' };
  }

  const paymentDeliveryNoisePatterns = [
    /\bformas? de entrega\b/i,
    /\bentrega\b/i,
    /\benvio\b/i,
    /\bmotoboy\b/i,
    /\bexcursao\b/i,
    /\bbras\b/i,
    /\bcep\b/i,
    /\bretirada\b/i,
    /\btransportadora\b/i,
    /\bcorreios\b/i
  ];
  if (policyType === 'payment' && paymentDeliveryNoisePatterns.some(pattern => pattern.test(normalized))) {
    return { relevance: 'noise', reason: 'delivery_text_not_payment' };
  }

  const concreteDeliveryPatterns = [
    /\bretirada\b/i,
    /\bretirar\b/i,
    /\bendereco\b/i,
    /\bentrega no\b/i,
    /\bentrega em\b/i,
    /\bexcursao\b/i,
    /\bmotoboy\b/i,
    /\bcep\b/i,
    /\benvio para todo\b/i,
    /\benviamos para todo\b/i,
    /\benviam para todo\b/i,
    /\btodo brasil\b/i,
    /\btransportadora\b/i,
    /\bcorreios\b/i
  ];
  if (policyType === 'shipping_delivery'
    && /\bentrega do pedido\b/i.test(normalized)
    && !concreteDeliveryPatterns.some(pattern => pattern.test(normalized))) {
    return { relevance: 'context', reason: 'generic_delivery_reference' };
  }

  const directPatterns = {
    payment: [
      /\bpix\b/i,
      /\bcartao\b/i,
      /\bcredito\b/i,
      /\bdebito\b/i,
      /\bboleto\b/i,
      /\bdinheiro\b/i,
      /\blink de pagamento\b/i,
      /\bcomo pagar\b/i,
      /\bpagar com\b/i,
      /\bpagamento via\b/i,
      /\bforma de pagamento\b/i,
      /\bformas de pagamento\b/i,
      /\bparcelamento\b/i,
      /\bgateway\b/i,
      /\bmaquininha\b/i,
      /\bplataforma de pagamento\b/i
    ],
    free_shipping: [
      /\bfrete gratis\b/i,
      /\bfrete gratuito\b/i,
      /\bgratis acima de\b/i,
      /\bacima de r\b/i,
      /\bvalor minimo para frete\b/i,
      /\bentrega gratis\b/i
    ],
    shipping_delivery: [
      /\bretirada\b/i,
      /\bmotoboy\b/i,
      /\bexcursao\b/i,
      /\bendereco\b/i,
      /\bretirar\b/i,
      /\bcep\b/i,
      /\bentrega no\b/i,
      /\bentrega em\b/i,
      /\benvio para todo\b/i,
      /\benviamos para todo\b/i,
      /\benviam para todo\b/i,
      /\btodo brasil\b/i,
      /\btransportadora\b/i,
      /\bcorreios\b/i,
      /\bprazo de entrega\b/i
    ],
    pickup_location: [
      /\bretirada\b/i,
      /\bretirar\b/i,
      /\bendereco\b/i,
      /\blocalizacao\b/i,
      /\bbuscar\b/i,
      /\bponto de encontro\b/i,
      /\blocal de retirada\b/i
    ],
    minimum_order: [
      /\bpedido minimo\b/i,
      /\bcompra minima\b/i,
      /\bminimo de compra\b/i,
      /\bminimo de compras\b/i,
      /\bminimo de pecas\b/i,
      /\bminimo de unidades\b/i,
      /\bquantidade minima\b/i
    ],
    cnpj: [
      /\bcnpj\b/i,
      /\bcpf\b/i,
      /\bpessoa fisica\b/i,
      /\bpessoa juridica\b/i,
      /\bcadastro\b/i,
      /\bnao precisa de cnpj\b/i,
      /\bobrigatorio ter cnpj\b/i
    ],
    exchange_returns: [
      /\btroca\b/i,
      /\bdevolucao\b/i,
      /\bdefeito\b/i,
      /\bgarantia\b/i,
      /\bprazo\b/i,
      /\b7 dias\b/i,
      /\bfabricacao\b/i
    ],
    fulfillment_time: [
      /\bprazo\b/i,
      /\bpreparo\b/i,
      /\bseparacao\b/i,
      /\bfica pronto\b/i,
      /\bpronto\b/i
    ]
  };

  const patterns = directPatterns[policyType] || [];
  if (patterns.some(pattern => pattern.test(normalized))) {
    const reasonByType = {
      payment: 'contains_payment_method',
      free_shipping: 'contains_free_shipping_threshold',
      shipping_delivery: 'contains_delivery_terms',
      pickup_location: 'contains_pickup_location_terms',
      minimum_order: 'contains_minimum_order_terms',
      cnpj: 'contains_document_terms',
      exchange_returns: 'contains_exchange_return_terms',
      fulfillment_time: 'contains_fulfillment_time_terms'
    };
    return { relevance: 'direct', reason: reasonByType[policyType] || 'contains_policy_terms' };
  }

  if (policyType === 'free_shipping'
    && /\b(frete|entrega|envio|motoboy|excursao|retirada|transportadora|correios)\b/i.test(normalized)) {
    return { relevance: 'noise', reason: 'delivery_text_without_free_shipping_policy' };
  }

  return { relevance: 'context', reason: 'related_terms_without_direct_policy' };
}

function buildStorePolicyFact(item = {}, sourceType = 'source', sourceName = 'Fonte configurada', topic = 'store_policy') {
  const relevance = classifyEvidenceRelevance(item.snippet || '', topic);
  return {
    type: topic,
    source: sourceType,
    text: item.snippet,
    sourceType,
    sourceName,
    relevance: relevance.relevance,
    reason: relevance.reason,
    confidence: relevance.relevance === 'direct'
      ? (Number(item.score || 0) >= 8 ? 'high' : 'medium')
      : (relevance.relevance === 'context' ? 'medium' : 'low')
  };
}

function extractStorePolicyFactsFromConfig(config = {}, plan = {}, message = '') {
  const topic = getStorePolicyTopicFromText(message, plan);
  const queries = getStorePolicyTopicQueries(topic, message);
  const facts = [];
  for (const entry of collectClientConfigPolicyTexts(config)) {
    const snippets = splitPolicyEvidenceText(entry.text)
      .map(snippet => ({ snippet, score: scorePolicyEvidenceSnippet(snippet, queries) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    for (const item of snippets) {
      facts.push({
        ...buildStorePolicyFact(
          item,
          entry.sourceField === 'system_prompt' ? 'system_prompt' : 'client_config',
          entry.sourceName,
          topic
        )
      });
    }
  }
  return {
    topic,
    queries,
    facts: facts.slice(0, 8)
  };
}

function extractStorePolicyFactsFromText(text = '', sourceType = 'source', sourceName = 'Fonte configurada', topic = 'store_policy', queries = []) {
  return splitPolicyEvidenceText(text)
    .map(snippet => ({ snippet, score: scorePolicyEvidenceSnippet(snippet, queries) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(item => buildStorePolicyFact(item, sourceType, sourceName, topic));
}

function formatEvidenceFactsForPrompt(label, facts = []) {
  if (!Array.isArray(facts) || facts.length === 0) return '';
  return `${label}:\n` + facts.map((fact, index) => {
    const source = fact.sourceName || fact.sourceType || 'fonte configurada';
    return `${index + 1}. [${fact.type || 'store_policy'} | ${source}] ${fact.text}`;
  }).join('\n');
}

function logPlannerEvidenceFact(fact = {}) {
  console.log('[PLANNER EVIDENCE FACT] type=' + (fact.type || '')
    + ' source=' + (fact.source || fact.sourceType || '')
    + ' relevance=' + (fact.relevance || '')
    + ' reason="' + escapeLogValue(fact.reason || '') + '"'
    + ' text="' + escapeLogValue(String(fact.text || '').slice(0, 180)) + '"');
}

function addPlannerEvidenceFacts(evidenceBundle = {}, facts = [], target = 'source') {
  for (const fact of facts) {
    if (!fact || !fact.text) continue;
    if (fact.relevance === 'direct') {
      if (target === 'config') evidenceBundle.configFacts.push(fact);
      else evidenceBundle.sourceFacts.push(fact);
    } else if (fact.relevance === 'context') {
      evidenceBundle.contextFacts.push(fact);
    } else {
      evidenceBundle.noiseFacts.push(fact);
    }
    logPlannerEvidenceFact(fact);
  }
}

function hasDirectStorePolicyEvidence(evidenceBundle = {}) {
  return Boolean(
    (Array.isArray(evidenceBundle.configFacts) && evidenceBundle.configFacts.length > 0)
    || (Array.isArray(evidenceBundle.sourceFacts) && evidenceBundle.sourceFacts.length > 0)
  );
}

function buildStorePolicyFactsSummaryResponse(message = '', evidenceBundle = {}) {
  const directFacts = [
    ...(Array.isArray(evidenceBundle.configFacts) ? evidenceBundle.configFacts : []),
    ...(Array.isArray(evidenceBundle.sourceFacts) ? evidenceBundle.sourceFacts : [])
  ].filter(fact => fact && fact.text);
  if (directFacts.length === 0) {
    return 'Nao encontrei essa informacao com seguranca aqui. Posso chamar um atendente para confirmar?';
  }
  const mainFact = directFacts[0];
  const text = String(mainFact.text || '').trim().replace(/\s+/g, ' ');
  const normalizedMessage = normalizeSearchText(message);
  if (mainFact.type === 'minimum_order' && /\bso\s+\d+|\bmenos de\s+\d+|\bcomprar\s+\d+/i.test(normalizedMessage)) {
    return `${text} Com essa quantidade, confira se fecha o minimo informado pela loja.`;
  }
  return text;
}

function buildContentHash(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function getRagClientId(context = {}, config = {}) {
  return String(
    context.clientId
    || context.client_id
    || config.client_id
    || config.clientId
    || context.conversation?.client_id
    || context.contact?.client_id
    || ''
  ).trim();
}

function normalizeRagDocumentContent(value = '') {
  return String(value || '').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function getConfigOrEnv(config = {}, key = '', envKey = '') {
  const value = config[key];
  if (value !== undefined && value !== null && value !== '') return value;
  return process.env[envKey || String(key).toUpperCase()];
}

function getRagFlag(config = {}, key = '', envKey = '', defaultValue = false) {
  const envValue = process.env[envKey || String(key).toUpperCase()];
  const value = envValue !== undefined && envValue !== null && envValue !== ''
    ? envValue
    : getConfigOrEnv(config, key, envKey);
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|sim|on)$/i.test(String(value).trim());
}

function isRagVectorEnabled(config = {}, context = {}) {
  return Boolean(context.supabase) && getRagFlag(config, 'rag_vector_enabled', 'RAG_VECTOR_ENABLED', false);
}

function isRagKnowledgeEnabled(config = {}) {
  return getRagFlag(config, 'rag_knowledge_enabled', 'RAG_KNOWLEDGE_ENABLED', true);
}

function isRagIndexOnDemandEnabled(config = {}) {
  return getRagFlag(config, 'rag_index_on_demand', 'RAG_INDEX_ON_DEMAND', true);
}

function isRagEmbeddingEnabled(config = {}) {
  if (getRagFlag(config, 'rag_vector_enabled', 'RAG_VECTOR_ENABLED', false) && isRagKnowledgeEnabled(config)) return true;
  return getRagFlag(config, 'rag_embeddings_enabled', 'RAG_EMBEDDINGS_ENABLED', false);
}

function isRagUpsertEnabled(config = {}) {
  if (getRagFlag(config, 'rag_vector_enabled', 'RAG_VECTOR_ENABLED', false) && isRagIndexOnDemandEnabled(config)) return true;
  return getRagFlag(config, 'rag_upsert_enabled', 'RAG_UPSERT_ENABLED', false);
}

function getRagOnDemandIndexTtlMs(config = {}) {
  return getRagNumber(config, 'rag_index_cache_ttl_ms', 'RAG_INDEX_CACHE_TTL_MS', RAG_ON_DEMAND_INDEX_TTL_MS);
}

function shouldRunRagOnDemandIndex(clientId = '', chunks = [], config = {}) {
  if (!clientId || !Array.isArray(chunks) || chunks.length === 0 || !isRagIndexOnDemandEnabled(config)) return false;
  const hash = buildContentHash(chunks.map(chunk => chunk.content_hash || chunk.content || '').join('|'));
  const key = `${clientId}|${hash}`;
  const previous = ragOnDemandIndexByClient.get(key);
  if (previous && Date.now() - Number(previous.indexedAt || 0) < getRagOnDemandIndexTtlMs(config)) {
    console.log('[RAG INDEX] skipped reason=cache_hit client=' + clientId);
    return false;
  }
  return true;
}

function markRagOnDemandIndexComplete(clientId = '', chunks = []) {
  if (!clientId || !Array.isArray(chunks) || chunks.length === 0) return;
  const hash = buildContentHash(chunks.map(chunk => chunk.content_hash || chunk.content || '').join('|'));
  ragOnDemandIndexByClient.set(`${clientId}|${hash}`, { indexedAt: Date.now() });
}

function getRagNumber(config = {}, key = '', envKey = '', defaultValue = 0) {
  const envValue = process.env[envKey || String(key).toUpperCase()];
  const value = Number(envValue !== undefined && envValue !== null && envValue !== ''
    ? envValue
    : getConfigOrEnv(config, key, envKey));
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

function getRagEmbeddingModel(config = {}) {
  return String(getConfigOrEnv(config, 'rag_embedding_model', 'RAG_EMBEDDING_MODEL') || 'text-embedding-3-small').trim();
}

function getRagEmbeddingDimensions(config = {}) {
  return getRagNumber(config, 'rag_embedding_dimensions', 'RAG_EMBEDDING_DIMENSIONS', 1536);
}

function getRagTables(config = {}) {
  return {
    sourcesTable: String(getConfigOrEnv(config, 'rag_sources_table', 'RAG_SOURCES_TABLE') || 'rag_sources').trim(),
    chunksTable: String(getConfigOrEnv(config, 'rag_chunks_table', 'RAG_CHUNKS_TABLE') || 'rag_chunks').trim(),
    matchFunction: String(getConfigOrEnv(config, 'rag_match_function', 'RAG_MATCH_FUNCTION') || 'match_rag_chunks').trim()
  };
}

function getRagApiKey(context = {}, config = {}) {
  return String(
    context.openaiApiKey
    || context.apiKey
    || config.openai_api_key
    || config.rag_embedding_api_key
    || process.env.OPENAI_API_KEY
    || ''
  ).trim();
}

function buildRagSourceDocumentsForConfig(config = {}, clientId = '') {
  const scopedClientId = String(clientId || config.client_id || config.clientId || '').trim();
  const documents = [];
  const addDocument = (source = {}) => {
    const content = normalizeRagDocumentContent(source.content || '');
    const sourceUrl = String(source.source_url || '').trim();
    if (!scopedClientId || (!content && !sourceUrl)) return;
    documents.push({
      client_id: scopedClientId,
      source_type: source.source_type || 'client_config',
      source_name: source.source_name || 'Fonte do cliente',
      source_url: sourceUrl,
      external_id: String(source.external_id || '').trim(),
      content,
      content_hash: buildContentHash([source.source_type, source.source_name, sourceUrl, content].join('\n')),
      entity_type: source.entity_type || 'store_policy',
      entity_id: String(source.entity_id || source.external_id || '').trim(),
      topic: source.topic || 'knowledge',
      metadata: {
        ...(source.metadata || {}),
        rag_phase: 'universal_agentic_rag'
      }
    });
  };

  if (typeof config.system_prompt === 'string' && config.system_prompt.trim()) {
    addDocument({
      source_type: 'system_prompt',
      source_name: 'Prompt/configuracao do cliente',
      content: config.system_prompt,
      topic: 'store_policy',
      metadata: { config_field: 'system_prompt' }
    });
  }

  for (const entry of collectClientConfigPolicyTexts(config)) {
    if (entry.sourceField === 'system_prompt') continue;
    addDocument({
      source_type: 'client_config',
      source_name: entry.sourceName,
      content: entry.text,
      topic: 'store_policy',
      metadata: { config_field: entry.sourceField }
    });
  }

  for (const file of getKnowledgeFiles(config)) {
    const sourceName = file.originalName || file.fileName || 'Arquivo de conhecimento';
    const content = normalizeRagDocumentContent(file.extractedText || '');
    addDocument({
      source_type: 'knowledge_file',
      source_name: sourceName,
      source_url: file.path || '',
      external_id: file.id || file.path || sourceName,
      content,
      topic: 'knowledge',
      metadata: {
        file_name: sourceName,
        mime_type: file.mimetype || getMimeTypeFromPath(file.path || '')
      }
    });
  }

  for (const source of buildKnowledgeSourcesForConfig(config)) {
    const sourceUrl = String(source.url || source.source_url || '').trim();
    if (!sourceUrl || /^data:/i.test(sourceUrl)) continue;
    addDocument({
      source_type: 'site_url',
      source_name: source.name || 'URL configurada',
      source_url: sourceUrl,
      external_id: sourceUrl,
      content: '',
      topic: 'knowledge',
      metadata: { pending_fetch: true }
    });
  }

  const seen = new Set();
  const uniqueDocuments = documents.filter(document => {
    const key = `${document.client_id}|${document.source_type}|${document.source_url}|${document.content_hash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log('[RAG SOURCES] client=' + scopedClientId + ' count=' + uniqueDocuments.length);
  return uniqueDocuments;
}

function chunkRagDocument(document = {}) {
  const content = normalizeRagDocumentContent(document.content || '');
  if (!document.client_id || !content) return [];
  const maxChars = Number(document.metadata?.chunk_max_chars || 1400);
  const overlap = Math.min(200, Math.floor(maxChars / 5));
  const paragraphs = content.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
  const rawChunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if ((current + '\n\n' + paragraph).trim().length <= maxChars) {
      current = (current ? current + '\n\n' : '') + paragraph;
      continue;
    }
    if (current) rawChunks.push(current);
    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }
    for (let index = 0; index < paragraph.length; index += Math.max(1, maxChars - overlap)) {
      rawChunks.push(paragraph.slice(index, index + maxChars).trim());
    }
    current = '';
  }
  if (current) rawChunks.push(current);

  const chunks = rawChunks.map((chunkContent, index) => ({
    client_id: document.client_id,
    source_id: document.source_id || null,
    source_type: document.source_type,
    source_name: document.source_name,
    source_url: document.source_url,
    entity_type: document.entity_type || 'store_policy',
    entity_id: document.entity_id || document.external_id || '',
    topic: document.topic || 'knowledge',
    content_hash: buildContentHash([document.content_hash, index, chunkContent].join('\n')),
    source_content_hash: document.content_hash,
    chunk_index: index,
    content: chunkContent,
    token_count: Math.ceil(chunkContent.length / 4),
    metadata: {
      ...(document.metadata || {}),
      external_id: document.external_id || '',
      source_content_hash: document.content_hash
    }
  }));
  return chunks;
}

async function generateEmbedding(text = '', context = {}) {
  const config = context.effectiveConfig || context.config || {};
  const apiKey = getRagApiKey(context, config);
  const model = getRagEmbeddingModel(config);
  const dimensions = getRagEmbeddingDimensions(config);
  const input = String(text || '').slice(0, Number(config.rag_embedding_max_chars || 8000));
  if (!input.trim()) return { skipped: true, reason: 'empty_text', embedding: null };
  if (!isUsableProviderApiKey('openai', apiKey)) return { skipped: true, reason: 'no_openai_api_key', embedding: null };

  const startedAt = Date.now();
  const body = { model, input };
  if (dimensions) body.dimensions = dimensions;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(config.rag_embedding_timeout_ms || 8000))
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt === 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        throw new Error(data?.error?.message || 'embedding_http_' + response.status);
      }
      const embedding = data?.data?.[0]?.embedding;
      if (!Array.isArray(embedding)) throw new Error('embedding_empty');
      return {
        skipped: false,
        embedding,
        model: data?.model || model,
        dimensions: embedding.length,
        ms: Date.now() - startedAt
      };
    } catch (error) {
      if (attempt >= 2) {
        console.warn('[RAG EMBED ERROR] message=' + String(error?.message || error).slice(0, 180));
        return { skipped: true, reason: 'embedding_error', embedding: null, error: String(error?.message || error) };
      }
    }
  }
  return { skipped: true, reason: 'embedding_error', embedding: null };
}

async function embedRagChunks(chunks = [], config = {}, context = {}) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { skipped: true, reason: 'empty_chunks', chunks: [] };
  }
  if (!isRagEmbeddingEnabled(config)) {
    return { skipped: true, reason: 'not_configured', chunks };
  }
  const model = getRagEmbeddingModel(config);
  console.log('[RAG EMBEDDING] chunks=' + chunks.length + ' model=' + model);
  const embeddedChunks = [];
  const batchLimit = Math.min(Number(config.rag_embedding_chunk_limit || 80), chunks.length);
  for (const chunk of chunks.slice(0, batchLimit)) {
    const result = await generateEmbedding(chunk.content, { ...context, config });
    if (result.skipped) {
      return { skipped: true, reason: result.reason || 'embedding_failed', chunks: embeddedChunks };
    }
    embeddedChunks.push({
      ...chunk,
      embedding: result.embedding,
      embedding_model: result.model || model
    });
  }
  return { skipped: false, reason: '', chunks: embeddedChunks };
}

async function upsertRagChunks(clientId = '', chunks = [], context = {}) {
  const config = context.effectiveConfig || context.config || {};
  const { sourcesTable, chunksTable } = getRagTables(config);
  if (!clientId || !Array.isArray(chunks) || chunks.length === 0) {
    console.log('[RAG UPSERT] skipped reason=empty_chunks');
    return { skipped: true, reason: 'empty_chunks', count: 0 };
  }
  if (!getRagFlag(config, 'rag_vector_enabled', 'RAG_VECTOR_ENABLED', false)
    || !isRagUpsertEnabled(config)
    || !context.supabase) {
    console.log('[RAG UPSERT] skipped reason=not_configured');
    return { skipped: true, reason: 'not_configured', count: 0 };
  }

  const sourceGroups = new Map();
  for (const chunk of chunks) {
    const key = [
      chunk.client_id,
      chunk.source_type,
      chunk.source_url || '',
      chunk.metadata?.external_id || '',
      chunk.source_content_hash || chunk.content_hash
    ].join('|');
    if (!sourceGroups.has(key)) sourceGroups.set(key, []);
    sourceGroups.get(key).push(chunk);
  }

  let upsertedChunks = 0;
  let quietSourceLogs = 0;
  try {
    for (const groupChunks of sourceGroups.values()) {
      const first = groupChunks[0];
      const sourcePayload = {
        client_id: clientId,
        source_type: first.source_type || 'client_config',
        source_name: first.source_name || 'Fonte do cliente',
        source_url: first.source_url || '',
        external_id: first.metadata?.external_id || first.entity_id || '',
        content_hash: first.source_content_hash || first.content_hash,
        status: 'active',
        last_indexed_at: new Date().toISOString(),
        metadata: {
          source_name: first.source_name || '',
          entity_type: first.entity_type || '',
          topic: first.topic || ''
        }
      };
      const { data: sourceRows, error: sourceError } = await context.supabase
        .from(sourcesTable)
        .upsert(sourcePayload, { onConflict: 'client_id,source_type,source_url,external_id,content_hash' })
        .select('id')
        .limit(1);
      if (sourceError) throw sourceError;
      const sourceId = sourceRows?.[0]?.id;
      if (!sourceId) throw new Error('rag_source_upsert_missing_id');

      const rows = groupChunks.map(chunk => ({
        client_id: clientId,
        source_id: sourceId,
        source_type: chunk.source_type || 'client_config',
        entity_type: chunk.entity_type || 'knowledge',
        entity_id: chunk.entity_id || null,
        topic: chunk.topic || null,
        content: chunk.content,
        content_hash: chunk.content_hash,
        chunk_index: chunk.chunk_index || 0,
        metadata: chunk.metadata || {},
        embedding: chunk.embedding || null,
        embedding_model: chunk.embedding_model || null,
        token_count: chunk.token_count || null
      }));
      const { error: chunksError } = await context.supabase
        .from(chunksTable)
        .upsert(rows, { onConflict: 'client_id,source_id,content_hash,chunk_index' });
      if (chunksError) throw chunksError;
      upsertedChunks += rows.length;
      if (context.quietProductUpsertLogs === true && first.source_type === 'product_api') {
        quietSourceLogs += 1;
      } else {
        console.log('[RAG UPSERT] source=' + (first.source_type || '') + ' chunks=' + rows.length);
      }
    }
    console.log('[RAG UPSERT] client=' + clientId + ' sources=' + sourceGroups.size + ' chunks=' + upsertedChunks + (quietSourceLogs ? ' quietSources=' + quietSourceLogs : ''));
    return { skipped: false, reason: '', count: upsertedChunks };
  } catch (error) {
    console.warn('[RAG UPSERT ERROR] message=' + String(error?.message || error).slice(0, 180));
    return { skipped: true, reason: 'upsert_error', count: upsertedChunks, error: String(error?.message || error) };
  }
}

function shouldUseRagForStorePolicy(plan = {}, config = {}) {
  if (!plan || plan.answer_type !== 'store_policy') return false;
  if (config.rag_disabled === true) return false;
  return true;
}

function shouldUseAgenticRag(plan = {}, config = {}) {
  if (!plan || config.rag_disabled === true) return false;
  if (['order', 'tracking'].includes(plan.answer_type)) return false;
  return true;
}

async function searchRagKnowledge(clientId = '', query = '', options = {}, context = {}) {
  const config = context.effectiveConfig || context.config || {};
  const topK = Math.max(1, Math.min(Number(options.topK || config.rag_top_k || 5), 20));
  const minScore = Number(options.minScore || getConfigOrEnv(config, 'rag_score_threshold', 'RAG_SCORE_THRESHOLD') || 0.72);
  const { matchFunction } = getRagTables(config);
  console.log('[RAG VECTOR] search client=' + clientId + ' query="' + escapeLogValue(String(query || '').slice(0, 160)) + '" topK=' + topK);
  const documents = buildRagSourceDocumentsForConfig(config, clientId);
  const chunks = documents.flatMap(document => chunkRagDocument(document));
  console.log('[RAG CHUNKS] client=' + clientId + ' count=' + chunks.length);

  if (!clientId || !isRagVectorEnabled(config, context)) {
    console.log('[RAG VECTOR] skipped reason=not_configured');
    console.log('[RAG VECTOR] results=0');
    return { results: [], skipped: true, reason: 'not_configured', documents, chunks };
  }

  if (shouldRunRagOnDemandIndex(clientId, chunks, config)) {
    const embeddedChunks = await embedRagChunks(chunks, config, context);
    if (!embeddedChunks.skipped) {
      const upsertResult = await upsertRagChunks(clientId, embeddedChunks.chunks, context);
      if (!upsertResult.skipped) {
        markRagOnDemandIndexComplete(clientId, chunks);
      }
    } else {
      console.log('[RAG INDEX] skipped reason=' + embeddedChunks.reason);
    }
  }

  const queryEmbedding = await generateEmbedding(query, context);
  if (queryEmbedding.skipped || !Array.isArray(queryEmbedding.embedding)) {
    console.log('[RAG VECTOR] skipped reason=' + (queryEmbedding.reason || 'embedding_failed'));
    console.log('[RAG VECTOR] results=0');
    return { results: [], skipped: true, reason: queryEmbedding.reason || 'embedding_failed', documents, chunks };
  }

  const startedAt = Date.now();
  try {
    const { data, error } = await context.supabase.rpc(matchFunction, {
      query_embedding: queryEmbedding.embedding,
      match_client_id: clientId,
      match_count: topK,
      match_threshold: minScore,
      filter_entity_type: options.entity_type || options.entityType || null,
      filter_source_type: options.source_type || options.sourceType || null
    });
    if (error) throw error;
    const results = (Array.isArray(data) ? data : []).map(row => ({
      id: row.id,
      client_id: row.client_id || clientId,
      source_id: row.source_id,
      score: Number(row.similarity || row.score || 0),
      source_type: row.source_type,
      source_name: row.source_name,
      source_url: row.source_url,
      content: row.content,
      metadata: row.metadata || {},
      topic: row.topic,
      entity_type: row.entity_type,
      entity_id: row.entity_id
    }));
    console.log('[RAG VECTOR] results=' + results.length);
    for (const result of results.slice(0, 5)) {
      console.log('[RAG VECTOR RESULT] entity=' + (result.entity_type || '')
        + ' source=' + (result.source_type || '')
        + ' score=' + Number(result.score || 0).toFixed(3)
        + ' text="' + escapeLogValue(String(result.content || '').slice(0, 140)) + '"');
    }
    console.log('[RAG LATENCY] embeddingMs=' + Number(queryEmbedding.ms || 0) + ' searchMs=' + (Date.now() - startedAt) + ' totalMs=' + (Date.now() - startedAt + Number(queryEmbedding.ms || 0)));
    return { results, skipped: false, reason: '', documents, chunks };
  } catch (error) {
    console.warn('[RAG VECTOR ERROR] message=' + String(error?.message || error).slice(0, 180));
    console.log('[RAG VECTOR] results=0');
    return { results: [], skipped: true, reason: 'vector_error', documents, chunks, error: String(error?.message || error) };
  }
}

function buildRagEvidenceBundle(results = [], options = {}) {
  const topic = options.topic || 'store_policy';
  const queries = getStorePolicyTopicQueries(topic, options.query || '');
  const directOnlyTopics = new Set(['cnpj', 'free_shipping']);
  const facts = [];
  for (const result of (Array.isArray(results) ? results : [])) {
    if (!result || !result.content) continue;
    const snippets = splitPolicyEvidenceText(result.content);
    const candidateSnippets = snippets.length > 0 ? snippets : [String(result.content || '').trim()];
    const scoredSnippets = candidateSnippets
      .map(snippet => {
        const relevance = classifyEvidenceRelevance(snippet, topic);
        return {
          snippet,
          relevance,
          score: scorePolicyEvidenceSnippet(snippet, queries)
        };
      })
      .filter(item => item.snippet && (
        item.relevance.relevance === 'direct'
        || (item.relevance.relevance === 'context' && item.score > 0 && !directOnlyTopics.has(topic))
        || (item.relevance.relevance === 'noise' && item.score > 0)
      ));
    const selectedSnippets = scoredSnippets.length > 0
      ? scoredSnippets
      : (directOnlyTopics.has(topic) ? [] : [{
        snippet: String(result.content || '').trim(),
        relevance: classifyEvidenceRelevance(result.content, topic),
        score: 0
      }]);
    for (const item of selectedSnippets.slice(0, 6)) {
      facts.push({
        text: item.snippet,
        source_type: result.source_type || result.sourceType || 'rag_chunk',
        source_name: result.source_name || result.sourceName || 'RAG',
        source_url: result.source_url || result.sourceUrl || '',
        source: result.source_type || result.sourceType || 'rag_chunk',
        sourceType: result.source_type || result.sourceType || 'rag_chunk',
        sourceName: result.source_name || result.sourceName || 'RAG',
        sourceUrl: result.source_url || result.sourceUrl || '',
        relevance: item.relevance.relevance,
        reason: item.relevance.reason,
        score: Number(result.score || result.similarity || 0),
        confidence: item.relevance.relevance === 'direct' ? 'high' : (item.relevance.relevance === 'context' ? 'medium' : 'low'),
        topic,
        type: topic,
        entity_type: result.entity_type || result.entityType || 'store_policy',
        metadata: result.metadata || {}
      });
    }
  }
  const direct = facts.filter(fact => fact.relevance === 'direct').length;
  const contextCount = facts.filter(fact => fact.relevance === 'context').length;
  const noise = facts.filter(fact => fact.relevance === 'noise').length;
  console.log('[RAG EVIDENCE] direct=' + direct + ' context=' + contextCount + ' noise=' + noise);
  return {
    facts,
    directFacts: facts.filter(fact => fact.relevance === 'direct'),
    contextFacts: facts.filter(fact => fact.relevance === 'context'),
    noiseFacts: facts.filter(fact => fact.relevance === 'noise')
  };
}

function normalizeProductForRag(product = {}, sourceInfo = {}) {
  const rawProduct = product.rawProduct || product.raw || product;
  const sizes = [
    ...(Array.isArray(product._sizes) ? product._sizes : []),
    ...getAvailableProductSizes(product),
    ...(Array.isArray(product.sizes) ? product.sizes : [])
  ].map(String).filter(Boolean);
  const colors = [
    ...(Array.isArray(product.colors) ? product.colors : []),
    ...getColorTokens(getSearchTokens([product.title, product.description, product.variations?.join(' ')].filter(Boolean).join(' ')))
  ].map(String).filter(Boolean);
  return {
    id: String(product.id || product.product_id || product.codigo || product.sku || product.url || '').trim(),
    title: String(product.title || product.nome || product.name || '').trim(),
    description: String(product.description || product.descricao || '').trim(),
    category: String(product.category || product.categoria || product.tipo || '').trim(),
    tags: [
      ...(Array.isArray(product.tags) ? product.tags : []),
      product.theme,
      product.brand,
      product.marca
    ].filter(Boolean).map(String),
    price: product.price || product.preco || '',
    stock: getProductAvailableStock(product),
    sizes: [...new Set(sizes)],
    colors: [...new Set(colors)],
    variations: Array.isArray(product.variations) ? product.variations : [],
    images: Array.isArray(product.images) ? product.images : [],
    url: String(product.url || product.link || '').trim(),
    source_type: sourceInfo.source_type || product.sourceType || 'product_api',
    source_name: sourceInfo.source_name || product.sourceName || 'API de produtos',
    rawProduct
  };
}

function buildRagProductDocuments(products = [], clientId = '', sourceInfo = {}) {
  const scopedClientId = String(clientId || '').trim();
  if (!scopedClientId || !Array.isArray(products)) return [];
  return products
    .map(product => normalizeProductForRag(product, sourceInfo))
    .filter(product => product.title || product.id)
    .map(product => {
      const content = [
        product.title ? `Produto: ${product.title}` : '',
        product.description ? `Descricao: ${product.description}` : '',
        product.category ? `Categoria: ${product.category}` : '',
        product.tags.length ? `Tags/Tema/Marca: ${product.tags.join(', ')}` : '',
        product.colors.length ? `Cores: ${product.colors.join(', ')}` : '',
        product.sizes.length ? `Tamanhos: ${product.sizes.join(', ')}` : '',
        product.variations.length ? `Variacoes: ${product.variations.join(', ')}` : ''
      ].filter(Boolean).join('\n');
      return {
        client_id: scopedClientId,
        source_type: product.source_type || 'product_api',
        source_name: product.source_name || 'API de produtos',
        source_url: product.url || sourceInfo.source_url || '',
        external_id: product.id || product.url || '',
        entity_type: 'product',
        entity_id: product.id || product.url || '',
        topic: 'product_catalog',
        content,
        content_hash: buildContentHash(content),
        metadata: {
          product_id: product.id,
          title: product.title,
          normalized_title: normalizeSearchText(product.title),
          price: product.price,
          stock: product.stock,
          sizes: product.sizes,
          colors: product.colors,
          variations: product.variations,
          url: product.url,
          imageUrl: product.images[0] || '',
          images: product.images,
          source_api: product.source_type,
          raw_ref: product.id || product.url,
          last_synced_at: new Date().toISOString()
        }
      };
    });
}

async function indexProductCatalogForClient(clientId = '', config = {}, context = {}) {
  if (!getRagFlag(config, 'rag_products_enabled', 'RAG_PRODUCTS_ENABLED', false)
    || !getRagFlag(config, 'rag_index_products_enabled', 'RAG_INDEX_PRODUCTS_ENABLED', false)) {
    console.log('[RAG PRODUCT INDEX] skipped reason=not_configured');
    return { skipped: true, reason: 'not_configured', documents: [], chunks: [] };
  }
  const query = String(config.rag_product_index_query || config.rag_catalog_index_query || 'produto').trim();
  const productContext = await fetchProductContext(query, buildProductSourcesForConfig(config), {});
  const products = productContext.allProductsCollected || productContext.product_context_products || [];
  const documents = buildRagProductDocuments(products, clientId, { source_type: 'product_api', source_name: 'API de produtos' });
  const chunks = documents.flatMap(document => chunkRagDocument(document));
  console.log('[RAG PRODUCT INDEX] client=' + clientId + ' products=' + products.length + ' chunks=' + chunks.length);
  const embedded = await embedRagChunks(chunks, config, context);
  if (embedded.skipped) return { skipped: true, reason: embedded.reason, documents, chunks };
  const upserted = await upsertRagChunks(clientId, embedded.chunks, context);
  return { skipped: upserted.skipped, reason: upserted.reason, documents, chunks: embedded.chunks };
}

function buildRagProductFilterText(product = {}) {
  return normalizeSearchText([
    product.title,
    product.description,
    product.category,
    ...(Array.isArray(product.tags) ? product.tags : []),
    ...(Array.isArray(product.colors) ? product.colors : []),
    ...(Array.isArray(product.sizes) ? product.sizes : []),
    ...(Array.isArray(product.variations) ? product.variations : [])
  ].filter(Boolean).join(' '));
}

function filterHydratedVectorProductsForQuery(products = [], query = '') {
  const requestedSizes = extractRequestedSizes(query);
  const queryTokens = getSearchTokens(query);
  const specificTokens = getSpecificProductTokens(queryTokens).filter(token => !PRODUCT_COLOR_TOKENS.includes(token));
  const filtered = [];
  const rejected = [];
  for (const product of Array.isArray(products) ? products : []) {
    const text = buildRagProductFilterText(product);
    const matchedSpecific = specificTokens.filter(token => includesToken(text, token));
    const combinedSizes = [
      ...(Array.isArray(product.sizes) ? product.sizes : []),
      ...extractProductSizes(product)
    ].map(normalizeSizeToken).filter(Boolean);
    const productForSize = { ...product };
    if (combinedSizes.length > 0) productForSize._sizes = [...new Set(combinedSizes)];
    const sizeOk = productMatchesRequestedSize(productForSize, requestedSizes);
    const specificOk = specificTokens.length === 0 || matchedSpecific.length > 0;
    if (specificOk && sizeOk) {
      filtered.push({
        ...product,
        _ragFilter: {
          matchedSpecific,
          requestedSizes,
          reason: 'accepted'
        }
      });
    } else {
      rejected.push({
        title: product.title || product.id || '',
        reason: !sizeOk ? 'missing_requested_size' : 'missing_specific_token',
        matchedSpecific
      });
    }
  }
  return { filtered, rejected, requestedSizes, specificTokens };
}

async function observeRagProductSearchFromContext(message = '', productContext = {}, config = {}) {
  if (!getRagFlag(config, 'rag_product_search_enabled', 'RAG_PRODUCT_SEARCH_ENABLED', false)) return;
  const runtimeContext = config._ragRuntimeContext || {};
  const clientId = getRagClientId(runtimeContext, config);
  if (!clientId || !runtimeContext.supabase) return;
  const query = String(productContext.searchText || message || '').trim();
  if (!query) return;
  try {
    const result = await searchVectorProducts(clientId, query, { topK: config.rag_product_top_k || 8 }, {
      ...runtimeContext,
      config,
      effectiveConfig: config
    });
    const hydrated = await hydrateProductsFromApiOrCache(clientId, result.results || [], config, {
      ...runtimeContext,
      config,
      effectiveConfig: config
    });
    const filtered = filterHydratedVectorProductsForQuery(hydrated, query);
    const topTitles = filtered.filtered.slice(0, 5).map(product => product.title).filter(Boolean).join(' | ');
    console.log('[RAG PRODUCT OBSERVE] client=' + clientId
      + ' results=' + ((result.results || []).length)
      + ' hydrated=' + hydrated.length
      + ' filtered=' + filtered.filtered.length
      + ' rejected=' + filtered.rejected.length
      + ' sizes=' + filtered.requestedSizes.join(',')
      + ' tokens=' + filtered.specificTokens.join(',')
      + ' skipped=' + (result.skipped ? 'true' : 'false')
      + ' reason=' + (result.reason || ''));
    if (topTitles) console.log('[RAG PRODUCT FILTER] accepted="' + escapeLogValue(topTitles.slice(0, 220)) + '"');
  } catch (error) {
    console.warn('[RAG PRODUCT OBSERVE ERROR] message=' + String(error?.message || error).slice(0, 180));
  }
}

async function getRagProductPrefilterHints(query = '', config = {}) {
  if (!getRagFlag(config, 'rag_product_prefilter_enabled', 'RAG_PRODUCT_PREFILTER_ENABLED', false)) return [];
  const runtimeContext = config._ragRuntimeContext || {};
  const clientId = getRagClientId(runtimeContext, config);
  if (!clientId || !runtimeContext.supabase) return [];
  const searchText = String(query || '').trim();
  if (!searchText) return [];
  try {
    const result = await searchVectorProducts(clientId, searchText, { topK: config.rag_product_top_k || 8 }, {
      ...runtimeContext,
      config,
      effectiveConfig: config
    });
    if (result.skipped || !Array.isArray(result.results) || result.results.length === 0) return [];
    const hydrated = await hydrateProductsFromApiOrCache(clientId, result.results, config, {
      ...runtimeContext,
      config,
      effectiveConfig: config
    });
    const filtered = filterHydratedVectorProductsForQuery(hydrated, searchText);
    const hints = filtered.filtered
      .map(product => ({
        title: product.title || '',
        titleKey: normalizeSearchText(product.title || ''),
        productId: product.id || product.product_id || ''
      }))
      .filter(hint => hint.titleKey)
      .filter((hint, index, list) => {
        const key = hint.productId ? 'id:' + hint.productId : 'title:' + hint.titleKey;
        return list.findIndex(item => (item.productId ? 'id:' + item.productId : 'title:' + item.titleKey) === key) === index;
      });
    console.log('[RAG PRODUCT PREFILTER] client=' + clientId
      + ' results=' + result.results.length
      + ' hydrated=' + hydrated.length
      + ' filtered=' + filtered.filtered.length
      + ' hints=' + hints.length);
    return hints;
  } catch (error) {
    console.warn('[RAG PRODUCT PREFILTER ERROR] message=' + String(error?.message || error).slice(0, 180));
    return [];
  }
}

async function indexRagProductsFromCollectedCatalog(clientId = '', products = [], config = {}, context = {}) {
  if (!clientId || !Array.isArray(products) || products.length === 0) {
    return { skipped: true, reason: 'empty_products', documents: [], chunks: [] };
  }
  if (!isRagVectorEnabled(config, context)
    || !getRagFlag(config, 'rag_products_enabled', 'RAG_PRODUCTS_ENABLED', false)
    || !getRagFlag(config, 'rag_index_products_enabled', 'RAG_INDEX_PRODUCTS_ENABLED', false)) {
    console.log('[RAG PRODUCT INDEX] skipped reason=not_configured');
    return { skipped: true, reason: 'not_configured', documents: [], chunks: [] };
  }
  const maxProducts = Math.max(1, Math.min(getRagNumber(config, 'rag_product_index_max_items', 'RAG_PRODUCT_INDEX_MAX_ITEMS', 250), 1000));
  const uniqueProducts = dedupeProducts(products).slice(0, maxProducts);
  const documents = buildRagProductDocuments(uniqueProducts, clientId, {
    source_type: 'product_api',
    source_name: 'Catalogo/API de produtos'
  });
  const chunks = documents.flatMap(document => chunkRagDocument(document));
  console.log('[RAG PRODUCT INDEX] client=' + clientId + ' products=' + uniqueProducts.length + ' chunks=' + chunks.length + ' mode=passive');
  if (chunks.length === 0) return { skipped: true, reason: 'empty_chunks', documents, chunks };
  if (!shouldRunRagOnDemandIndex(clientId, chunks, config)) {
    return { skipped: true, reason: 'cache_hit', documents, chunks };
  }
  const embedded = await embedRagChunks(chunks, config, context);
  if (embedded.skipped) {
    console.log('[RAG PRODUCT INDEX] skipped reason=' + (embedded.reason || 'embedding_failed'));
    return { skipped: true, reason: embedded.reason || 'embedding_failed', documents, chunks };
  }
  const upserted = await upsertRagChunks(clientId, embedded.chunks, context);
  if (!upserted.skipped) markRagOnDemandIndexComplete(clientId, chunks);
  console.log('[RAG PRODUCT INDEX DONE] client=' + clientId + ' indexed=' + documents.length + ' chunks=' + (upserted.count || 0) + ' skipped=' + (upserted.skipped ? 1 : 0));
  return { skipped: upserted.skipped, reason: upserted.reason, documents, chunks: embedded.chunks };
}

function queueRagProductIndexFromContext(productContext = {}, config = {}) {
  const runtimeContext = config._ragRuntimeContext || {};
  const clientId = getRagClientId(runtimeContext, config);
  if (!clientId || !runtimeContext.supabase) return;
  const products = productContext.allProductsCollected || productContext.product_context_products || productContext.recent_products_data || [];
  if (!Array.isArray(products) || products.length === 0) return;
  indexRagProductsFromCollectedCatalog(clientId, products, config, {
    ...runtimeContext,
    config,
    effectiveConfig: config,
    quietProductUpsertLogs: true
  }).catch(error => {
    console.warn('[RAG PRODUCT INDEX ERROR] message=' + String(error?.message || error).slice(0, 180));
  });
}

async function searchVectorProducts(clientId = '', query = '', filters = {}, context = {}) {
  const config = context.effectiveConfig || context.config || {};
  if (!getRagFlag(config, 'rag_products_enabled', 'RAG_PRODUCTS_ENABLED', false)
    || !getRagFlag(config, 'rag_product_search_enabled', 'RAG_PRODUCT_SEARCH_ENABLED', false)) {
    console.log('[RAG PRODUCT SEARCH] skipped reason=not_configured');
    return { results: [], skipped: true, reason: 'not_configured' };
  }
  console.log('[RAG PRODUCT SEARCH] client=' + clientId + ' query="' + escapeLogValue(String(query || '').slice(0, 160)) + '"');
  return searchRagKnowledge(clientId, query, {
    topK: filters.topK || config.rag_product_top_k || 8,
    entity_type: 'product',
    source_type: filters.source_type || null,
    minScore: filters.minScore || config.rag_product_score_threshold
  }, context);
}

async function hydrateProductsFromApiOrCache(clientId = '', vectorResults = [], config = {}, context = {}) {
  if (!Array.isArray(vectorResults) || vectorResults.length === 0) return [];
  const hydrated = [];
  for (const result of vectorResults.slice(0, 12)) {
    const metadata = result.metadata || {};
    const contentText = String(result.content || '').trim();
    const contentSignals = {
      title: contentText,
      description: contentText,
      variations: contentText ? [contentText] : []
    };
    const parsedSizes = extractProductSizes(contentSignals);
    const metadataSizes = Array.isArray(metadata.sizes) ? metadata.sizes : [];
    const combinedSizes = [...new Set([...metadataSizes, ...parsedSizes].map(normalizeSizeToken).filter(Boolean))];
    const metadataVariations = Array.isArray(metadata.variations) ? metadata.variations : [];
    if (metadata.title || metadata.product_id || metadata.url) {
      hydrated.push(normalizeProductForRag({
        id: metadata.product_id || result.entity_id,
        title: metadata.title || '',
        price: metadata.price || '',
        stock: metadata.stock,
        description: contentText,
        sizes: combinedSizes,
        colors: metadata.colors || [],
        variations: metadataVariations.length > 0 ? metadataVariations : (contentText ? [contentText] : []),
        images: metadata.images || (metadata.imageUrl ? [metadata.imageUrl] : []),
        url: metadata.url || result.source_url || '',
        sourceType: result.source_type,
        sourceName: result.source_name
      }, { source_type: result.source_type, source_name: result.source_name }));
    }
  }
  console.log('[RAG PRODUCT HYDRATE] client=' + clientId + ' candidates=' + vectorResults.length + ' hydrated=' + hydrated.length);
  return hydrated;
}

async function indexRagSourcesForClient(clientId = '', config = {}, context = {}, options = {}) {
  const startedAt = Date.now();
  if (!clientId) {
    console.log('[RAG INDEX] skipped reason=no_client_id');
    return { skipped: true, reason: 'no_client_id', indexed: 0, chunks: 0 };
  }
  if (!isRagVectorEnabled(config, context)) {
    console.log('[RAG INDEX] skipped reason=not_configured');
    return { skipped: true, reason: 'not_configured', indexed: 0, chunks: 0 };
  }

  let documents = [];
  if (isRagKnowledgeEnabled(config)) {
    documents.push(...buildRagSourceDocumentsForConfig(config, clientId));
  }
  if (options.includeProducts === true || getRagFlag(config, 'rag_index_products_enabled', 'RAG_INDEX_PRODUCTS_ENABLED', false)) {
    const productIndex = await indexProductCatalogForClient(clientId, config, context);
    if (!productIndex.skipped) {
      console.log('[RAG INDEX DONE] client=' + clientId + ' indexed=' + productIndex.documents.length + ' skipped=0 failed=0 ms=' + (Date.now() - startedAt));
      return productIndex;
    }
  }

  const chunks = documents.flatMap(document => {
    const chunked = chunkRagDocument(document);
    console.log('[RAG CHUNKS] source=' + document.source_type + ':' + (document.source_name || '') + ' count=' + chunked.length);
    return chunked;
  });
  console.log('[RAG INDEX] client=' + clientId + ' sources=' + documents.length);
  const embedded = await embedRagChunks(chunks, config, context);
  if (embedded.skipped) {
    console.log('[RAG INDEX DONE] client=' + clientId + ' indexed=0 skipped=' + chunks.length + ' failed=0 ms=' + (Date.now() - startedAt));
    return { skipped: true, reason: embedded.reason, indexed: 0, chunks: chunks.length };
  }
  const upserted = await upsertRagChunks(clientId, embedded.chunks, context);
  console.log('[RAG INDEX DONE] client=' + clientId + ' indexed=' + (upserted.count || 0) + ' skipped=0 failed=' + (upserted.skipped ? 1 : 0) + ' ms=' + (Date.now() - startedAt));
  return { skipped: upserted.skipped, reason: upserted.reason, indexed: upserted.count || 0, chunks: embedded.chunks.length };
}

function buildUniversalEvidenceBundle(answerType = '', query = '') {
  return {
    answer_type: answerType,
    query,
    facts: [],
    vectorFacts: [],
    configFacts: [],
    sourceFacts: [],
    productFacts: [],
    orderFacts: [],
    selectedProductFacts: [],
    directFacts: [],
    contextFacts: [],
    noise: [],
    products: [],
    product_cards: [],
    missing: [],
    warnings: [],
    tools_used: [],
    confidence: 'low'
  };
}

async function executeAgenticRagTools(plan = {}, state = {}, context = {}) {
  const config = context.effectiveConfig || context.config || {};
  const clientId = getRagClientId(context, config);
  const query = String(state.message || context.message || plan.understanding || '').trim();
  const bundle = buildUniversalEvidenceBundle(plan.answer_type || '', query);
  const tools = Array.isArray(plan.tools) ? plan.tools : [];
  for (const tool of tools) {
    const name = tool.name;
    console.log('[AGENT TOOL] name=' + name + ' status=started');
    if (name === 'search_vector_knowledge') {
      const result = await searchRagKnowledge(clientId, tool.args?.query || query, { entity_type: tool.args?.entity_type || null }, context);
      const evidence = buildRagEvidenceBundle(result.results || [], { topic: tool.args?.topic || 'store_policy' });
      bundle.vectorFacts.push(...evidence.facts);
      bundle.directFacts.push(...evidence.directFacts);
      bundle.contextFacts.push(...evidence.contextFacts);
      bundle.noise.push(...evidence.noiseFacts);
      bundle.tools_used.push({ tool: name, status: result.skipped ? 'skipped' : 'executed', reason: result.reason || '' });
      console.log('[AGENT EVIDENCE] tool=' + name + ' direct=' + evidence.directFacts.length + ' context=' + evidence.contextFacts.length + ' noise=' + evidence.noiseFacts.length);
      continue;
    }
    if (name === 'search_config_knowledge') {
      const configFacts = extractStorePolicyFactsFromConfig(config, plan, tool.args?.query || query).facts || [];
      for (const fact of configFacts) {
        if (fact.relevance === 'direct') bundle.configFacts.push(fact);
        else if (fact.relevance === 'context') bundle.contextFacts.push(fact);
        else bundle.noise.push(fact);
      }
      bundle.directFacts.push(...configFacts.filter(fact => fact.relevance === 'direct'));
      bundle.tools_used.push({ tool: name, status: 'executed', reason: 'config_scanned' });
      console.log('[AGENT EVIDENCE] tool=' + name + ' direct=' + configFacts.filter(fact => fact.relevance === 'direct').length
        + ' context=' + configFacts.filter(fact => fact.relevance === 'context').length
        + ' noise=' + configFacts.filter(fact => fact.relevance === 'noise').length);
      continue;
    }
    if (name === 'search_vector_products') {
      const result = await searchVectorProducts(clientId, tool.args?.query || query, tool.args || {}, context);
      const hydrated = await hydrateProductsFromApiOrCache(clientId, result.results || [], config, context);
      bundle.products.push(...hydrated);
      bundle.tools_used.push({ tool: name, status: result.skipped ? 'skipped' : 'executed', reason: result.reason || '' });
      continue;
    }
    if (name === 'hydrate_products_from_api' || name === 'search_product_api' || name === 'filter_products_by_size') {
      bundle.tools_used.push({ tool: name, status: 'skipped', reason: 'product_rag_active_flow_disabled_by_default' });
      console.log('[AGENT TOOL] name=' + name + ' status=skipped reason=product_rag_active_flow_disabled_by_default');
      continue;
    }
    bundle.tools_used.push({ tool: name, status: 'skipped', reason: 'not_implemented_in_universal_router_yet' });
    console.log('[AGENT TOOL] name=' + name + ' status=skipped reason=not_implemented_in_universal_router_yet');
  }
  bundle.confidence = bundle.directFacts.length > 0 ? 'high' : (bundle.contextFacts.length > 0 ? 'medium' : 'low');
  return bundle;
}

function suppressRepeatedGreeting(text, greetingMessage, conversation) {
  const totalMessages = Number(conversation?.total_messages || 0);
  const canGreet = conversation?.conversation_created === true || totalMessages <= 1;
  if (canGreet || !text) return text;

  let response = String(text).trim();
  const greeting = String(greetingMessage || '').trim();
  if (greeting && response.toLowerCase().startsWith(greeting.toLowerCase())) {
    response = response.slice(greeting.length).replace(/^[\s,.:;!?-]+/, '').trim();
  }

  response = response.replace(/^(ol[áa]|oi|bom dia|boa tarde|boa noite)[!,.\s-]+/i, '').trim();
  return response || text;
}

function removeImageUrlsFromResponse(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+\.(?:png|jpe?g|webp|gif)(?:\?\S*)?/gi, '')
    .replace(/https?:\/\/(?:arquivos\.facilzap\.app\.br|facilzap\.app\.br\/cdn-cgi\/image)\/\S+/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeProductMediaResponse(text, productCards = []) {
  let response = removeImageUrlsFromResponse(text);
  if (!Array.isArray(productCards) || productCards.length === 0) {
    return response
      .replace(/\b(aqui est[aã]o|seguem|enviei|vou enviar|mandei)\b.{0,80}\b(fotos|imagens)\b[^\n.]*/gi, 'Encontrei produtos no catalogo, mas nao encontrei fotos seguras para enviar automaticamente')
      .trim();
  }

  const asksPermission = /posso\s+(te\s+)?(mandar|enviar|mostrar)|quer\s+que\s+eu\s+(mande|envie|mostre)|quer\s+ver\s+(as\s+)?fotos|deseja\s+(que\s+eu\s+)?(ver|receber|as\s+fotos)/i.test(response);
  if (asksPermission || !response) {
    const first = productCards[0];
    return [
      `Encontrei ${first?.title || 'o produto'} na loja.`,
      first?.description || '',
      'Enviei as fotos do produto acima.'
    ].filter(Boolean).join('\n');
  }

  return response
    .replace(/(?:posso|quer que eu|deseja que eu)[^.!?\n]*(?:foto|imagem|imagens|fotos)[^.!?\n]*[.!?]?/gi, 'Enviei as fotos do produto acima.')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildProductLookupEmptyResponse(searchText) {
  const tokens = getSpecificProductTokens(getSearchTokens(searchText))
    .filter(token => ![
      'nao',
      'não',
      'pedi',
      'pra',
      'pro',
      'olha',
      'olhar',
      'direito',
      'porque',
      'aviso',
      'avisos',
      'pedido',
      'pedidos',
      'minimo',
      'mínimo',
      'catalogo',
      'catálogo',
      'configurado',
      'mais',
      'outra',
      'outras',
      'outro',
      'outros',
      'nova',
      'novas',
      'novo',
      'novos',
      'diferente',
      'diferentes',
      'opcao',
      'opcoes',
      'modelo',
      'modelos'
    ].includes(token));
  const requested = tokens.length > 0 ? tokens.join(' ') : 'esse produto';
  console.log('[PRODUCT FALLBACK HUMAN] reason=lookup_empty requested="' + requested + '"');
  return `Nao encontrei exatamente ${requested} no momento. Posso procurar opcoes parecidas para voce?`;
}

function buildProductCardsResponse(productCards = []) {
  if (!Array.isArray(productCards) || productCards.length === 0) {
    return 'As fotos foram enviadas acima. Se quiser, posso verificar tamanho, cor ou mais modelos.';
  }

  function cleanTitle(raw) {
    return String(raw || '')
      .replace(/^🛍️?\s*/u, '')
      .replace(/\s*-\s*foto\s*\d+$/i, '')
      .trim();
  }

  function extractPriceFromDescription(desc) {
    const match = String(desc || '').match(/💰\s*Pre[c\u00E7]o:\s*(R\$\s*[\d.,]+)/iu);
    return match ? match[1].trim() : '';
  }

  const seen = new Set();
  const lines = [];
  for (const card of productCards) {
    const title = cleanTitle(card?.title);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const price = extractPriceFromDescription(card?.description);
    lines.push(price ? title + ' — ' + price : title);
    if (lines.length >= 5) break;
  }

  return [
    lines.length === 1
      ? 'Encontrei ' + lines[0] + ' na loja.'
      : 'Encontrei ' + String(lines.length) + ' opcoes na loja:\n' + lines.map(function(l) { return '\u2022 ' + l; }).join('\n'),
    'As fotos foram enviadas acima. Se quiser, posso verificar tamanho, cor ou mais modelos.'
  ].join('\n');
}

function buildProductContextSummaryResponse(productContext, searchText) {
  const lines = String(productContext?.contextText || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^(Titulo|Preco|Estoque informado|Tamanhos encontrados|Variacoes|Descricao):/i.test(line))
    .slice(0, 12);
  if (lines.length === 0) return buildProductLookupEmptyResponse(searchText);
  return [
    'Encontrei essas informacoes no catalogo configurado:',
    lines.join('\n')
  ].join('\n');
}

function buildOperationalSummaryResponse(operationalContext, message) {
  const text = String(operationalContext?.contextText || '');
  if (!text) return '';
  const pedido = extractOrderReference(message);
  const getLineValue = (pattern) => text.match(pattern)?.[1]?.trim() || '';
  const cliente = getLineValue(/cliente: nome:\s*([^\n]+)/i);
  const codigo = getLineValue(/^-\s*codigo:\s*([^\n]+)/im) || getLineValue(/\ncodigo:\s*([^\n]+)/i);
  const formaEntrega = getLineValue(/forma_entrega: nome:\s*([^\n]+)/i);
  const pagamentoStatus = getLineValue(/pagamentos: status:\s*([^\n]+)/i);
  const total = getLineValue(/^-\s*total:\s*([^\n]+)/im) || getLineValue(/\ntotal:\s*([^\n]+)/i);
  const pago = /status_pago:\s*true/i.test(text);
  const emSeparacao = /status_em_separacao:\s*true/i.test(text);
  const separado = /status_separado:\s*true/i.test(text);
  const despachado = /status_despachado:\s*true/i.test(text);
  const entregue = /status_entregue:\s*true/i.test(text);

  if (!pedido && !codigo && !cliente && !pagamentoStatus && !formaEntrega) return '';

  const statusAtual = entregue
    ? 'Entregue'
    : despachado
      ? 'Despachado/enviado'
      : separado
        ? 'Separado'
        : emSeparacao
          ? 'Em separacao'
          : pago || /pago/i.test(pagamentoStatus)
            ? 'Pagamento confirmado, aguardando separacao/envio'
            : 'Pedido localizado';

  return [
    pedido ? `Encontrei o pedido ${pedido} na integracao.` : 'Encontrei o pedido na integracao.',
    codigo ? `Codigo interno: ${codigo}.` : '',
    cliente ? `Cliente: ${cliente}.` : '',
    total ? `Total: ${formatCurrencyBRL(total) || total}.` : '',
    formaEntrega ? `Entrega: ${formaEntrega}.` : '',
    `Status atual: ${statusAtual}.`,
    `Pagamento: ${pago || /pago/i.test(pagamentoStatus) ? 'pago/confirmado' : 'nao confirmado nos dados consultados'}.`,
    `Separacao: ${emSeparacao ? 'em separacao' : separado ? 'separado' : 'ainda nao consta como separado'}.`,
    `Envio: ${despachado ? 'despachado' : 'ainda nao consta como despachado'}.`,
    `Entrega: ${entregue ? 'entregue' : 'ainda nao consta como entregue'}.`
  ].filter(Boolean).join('\n');
}

function truncateText(value, maxLength) {
  const text = String(value || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…';
}

function buildCarouselCardTitle(product, suffix = '') {
  const title = String(product?.title || 'Produto').trim();
  return truncateText(`🛍️ ${title}${suffix}`, 60);
}

function isSizeVariation(value, knownSizes = []) {
  const text = normalizeSearchText(value);
  if (!text) return false;
  if (knownSizes.some(size => text === String(size) || text === `tamanho ${size}` || text === `tam ${size}`)) return true;
  return /^(?:tamanho|tam|numero|n)?\s*(?:\d{1,2}|pp|p|m|g|gg|xg|xgg)$/.test(text)
    || /^\d{1,2}\s*(?:anos|ano)$/.test(text);
}

function stripSizeFromVariation(value, knownSizes = []) {
  let text = String(value || '').trim();
  if (!text) return '';
  const sizePattern = '(?:\\d{1,2}|pp|p|m|g|gg|xg|xgg)';
  text = text
    .replace(new RegExp(`\\b(?:tamanho|tamanhos|tam|numero|n)\\s*${sizePattern}\\b`, 'gi'), ' ')
    .replace(/\b\d{1,2}\s*(?:anos|ano)\b/gi, ' ');
  for (const size of knownSizes) {
    const escaped = String(size).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`(?:^|[\\s\\-/|,;:])${escaped}(?=$|[\\s\\-/|,;:])`, 'gi'), ' ');
  }
  return text.replace(/^[\s\-/|,;:]+|[\s\-/|,;:]+$/g, '').replace(/\s{2,}/g, ' ').trim();
}

function getDisplayColorVariations(product) {
  const knownSizes = Array.isArray(product?._sizes) ? product._sizes : [];
  const seen = new Set();
  return (Array.isArray(product?.variations) ? product.variations : [])
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .filter(value => !isSizeVariation(value, knownSizes))
    .map(value => stripSizeFromVariation(value, knownSizes))
    .filter(Boolean)
    .filter(value => {
      const key = normalizeSearchText(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

function buildCarouselCardDescription(product) {
  const availableSizes = getAvailableProductSizes(product);
  const sizes = availableSizes.length
    ? availableSizes.slice(0, 6).join(', ')
    : Array.isArray(product?._sizes) && product._sizes.length
      ? product._sizes.slice(0, 6).join(', ')
      : '';
  const availableVariationLabels = getAvailableProductVariationLabels(product);
  const colors = availableVariationLabels.length
    ? availableVariationLabels
    : getDisplayColorVariations(product);
  const colorText = colors.length
    ? colors.join(', ')
    : '';
  const stock = getProductAvailableStock(product);
  const details = [
    product?.price ? `💰 Preço: ${product.price}` : '',
    sizes ? `📏 Tamanho: ${sizes}` : '',
    colorText ? `🎨 Cor: ${colorText}` : '',
    stock !== null && stock !== undefined && stock !== '' ? `📦 Estoque: ${stock}` : '',
    product?.description ? `📝 Detalhes: ${String(product.description).replace(/\s+/g, ' ').trim()}` : ''
  ].filter(Boolean);
  return truncateText(details.join('\n'), 260);
}

function buildAIUnavailableResponse(config) {
  return 'No momento nao consegui acessar o modelo de IA configurado. Sua mensagem foi recebida e um atendente pode continuar se necessario.';
}

function buildOutsideWorkingHoursResponse(config) {
  return 'No momento estamos fora do horario de atendimento, mas sua mensagem foi recebida.';
}

function buildDailyLimitResponse(config) {
  return 'No momento o limite diario de respostas automaticas foi atingido. Sua mensagem foi recebida.';
}

function buildAIProviderErrorResponse(config) {
  return 'No momento tive uma instabilidade para gerar a resposta automatica. Sua mensagem foi recebida.';
}

function getTokenUsageFromOpenAI(data) {
  const usage = data?.usage || {};
  return {
    prompt_tokens: usage.input_tokens || usage.prompt_tokens || 0,
    completion_tokens: usage.output_tokens || usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || ((usage.input_tokens || usage.prompt_tokens || 0) + (usage.output_tokens || usage.completion_tokens || 0))
  };
}

function getOpenAIText(data) {
  if (data?.output_text) return data.output_text;

  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === 'output_text' && part?.text) return part.text;
      if (part?.text) return part.text;
    }
  }

  return '';
}

function extractUrls(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s<>"')]+/gi) || [];
  return [...new Set(matches.map(url => url.replace(/[.,;!?]+$/, '')))].slice(0, 3);
}

function normalizeSourceUrls(values = []) {
  const urls = [];
  for (const value of values) {
    for (const url of extractUrls(value)) {
      if (!urls.includes(url)) urls.push(url);
    }
  }
  return urls.slice(0, 5);
}

function normalizeProductSources(values = []) {
  const sources = [];
  const seen = new Set();
  const addSource = (source) => {
    if (!source) return;
    if (typeof source === 'string') {
      for (const url of extractUrls(source)) {
        const key = url.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        sources.push({ url, type: 'link', name: 'Link configurado', headers: {} });
      }
      return;
    }
    const url = String(source.url || source.api_endpoint || '').trim();
    if (!/^https?:\/\//i.test(url)) return;
    const key = `${String(source.type || source.integration_type || 'link').toLowerCase()}:${url.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push({
      url,
      type: source.type || source.integration_type || 'link',
      name: source.name || source.integration_name || 'Fonte configurada',
      endpointKey: source.endpointKey,
      publicCatalogUrl: source.publicCatalogUrl || '',
      operational: source.operational === true,
      headers: source.headers || {}
    });
  };

  values.forEach(addSource);
  return sources.slice(0, 30);
}

function buildIntegrationHeaders(integration = {}) {
  const headers = { Accept: 'application/json' };
  const authType = String(integration.config?.auth_type || integration.auth_type || 'bearer').toLowerCase();
  if (integration.api_key) {
    if (authType === 'x-api-key' || authType === 'api_key') {
      headers['x-api-key'] = integration.api_key;
    } else if (authType === 'query') {
      // Query-string tokens are appended when URLs are built.
    } else {
      headers.Authorization = `Bearer ${integration.api_key}`;
    }
  }
  if (integration.api_secret) headers['x-api-secret'] = integration.api_secret;
  return headers;
}

function joinIntegrationUrl(baseUrl, endpointPath) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const pathValue = String(endpointPath || '').trim();
  if (!base || !pathValue) return '';
  if (/^https?:\/\//i.test(pathValue)) return pathValue;
  return `${base}/${pathValue.replace(/^\/+/, '')}`;
}

function getIntegrationApiBaseUrl(integration = {}) {
  const rawBase = String(integration.api_endpoint || integration.url || '').trim();
  if ((integration.integration_type || integration.type) !== 'facilzap') return rawBase;
  try {
    const parsed = new URL(rawBase);
    if (/facilzap\.app\.br$/i.test(parsed.hostname) && parsed.hostname !== 'api.facilzap.app.br') {
      return 'https://api.facilzap.app.br';
    }
  } catch (error) {
    return rawBase;
  }
  return rawBase;
}

function interpolateIntegrationPath(pathValue, params = {}) {
  return String(pathValue || '').replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(params[key] || ''));
}

function addQueryParam(url, key, value) {
  if (!url || !key || value === undefined || value === null || value === '') return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set(key, value);
    return parsed.toString();
  } catch (error) {
    return url;
  }
}

function sanitizeUrlForLog(url) {
  try {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) {
      if (/token|api[_-]?key|secret|senha|password/i.test(key)) parsed.searchParams.set(key, '[redacted]');
    }
    return parsed.toString();
  } catch (error) {
    return String(url || '').replace(/(token|api[_-]?key|secret|senha|password)=([^&\s]+)/ig, '$1=[redacted]');
  }
}

function addQueryParamVariants(source, variants = []) {
  const urls = [];
  const seen = new Set();
  for (const [key, value] of variants) {
    const url = addQueryParam(source?.url, key, value);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push({ ...source, url, name: `${source.name} (${key})` });
  }
  return urls;
}

function extractOrderReference(message) {
  const text = normalizeSearchText(message);
  return text.match(/\b(?:pedido|numero|n)\s*(\d{2,})\b/i)?.[1]
    || text.match(/\b\d{4,}\b/)?.[0]
    || '';
}

function buildIntegrationEndpointSource(integration, endpointKey, params = {}) {
  const integrationType = integration.integration_type || integration.type;
  const config = {
    ...(DEFAULT_INTEGRATION_CONFIG[integrationType] || {}),
    ...(integration.config || {})
  };
  const pathValue = config[endpointKey];
  const url = joinIntegrationUrl(getIntegrationApiBaseUrl(integration), interpolateIntegrationPath(pathValue, params));
  if (!url) return null;
  let finalUrl = url;
  const authType = String(config.auth_type || 'bearer').toLowerCase();
  if (authType === 'query' && integration.api_key) {
    finalUrl = addQueryParam(finalUrl, config.token_param || 'token', integration.api_key);
  }
  return {
    url: finalUrl,
    type: integration.integration_type || integration.type || 'api',
    name: `${integration.integration_name || integration.name || 'Integracao'} - ${endpointKey}`,
    endpointKey,
    publicCatalogUrl: firstValue(config.public_catalog_url, config.product_public_url, config.product_catalog_url, config.catalog_url, config.store_url, config.site_url, ''),
    operational: ['orders_path', 'order_status_path', 'tracking_path', 'customers_path', 'stock_path'].includes(endpointKey),
    headers: integration.headers || buildIntegrationHeaders(integration)
  };
}

function buildProductIntegrationSources(integration) {
  const sources = ['products_path', 'stock_path', 'catalog_path']
    .map(key => buildIntegrationEndpointSource(integration, key))
    .filter(Boolean);
  const integrationType = integration.integration_type || integration.type;
  if (integrationType !== 'facilzap') return sources;

  // Paginação dinâmica: gera até FACILZAP_MAX_PAGES páginas.
  // fetchProductContext para quando a página vem vazia ou sem novos produtos.
  // Limite configurável — padrão 25 para cobrir catálogos grandes com segurança.
  const FACILZAP_MAX_PAGES = 25;
  const productSources = [];
  for (const source of sources) {
    if (source.endpointKey !== 'products_path' && source.endpointKey !== 'stock_path') continue;
    for (let page = 1; page <= FACILZAP_MAX_PAGES; page += 1) {
      productSources.push({
        ...source,
        url: addQueryParam(source.url, 'page', page),
        name: `${source.name} (page ${page})`
      });
    }
  }
  return productSources.length > 0 ? productSources : sources;
}

function getProductSearchPhrase(message) {
  const tokens = getSpecificProductTokens(getSearchTokens(message))
    .filter(token => !['tem', 'vende', 'vender', 'quero', 'queria', 'procuro', 'preciso', 'fotos', 'foto', 'opcoes', 'opcao', 'quantas', 'quantos', 'quanto', 'quanta', 'peca', 'pecas', 'estoque', 'disponivel', 'disponiveis'].includes(token));
  return tokens.slice(0, 4).join(' ');
}

function expandProductSourcesForSearch(message, sources = []) {
  const searchPhrase = getProductSearchPhrase(message);
  if (!searchPhrase) return sources;
  const expanded = [];
  for (const source of sources) {
    expanded.push(source);
    if (source.type === 'facilzap') continue;
    if (!['products_path', 'stock_path'].includes(source.endpointKey)) continue;
    for (const param of ['q', 'search', 'busca', 'nome', 'categoria', 'termo']) {
      expanded.push({
        ...source,
        url: addQueryParam(source.url, param, searchPhrase),
        name: `${source.name} (${param})`
      });
    }
  }
  return normalizeProductSources(expanded);
}

function buildConfiguredProductSources(config = {}) {
  return normalizeProductSources([
    ...(Array.isArray(config.product_integrations) ? config.product_integrations.flatMap(integration => [
      ...buildProductIntegrationSources(integration)
    ]) : []),
    config.product_catalog_url,
    ...(Array.isArray(config.product_source_urls) ? config.product_source_urls : []),
    config.system_prompt
  ]);
}

function isProductApiSource(source = {}) {
  const url = String(source.url || '').toLowerCase();
  return /\/produtos(?:[/?#]|$)/i.test(url) || /products_path|stock_path/i.test(String(source.name || ''));
}

function buildProductSourcesForConfig(config = {}) {
  return buildConfiguredProductSources(config);
}

function buildKnowledgeSourcesForConfig(config = {}) {
  const integrationPublicUrls = (Array.isArray(config.product_integrations) ? config.product_integrations : [])
    .flatMap(integration => {
      const integrationType = integration.integration_type || integration.type;
      const cfg = {
        ...(DEFAULT_INTEGRATION_CONFIG[integrationType] || {}),
        ...(integration.config || {})
      };
      return [
        cfg.site_url,
        cfg.store_url,
        cfg.public_catalog_url,
        cfg.product_catalog_url,
        cfg.catalog_url
      ];
    });
  return normalizeProductSources([
    config.site_url,
    config.store_url,
    config.knowledge_base_url,
    config.product_catalog_url,
    ...(Array.isArray(config.site_urls) ? config.site_urls : []),
    ...(Array.isArray(config.knowledge_source_urls) ? config.knowledge_source_urls : []),
    ...(Array.isArray(config.source_urls) ? config.source_urls : []),
    ...(Array.isArray(config.product_source_urls) ? config.product_source_urls : []),
    ...integrationPublicUrls,
    config.system_prompt
  ]).filter(source => !isProductApiSource(source));
}

function buildOperationalSourcesForConfig(config = {}, message = '', contact = {}, conversation = {}) {
  return buildOperationalIntegrationSources(config, message, contact, conversation);
}

function hasStrongProductIntent(message) {
  const text = normalizeSearchText(message);
  if (!text) return false;
  const nonCatalogInfo = /\b(como comprar|forma de comprar|formas de comprar|passo a passo|pedido minimo|valor minimo|compra minima|aviso|avisos|regras|endereco|localizacao|onde fica|horario|funcionamento|telefone|contato|pagamento|pagar|pix|cartao|boleto|entrega|frete|retirada|troca|devolucao|status|rastreio|pedido)\b/i.test(text);
  const wantsMedia = /\b(foto|fotos|imagem|imagens|mostra|mostrar|mande|manda|envie|envia|ver)\b/i.test(text);
  const wantsProduct = /\b(quero|queria|procuro|procurando|busco|preciso|gostaria|tem|vende|vendem|trabalha|trabalham|possui|temos|custa|preco|valor|opcao|opcoes|modelos|mais|outra|outras|outro|outros)\b/i.test(text);
  const productNoun = /\b(produto|produtos|catalogo|roupa|roupas|vestido|vestidos|conjunto|conjuntos|blusa|blusas|body|bodys|calca|calcas|macacao|jardineira|saia|saias|short|shorts|camiseta|camisetas|camisa|camisas|tshirt|cropped|moletom|moletons|moleton|moletons|pijama|pijamas|regata|regatas|jaqueta|jaquetas|casaco|casacos)\b/i.test(text);
  const productAttribute = /\b(preco|valor|estoque|tamanho|tamanhos|cor|cores|variacao|variacoes|tem|vende|opcao|opcoes|modelos)\b/i.test(text);
  const specificTokens = getSpecificProductTokens(getSearchTokens(text));
  const hasSearchableCatalogTerm = productNoun || specificTokens.length > 0;
  if (nonCatalogInfo && !productNoun) return false;
  const tokenCount = text.split(' ').filter(Boolean).length;
  return (wantsMedia && hasSearchableCatalogTerm)
    || (wantsProduct && hasSearchableCatalogTerm)
    || (productNoun && (productAttribute || wantsProduct))
    || (productNoun && tokenCount <= 3)
    || extractRequestedSizes(message).length > 0;
}
function isMoreProductOptionsRequest(message) {
  const text = normalizeSearchText(message);
  return /\b(mais|outra|outras|outro|outros|novas|novos|diferentes|ver mais|mostrar mais|mande mais|manda mais|envie mais)\b/.test(text)
    && /\b(opcao|opcoes|modelo|modelos|produto|produtos|foto|fotos|imagem|imagens|roupa|roupas|vestido|vestidos|conjunto|conjuntos|blusa|blusas|body|bodys|calca|calcas|macacao|jardineira|saia|saias|short|shorts|camiseta|camisetas|tshirt|cropped|moletom|moletons|moleton|moletons)\b/.test(text);
}

function isCatalogFollowUpRequest(message) {
  const text = normalizeSearchText(message);
  return /\b(foto|fotos|imagem|imagens|manda|mande|envia|envie|ver|mostra|mostre|mais|outra|outras|outro|outros|opcao|opcoes|modelo|modelos)\b/i.test(text);
}

function shouldUseConfiguredProductSources(message) {
  if (extractUrls(message).length > 0) return true;
  const normalized = normalizeSearchText(message);
  if (/(^|\s)(como comprar|forma de comprar|formas de comprar|passo a passo|pedido minimo|valor minimo|compra minima|aviso|avisos|regras|endereco|localizacao|onde fica|horario|funcionamento|telefone|contato|pagamento|pagar|pix|cartao|boleto|entrega|frete|retirada|troca|devolucao|status|rastreio)(\s|$)/i.test(normalized)) {
    return false;
  }
  return hasStrongProductIntent(message);
}
function shouldUseConfiguredSiteSources(message) {
  if (extractUrls(message).length > 0) return true;
  const text = normalizeSearchText(message);
  if (!text) return false;
  if (isShortContextualReply(message)) return false;
  if (!hasStrongProductIntent(message)) return true;
  return [
    'cnpj',
    'endereco',
    'localizacao',
    'loja fisica',
    'onde fica',
    'como comprar',
    'comprar',
    'pedido',
    'pedido minimo',
    'valor minimo',
    'compra minima',
    'aviso',
    'avisos',
    'regras',
    'regra',
    'pagamento',
    'pagar',
    'pix',
    'cartao',
    'entrega',
    'frete',
    'retirada',
    'troca',
    'devolucao',
    'garantia',
    'horario',
    'funcionamento',
    'telefone',
    'whatsapp',
    'instagram',
    'contato',
    'quem somos',
    'sobre',
    'politica'
  ].some(term => text.includes(term));
}

function shouldUseOperationalIntegrationSources(message) {
  const text = normalizeSearchText(message);
  if (!text) return false;
  return /\b(pedido|pedidos|enviado|enviou|envio|rastreio|rastrear|codigo de rastreio|status|estoque|disponivel|cliente|compra|compras)\b/i.test(text);
}

function buildOperationalIntegrationSources(config = {}, message = '', contact = {}, conversation = {}) {
  const integrations = Array.isArray(config.product_integrations) ? config.product_integrations : [];
  const phone = String(contact?.phone || conversation?.phone || '').replace(/\D/g, '');
  const query = String(message || '').trim();
  const pedido = extractOrderReference(message);
  const sources = [];
  for (const integration of integrations) {
    const integrationType = integration.integration_type || integration.type;
    const cfg = {
      ...(DEFAULT_INTEGRATION_CONFIG[integrationType] || {}),
      ...(integration.config || {})
    };
    const params = { phone, telefone: phone, query, q: query, pedido, order: pedido };
    const endpointKeys = shouldUseOperationalIntegrationSources(message)
      ? ['order_status_path', 'orders_path', 'customers_path', 'stock_path']
      : [];
    for (const key of endpointKeys) {
      if ((key === 'order_status_path' || key === 'tracking_path') && !pedido && String(cfg[key] || '').includes('{pedido}')) continue;
      let source = buildIntegrationEndpointSource(integration, key, params);
      if (!source) continue;
      const rawSource = { ...source };
      if (phone && cfg.phone_param && ['orders_path', 'customers_path'].includes(key)) source.url = addQueryParam(source.url, cfg.phone_param, phone);
      if (pedido && cfg.order_param && ['orders_path'].includes(key)) source.url = addQueryParam(source.url, cfg.order_param, pedido);
      if (query && cfg.query_param && ['stock_path'].includes(key)) source.url = addQueryParam(source.url, cfg.query_param, query);
      sources.push(source);
      if (integrationType === 'facilzap' && key === 'orders_path') {
        if (pedido) {
          sources.push(...addQueryParamVariants(rawSource, [
            ['codigo', pedido],
            ['id', pedido],
            ['pedido', pedido],
            ['q', pedido]
          ]));
        }
        if (phone) {
          sources.push(...addQueryParamVariants(rawSource, [
            ['telefone', phone],
            ['whatsapp', phone],
            ['whatsapp_e164', `+${phone}`]
          ]));
        }
      }
    }
  }
  return normalizeProductSources(sources);
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolvePageUrl(baseUrl, value) {
  try {
    return new URL(value, baseUrl).toString();
  } catch (error) {
    return '';
  }
}

function getMetaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i')
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1]);
  }
  return '';
}

function getTitleFromHtml(html) {
  return decodeHtml(getMetaContent(html, 'og:title') || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''));
}

function extractJsonLdImages(html, pageUrl) {
  const images = [];
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html))) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const graph = Array.isArray(item?.['@graph']) ? item['@graph'] : [item];
        for (const node of graph) {
          const image = node?.image;
          const values = Array.isArray(image) ? image : [image];
          for (const value of values) {
            const url = typeof value === 'string' ? value : value?.url;
            if (url) images.push(resolvePageUrl(pageUrl, url));
          }
        }
      }
    } catch (error) {
      // Invalid JSON-LD is common on storefronts; ignore and keep other metadata.
    }
  }
  return images.filter(Boolean);
}

function flattenJsonLdNodes(value) {
  const nodes = [];
  const visit = (item) => {
    if (!item) return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item !== 'object') return;
    nodes.push(item);
    if (Array.isArray(item['@graph'])) item['@graph'].forEach(visit);
    if (Array.isArray(item.itemListElement)) item.itemListElement.forEach(entry => visit(entry.item || entry));
  };
  visit(value);
  return nodes;
}

function parseJsonLdScripts(html) {
  const items = [];
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html))) {
    try {
      items.push(JSON.parse(match[1].trim()));
    } catch (error) {
      // Ignore invalid JSON-LD and keep parsing other scripts.
    }
  }
  return items;
}

function getJsonLdType(node) {
  const type = node?.['@type'];
  return Array.isArray(type) ? type.map(String).join(' ').toLowerCase() : String(type || '').toLowerCase();
}

function extractJsonLdProducts(html, pageUrl) {
  const products = [];
  for (const parsed of parseJsonLdScripts(html)) {
    for (const node of flattenJsonLdNodes(parsed)) {
      if (!getJsonLdType(node).includes('product')) continue;
      const rawImages = Array.isArray(node.image) ? node.image : [node.image];
      const images = rawImages
        .map(image => typeof image === 'string' ? image : image?.url)
        .map(image => resolvePageUrl(pageUrl, image))
        .filter(Boolean);
      const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      const price = offers?.price || offers?.lowPrice || offers?.highPrice || node.price;
      const availability = String(offers?.availability || '').split('/').pop();
      products.push({
        url: resolvePageUrl(pageUrl, node.url || offers?.url || pageUrl),
        title: stripHtml(node.name || ''),
        description: stripHtml(node.description || ''),
        price: price ? formatCurrencyBRL(price) : '',
        stock: availability || null,
        variations: [],
        images: [...new Set(images)].slice(0, 5)
      });
    }
  }
  return products.filter(product => product.title || product.images.length);
}

function stripHtml(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' '));
}

function htmlToReadableText(html) {
  return stripHtml(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|section|article|tr)>/gi, '\n'))
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function getRelevantSiteSnippets(text, message, maxSnippets = 8) {
  const cleanText = String(text || '').replace(/\r/g, '\n');
  const paragraphs = cleanText
    .split(/\n{1,}|\.\s+/)
    .map(item => item.replace(/\s+/g, ' ').trim())
    .filter(item => item.length >= 20 && item.length <= 600);
  const messageTokens = getSpecificProductTokens(getSearchTokens(message));
  const intentTokens = getSearchTokens([
    message,
    'endereco localizacao contato telefone whatsapp instagram como comprar pagamento pix cartao entrega frete retirada troca devolucao horario funcionamento'
  ].join(' '));
  const scored = paragraphs.map(paragraph => {
    const haystack = normalizeSearchText(paragraph);
    const score = countTokenMatches(haystack, [...new Set([...messageTokens, ...intentTokens])]);
    const strongSignal = /(endere[cç]o|localiza[cç][aã]o|telefone|whatsapp|instagram|contato|comprar|pagamento|pix|cart[aã]o|entrega|frete|retirada|troca|devolu[cç][aã]o|hor[aá]rio|funcionamento)/i.test(paragraph) ? 3 : 0;
    return { paragraph, score: score + strongSignal };
  });
  const selected = scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(item => item.paragraph);
  return [...new Set(selected)].slice(0, maxSnippets);
}

function extractSiteInfoFromHtml(html, url, message) {
  const title = getTitleFromHtml(html);
  const description = getMetaContent(html, 'og:description') || getMetaContent(html, 'description');
  const text = htmlToReadableText(html);
  const snippets = getRelevantSiteSnippets(text, message);
  const fallback = snippets.length > 0 ? snippets : text.split(/\n+/).map(item => item.trim()).filter(item => item.length >= 30).slice(0, 6);
  return {
    url,
    title,
    description,
    snippets: fallback.map(item => truncateText(item, 500)).slice(0, 8)
  };
}

function flattenJsonText(value, depth = 0) {
  if (value === null || value === undefined || depth > 4) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value).trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) return value.flatMap(item => flattenJsonText(item, depth + 1));
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => {
      const values = flattenJsonText(item, depth + 1);
      if (values.length === 0) return [];
      return values.map(text => `${key}: ${text}`);
    });
  }
  return [];
}

function getOperationalJsonSnippets(value, message, source = {}) {
  const lines = flattenJsonText(value)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const pedido = extractOrderReference(message);
  const phone = String(message || '').match(/\b\d{10,13}\b/)?.[0] || '';
  const needles = [pedido, phone, phone ? phone.slice(-8) : ''].filter(Boolean);
  const matchingLines = needles.length > 0
    ? lines.filter(line => needles.some(needle => normalizeSearchText(line).includes(normalizeSearchText(needle))))
    : [];

  if (pedido && source.endpointKey === 'orders_path' && matchingLines.length === 0) {
    return [`A API retornou JSON para consulta de pedidos, mas o numero ${pedido} nao apareceu nos campos retornados por este endpoint.`];
  }

  const criticalStatusLines = lines.filter(line => /(^(id|codigo|total):|cliente: nome|cliente: whatsapp|cliente: whatsapp_e164|forma_entrega: nome|status_pedido|status_pago|status_em_separacao|status_separado|status_despachado|status_entregue|rastreio|codigo_rastreio|pagamentos: status)/i.test(line));
  const statusLines = lines.filter(line => /(pedido|codigo|cliente|whatsapp|telefone|status|pago|separacao|separado|despachado|entregue|rastreio|frete|entrega|total|pagamento|observacoes)/i.test(line));
  const selected = matchingLines.length > 0
    ? [...matchingLines, ...criticalStatusLines, ...statusLines]
    : criticalStatusLines.length > 0
      ? [...criticalStatusLines, ...statusLines]
      : statusLines.length > 0
        ? statusLines
      : lines;

  return [...new Set(selected)]
    .map(line => truncateText(line, 500))
    .slice(0, source.operational ? 40 : 12);
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getSearchTokens(value) {
  return normalizeSearchText(value)
    .split(' ')
    .filter(token => token.length >= 3 && ![
      'produto',
      'produtos',
      'preco',
      'valor',
      'foto',
      'fotos',
      'imagem',
      'imagens',
      'cade',
      'cad',
      'onde',
      'esta',
      'estao',
      'ficou',
      'faltou',
      'ainda',
      'tiver',
      'tiverem',
      'pode',
      'poderia',
      'quais',
      'qual',
      'site',
      'loja',
      'quero',
      'manda',
      'mande',
      'mandar',
      'envia',
      'envie',
      'enviar',
      'desses',
      'desse',
      'dessa',
      'aqui',
      'favor',
      'por',
      'dos',
      'das',
      'nos',
      'nas',
      'disponivel',
      'disponiveis',
      'tamanho',
      'tamanhos',
      'real',
      'reais',
      'tem',
      'voce',
      'voces',
      'voc',
      'para',
      'com',
      'que',
      'ano',
      'anos',
      'idade',
      'crianca',
      'criancas',
      'criança',
      'crianças',
      'nao',
      'não',
      'pedi',
      'pra',
      'pro',
      'olha',
      'olhar',
      'direito',
      'porque',
      'aviso',
      'avisos',
      'pedido',
      'pedidos',
      'minimo',
      'mínimo',
      'catalogo',
      'catálogo',
      'configurado',
      'mais',
      'outra',
      'outras',
      'outro',
      'outros',
      'nova',
      'novas',
      'novo',
      'novos',
      'diferente',
      'diferentes',
      'opcao',
      'opcoes',
      'modelo',
      'modelos',
      'quantas',
      'quantos',
      'quanta',
      'quanto',
      'estoque',
      'peca',
      'pecas',
      'disponivel',
      'disponiveis'
    ].includes(token))
    .filter(token => !/^\d+$/.test(token));
}

function isShortContextualReply(message = '') {
  const text = normalizeSearchText(message);
  if (!text) return false;
  return /^(pode|pode sim|pode ser|quero|quero sim|sim|sim quero|manda|manda sim|pode procurar|ok|okay|isso|1|2|3|4|5|primeiro|primeira|segundo|segunda|terceiro|terceira|quarto|quarta|quinto|quinta|esse|essa|desse|dessa)$/i.test(text);
}

function isPendingActionConfirmation(message = '') {
  const text = normalizeSearchText(message);
  return /^(pode|pode sim|pode ser|quero|quero sim|sim|sim quero|manda|manda sim|pode procurar|quero ver|ok|okay|isso)$/i.test(text);
}

function getMinimumOrderPolicyQuery(message = '') {
  const text = normalizeSearchText(message);
  if (!text) return '';
  if (/\b(pedido minimo|compra minima|minimo|valor minimo|fecha o minimo)\b/i.test(text)) return 'pedido mínimo compra mínima quantidade mínima';
  if (/\b(deixam passar|posso comprar menos|quantas pecas minimo)\b/i.test(text)) return 'pedido mínimo compra mínima quantidade mínima';
  if (/\bso\s+\d+\s+pecas?\b/i.test(text)) return 'pedido mínimo compra mínima quantidade mínima';
  if (/\bmenos de\s+\d+\b/i.test(text)) return 'pedido mínimo compra mínima quantidade mínima';
  if (/\bposso comprar\s+\d+\b/i.test(text)) return 'pedido mínimo compra mínima quantidade mínima';
  return '';
}

function getStorePolicyKnowledgeQuery(message = '') {
  const text = normalizeSearchText(message);
  if (!text) return '';
  const minimumOrderQuery = getMinimumOrderPolicyQuery(message);
  if (minimumOrderQuery) return minimumOrderQuery;
  if (/\bcnpj\b/i.test(text)) return 'cnpj';
  if (/\bcpf\b|pessoa fisica|pessoa física/i.test(text)) return 'cpf pessoa fisica';
  if (/precisa ter cadastro|tem que ter cadastro|cadastro/i.test(text)) return 'cadastro';
  if (/precisa ter loja|tem que ter loja|loja para comprar/i.test(text)) return 'loja para comprar';
  if (/pedido minimo|minimo de pecas|mínimo de peças|valor minimo|compra minima/i.test(text)) return 'pedido minimo';
  if (/como comprar|comprar com voces|comprar com vocês/i.test(text)) return 'como comprar';
  if (/\bpagamento\b|\bpagar\b|\bpago\b|\bpix\b|\bcartao\b|\bcartão\b|\bboleto\b|formas? de pagamento|como pago/i.test(text)) return 'pagamento';
  if (/\b(excursao|ponto de encontro|local de retirada)\b/i.test(text) && /\b(entrega|entregam|enviar|enviam|enviamos|envio|retirada|retirar|buscar)\b/i.test(text)) return 'entrega retirada localizacao';
  if (/\bentrega\b|\bentregam\b|\bfrete\b|\benviar\b|\benviam\b|\benviamos\b|\benvio\b|\bmotoboy\b|\btodo brasil\b|\bbrasil todo\b/i.test(text)) return 'entrega frete';
  if (/\bendereco\b|\bendereço\b|onde fica|localizacao|localização/i.test(text)) return 'endereco';
  if (/\btroca\b|\bdevolucao\b|\bdevolução\b/i.test(text)) return text.includes('devolu') ? 'devolucao' : 'troca';
  if (/\bretirada\b|\bretirar\b|\bpessoalmente\b|buscar ai|posso retirar|retirar no estoque|endereco retirada|manda o endereco pra retirar/i.test(text)) return 'retirada endereco';
  if (/\bhorario\b|\bhorário\b|funcionamento/i.test(text)) return 'horario';
  return '';
}

function getRelatedThemeLabel(value = '', customerIntent = {}) {
  const explicitTheme = normalizeSearchText(customerIntent.theme || customerIntent.entities?.theme || '');
  if (explicitTheme) return explicitTheme;
  const text = normalizeSearchText(value);
  const themeTokens = ['tema', 'personagem', 'personagens', 'marca', 'estampa', 'licenciado', 'licenciada']
    .filter(token => text.includes(token));
  return themeTokens[0] || '';
}

function buildRelatedSemanticQuery(originalQuery = '', customerIntent = {}) {
  const theme = getRelatedThemeLabel([originalQuery, customerIntent.theme || '', customerIntent.semantic_query || ''].join(' '), customerIntent);
  const productType = normalizeSearchText(customerIntent.product_type || customerIntent.entities?.product || customerIntent.search_query || originalQuery)
    .split(' ')
    .filter(token => token && !['tem', 'quero', 'procuro', 'precisa', 'comprar'].includes(token))
    .slice(0, 4)
    .join(' ');
  if (theme) return `produto relacionado ao tema ${theme}`;
  return productType || normalizeSearchText(originalQuery);
}

function buildRelatedProductsNote(originalQuery = '', customerIntent = {}) {
  const requested = normalizeSearchText(originalQuery).replace(/\b(tem|quero|procuro|mostra|manda)\b/g, '').replace(/\s+/g, ' ').trim() || 'esse modelo';
  const theme = getRelatedThemeLabel(originalQuery, customerIntent);
  return `Nao encontrei exatamente ${requested}, mas encontrei opcoes relacionadas${theme ? ' ao tema ' + theme : ''} 😊`;
}

function getSpecificProductTokens(tokens) {
  const generic = new Set([
    'roupa',
    'roupas',
    'criança',
    'crianças',
    'ano',
    'anos',
    'idade',
    'adulto',
    'adultos',
    'masculino',
    'masculinos',
    'feminino',
    'femininos',
    'modelo',
    'peca',
    'pecas',
    'quantas',
    'quantos',
    'quanta',
    'quanto',
    'estoque',
    'disponivel',
    'disponiveis',
    'tem',
    'vende',
    'vender',
    'vendem',
    'vendendo',
    'comprar',
    'compra',
    'compras',
    'quero',
    'queria',
    'procuro',
    'preciso',
    'opcao',
    'opcoes'
  ]);
  return tokens.filter(token => !generic.has(token));
}

const PRODUCT_COLOR_TOKENS = [
    'amarelo',
    'azul',
    'bege',
    'branco',
    'cinza',
    'dourado',
    'grafite',
    'laranja',
    'lilas',
    'marrom',
    'preto',
    'rosa',
    'roxo',
    'verde',
    'vermelho',
    'vinho'
];

function getColorTokens(tokens) {
  const colors = new Set(PRODUCT_COLOR_TOKENS);
  return tokens.filter(token => colors.has(token));
}

function getTitleColorTokens(title) {
  return PRODUCT_COLOR_TOKENS.filter(color => includesToken(title, color));
}

function normalizeSizeToken(value) {
  const clean = normalizeSearchText(value);
  if (!clean) return '';
  if (/^\d{1,2}$/.test(clean)) {
    const number = Number(clean);
    if (number >= 0 && number <= 18) return String(number);
  }
  const letterMap = {
    pp: 'pp',
    p: 'p',
    m: 'm',
    g: 'g',
    gg: 'gg',
    xg: 'xg',
    xgg: 'xgg'
  };
  return letterMap[clean] || '';
}

function extractRequestedSizes(message) {
  const raw = String(message || '');
  const normalized = normalizeSearchText(raw);
  const sizes = new Set();
  const patterns = [
    /\b(?:tamanho|tamanhos|tam|numero|n)\s*(\d{1,2}|pp|p|m|g|gg|xg|xgg)\b/gi,
    /\b(\d{1,2})\s*(?:anos|ano|idade)\b/gi,
    /\b(?:idade|anos?)\s*(?:de|com|para)?\s*(\d{1,2})\b/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(normalized))) {
      const size = normalizeSizeToken(match[1]);
      if (size) sizes.add(size);
    }
  }

  return [...sizes];
}

function extractProductSizes(product = {}) {
  const sizes = new Set();
  const variations = Array.isArray(product.variations) ? product.variations : [];
  const variationText = normalizeSearchText(variations.join(' '));
  for (const match of variationText.matchAll(/\b(\d{1,2}|pp|p|m|g|gg|xg|xgg)\b/gi)) {
    const size = normalizeSizeToken(match[1]);
    if (size) sizes.add(size);
  }

  const text = normalizeSearchText([
    product.title,
    product.description,
    product.category,
    product.categoryName,
    product.categoria_nome,
    variations.join(' ')
  ].join(' '));
  const patterns = [
    /\b(?:tamanho|tamanhos|tam|numero|n)\s*(\d{1,2}|pp|p|m|g|gg|xg|xgg)\b/gi,
    /\b(\d{1,2})\s*(?:anos|ano)\b/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const size = normalizeSizeToken(match[1]);
      if (size) sizes.add(size);
    }
  }

  return [...sizes];
}

function productMatchesRequestedSize(product, requestedSizes) {
  if (!requestedSizes.length) return true;
  const sizes = product._sizes || extractProductSizes(product);
  if (!sizes.length) return false;
  return requestedSizes.some(size => sizes.includes(size));
}

function getTokenVariants(token) {
  const variants = [token];
  if (token.endsWith('s') && token.length > 4) variants.push(token.slice(0, -1));
  if (!token.endsWith('s') && token.length > 3) variants.push(token + 's');
  if (token === 'calca') variants.push('calcas');
  if (token === 'calcas') variants.push('calca');
  if (token === 'macacao') variants.push('macacoes');
  if (token === 'macacoes') variants.push('macacao');
  if (token === 'tshirt') variants.push('tshirts', 't shirt');
  if (token === 'cropped') variants.push('croppeds', 'croped');
  if (token === 'croped') variants.push('cropeds', 'cropped');
  if (token === 'moletom') variants.push('moletons', 'moleton', 'moletons');
  if (token === 'moletons') variants.push('moletom', 'moleton', 'moletons');
  if (token === 'moleton') variants.push('moletons', 'moletom', 'moletons');
  if (token === 'moletons') variants.push('moleton', 'moletom', 'moletons');
  return [...new Set(variants)];
}

function includesToken(haystack, token) {
  return getTokenVariants(token).some(variant => haystack.includes(variant));
}

function countTokenMatches(haystack, tokens) {
  return tokens.reduce((total, token) => total + (includesToken(haystack, token) ? 1 : 0), 0);
}

function formatCurrencyBRL(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return 'R$ ' + number.toFixed(2).replace('.', ',');
}

function getFacilZapImageUrl(image) {
  if (!image) return '';
  const value = String(image).replace(/\\\//g, '/');
  if (/^https?:\/\//i.test(value)) return value;
  return 'https://arquivos.facilzap.app.br/' + value.replace(/^\/+/, '');
}

function getFacilZapPublicProductUrl(product, sourceUrl = '', fallbackUrl = '') {
  const productId = firstValue(product?.id, product?.produto_id, product?.codigo, '');

  // Padrão preferencial: publicCatalogUrl#produto{id}
  // sourceUrl deve ser o publicCatalogUrl limpo (sem /{PATH}), passado por
  // normalizeFacilZapProduct e extractGenericJsonProducts
  const publicBase = String(sourceUrl || '').trim();
  if (productId && publicBase && !/api\.facilzap/i.test(publicBase)) {
    // Verifica se é uma URL pública real (não endpoint de API)
    try {
      const parsed = new URL(publicBase);
      if (!/api\./i.test(parsed.hostname)) {
        return `${publicBase.replace(/\/$/, '')}#produto${productId}`;
      }
    } catch (error) {
      // continua para fallback abaixo
    }
  }

  // Campo explícito no produto, não-API — usar diretamente
  const explicitUrl = firstValue(
    product?.url,
    product?.link,
    product?.permalink,
    product?.product_url,
    product?.link_produto,
    product?.url_produto,
    product?.catalog_url,
    product?.catalogo_url,
    ''
  );
  if (explicitUrl && !/api\.facilzap/i.test(String(explicitUrl))) {
    return resolvePageUrl(sourceUrl || fallbackUrl, explicitUrl);
  }

  // Sem publicCatalogUrl configurado e sem URL explícita no produto:
  // retorna vazio para que baileysService não exiba botão "Ver produto"
  return '';
}

function getFacilZapPrice(product) {
  function validPrice(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(',', '.').replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  // Campos diretos
  const direct = validPrice(product?.precos_produto?.promocional)
    ?? validPrice(product?.precos_produto?.preco_a_partir?.preco)
    ?? validPrice(product?.precos_produto?.preco_minimo)
    ?? validPrice(product?.precos_produto?.padrao)
    ?? validPrice(product?.preco_promocional)
    ?? validPrice(product?.preco_venda)
    ?? validPrice(product?.valor_venda)
    ?? validPrice(product?.sale_price)
    ?? validPrice(product?.price)
    ?? validPrice(product?.preco)
    ?? validPrice(product?.valor);
  if (direct !== null) return direct;
  // FácilZap: preço dentro de catalogos[].precos
  const cats = product?.catalogos;
  if (cats && typeof cats === 'object') {
    const catArr = Array.isArray(cats) ? cats : Object.values(cats);
    for (const cat of catArr) {
      if (!cat || typeof cat !== 'object') continue;
      const n = validPrice(cat.precos?.preco)
        ?? validPrice(cat.precos?.promocional)
        ?? validPrice(cat.precos?.preco_promocional)
        ?? validPrice(cat.precos?.preco_venda);
      if (n !== null) return n;
    }
  }
  // Fallback: variacoes
  const variacoes = product?.variacoes;
  if (variacoes && typeof variacoes === 'object') {
    const entries = Array.isArray(variacoes) ? variacoes : Object.values(variacoes);
    for (const v of entries) {
      if (!v || typeof v !== 'object') continue;
      const n = validPrice(v.preco) ?? validPrice(v.valor) ?? validPrice(v.price);
      if (n !== null) return n;
    }
  }
  return null;
}

function getFacilZapVariations(product) {
  const variations = product?.variacoes && typeof product.variacoes === 'object'
    ? Object.values(product.variacoes)
    : [];
  const values = [
    ...(Array.isArray(product.tamanhos) ? product.tamanhos : []),
    ...(Array.isArray(product.sizes) ? product.sizes : []),
    ...variations
  ];
  return values
    .flatMap(variation => {
      if (typeof variation === 'string' || typeof variation === 'number') return [String(variation)];
      return [
        variation?.nome,
        variation?.subgrupo,
        variation?.tamanho,
        variation?.size,
        variation?.valor,
        variation?.label
      ].filter(Boolean);
    })
    .filter(Boolean)
    .slice(0, 12);
}

function getFacilZapCatalogBase(html, pageUrl) {
  return html.match(/const\s+baseUrlCatalogo\s*=\s*`([^`]+)`/i)?.[1]
    || html.match(/const\s+baseUrlCatalogo\s*=\s*['"]([^'"]+)['"]/i)?.[1]
    || new URL('/c/varejo/{PATH}', pageUrl).toString();
}

function getFacilZapProductListEndpoint(html) {
  return html.match(/const\s+urlCarregarProdutos\s*=\s*`([^`]+)`/i)?.[1]
    || html.match(/const\s+urlCarregarProdutos\s*=\s*['"]([^'"]+)['"]/i)?.[1]
    || '';
}

function getFacilZapProductsPageUrl(pageUrl, html = '') {
  const catalogBase = html.match(/const\s+baseUrlCatalogo\s*=\s*`([^`]+)`/i)?.[1]
    || html.match(/const\s+baseUrlCatalogo\s*=\s*['"]([^'"]+)['"]/i)?.[1]
    || '';
  if (catalogBase && catalogBase.includes('{PATH}')) {
    return catalogBase.replace('{PATH}', 'produtos');
  }

  const actionUrl = html.match(/<form[^>]+action=["']([^"']+\/c\/[^"']+\/\d+)["']/i)?.[1]
    || html.match(/https?:\/\/[^"'\s]+\/c\/[^"'\s]+\/\d+/i)?.[0]
    || '';
  if (actionUrl) {
    try {
      const url = new URL(actionUrl, pageUrl);
      const match = url.pathname.match(/^\/c\/([^/]+)\/(\d+)/);
      if (match) return `${url.origin}/c/${match[1]}/produtos/${match[2]}`;
    } catch (error) {
      // Keep the URL-path fallback below.
    }
  }

  try {
    const url = new URL(pageUrl);
    const match = url.pathname.match(/^\/c\/([^/]+)\/(\d+)/);
    if (!match) return '';
    return `${url.origin}/c/${match[1]}/produtos/${match[2]}`;
  } catch (error) {
    return '';
  }
}

function getFacilZapSectionsEndpoint(html) {
  return html.match(/const\s+urlCarregarSecoesProdutos\s*=\s*`([^`]+)`/i)?.[1]
    || html.match(/const\s+urlCarregarSecoesProdutos\s*=\s*['"]([^'"]+)['"]/i)?.[1]
    || '';
}

function parseFacilZapCategories(html) {
  const categoryMatch = html.match(/const\s+categoriasAtivasCatalogo\s*=\s*(\[[\s\S]*?\]);/i);
  if (!categoryMatch?.[1]) return [];
  try {
    return JSON.parse(categoryMatch[1]);
  } catch (error) {
    return [];
  }
}

function getFacilZapMatchingCategoryIds(categories, messageTokens) {
  return categories
    .filter(category => getProductScore({ title: category.nome, category: category.nome }, messageTokens) > 0)
    .map(category => String(category.id))
    .slice(0, 4);
}

function normalizeFacilZapProduct(product, catalogBase) {
  const images = [
    ...(Array.isArray(product.imagens) ? product.imagens : []),
    ...(product.imagens_variacoes && typeof product.imagens_variacoes === 'object' ? Object.values(product.imagens_variacoes).flat() : [])
  ].map(getFacilZapImageUrl).filter(Boolean);
  const price = getFacilZapPrice(product);
  const variations = getFacilZapVariations(product);
  const variationStocks = getVariationStockEntries(product.variacoes);
  // publicCatalogUrl: URL base pública sem {PATH}, usada para montar o link #produto{id}
  const publicCatalogUrl = String(catalogBase || '').replace(/\/\{PATH\}.*$/, '').replace(/\/$/, '');
  return {
    id: product.id,
    url: getFacilZapPublicProductUrl(product, publicCatalogUrl, String(catalogBase).replace('{PATH}', 'produto/' + product.id)),
    title: product.nome || 'Produto',
    description: stripHtml(product.descricao || ''),
    price: price ? formatCurrencyBRL(price) : '',
    stock: Number.isFinite(Number(product.total_estoque)) ? Number(product.total_estoque) : null,
    category: product.categoria_nome || product.categoria || '',
    categoryName: product.categoria_nome || '',
    variations,
    variationStocks,
    images: [...new Set(images)].slice(0, 5),
    score: 0
  };
}

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null && String(value).trim() !== '');
}

function getNestedStockValue(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'object') {
    return firstValue(value.estoque, value.stock, value.quantity, value.quantidade, value.disponivel, value.available, value.qtd, null);
  }
  return null;
}

function getStockNumber(value) {
  const raw = getNestedStockValue(value);
  if (raw === null || raw === undefined || raw === '') return null;
  const normalized = String(raw).replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function getVariationStockEntries(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'object'
      ? Object.values(value)
      : [value];
  return entries
    .flatMap(entry => {
      if (entry === undefined || entry === null || entry === '') return [];
      if (typeof entry === 'string' || typeof entry === 'number') {
        return [{ label: String(entry), stock: null }];
      }
      if (typeof entry !== 'object') return [];
      const label = firstValue(
        entry.nome,
        entry.name,
        entry.label,
        entry.valor,
        entry.value,
        entry.tamanho,
        entry.size,
        entry.cor,
        entry.color,
        entry.subgrupo
      );
      const stock = getStockNumber(firstValue(
        entry.estoque,
        entry.stock,
        entry.total_estoque,
        entry.quantity,
        entry.quantidade,
        entry.disponivel,
        entry.available,
        entry.qtd,
        null
      ));
      return [{ label: label ? String(label) : '', stock }];
    })
    .filter(entry => entry.label || entry.stock !== null);
}

function getProductVariationStockEntries(product = {}) {
  const entries = [
    ...(Array.isArray(product.variationStocks) ? product.variationStocks : []),
    ...(Array.isArray(product._variationStocks) ? product._variationStocks : [])
  ];
  const seen = new Set();
  return entries
    .map(entry => ({
      label: String(entry?.label || entry?.name || entry?.nome || '').trim(),
      stock: getStockNumber(firstValue(entry?.stock, entry?.estoque, entry?.quantity, entry?.quantidade, null))
    }))
    .filter(entry => entry.label || entry.stock !== null)
    .filter(entry => {
      const key = normalizeSearchText(`${entry.label}|${entry.stock ?? ''}`);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getProductAvailableStock(product = {}) {
  const variationEntries = getProductVariationStockEntries(product);
  const positiveVariationStock = variationEntries.reduce((sum, entry) => {
    const stock = Number(entry.stock);
    return Number.isFinite(stock) && stock > 0 ? sum + stock : sum;
  }, 0);
  if (positiveVariationStock > 0) return positiveVariationStock;
  return getStockNumber(firstValue(product.stock, product.estoque, product.total_estoque, product.quantity, null));
}

function hasPositiveProductStock(product = {}) {
  const stock = getProductAvailableStock(product);
  return Number.isFinite(Number(stock)) && Number(stock) > 0;
}

function productIsRecommendableForRequest(product = {}, requestedSizes = []) {
  if (!hasPositiveProductStock(product)) return false;
  if (!requestedSizes.length) return true;
  if (productMatchesRequestedSizeWithStock(product, requestedSizes)) return true;
  const entries = getProductVariationStockEntries(product);
  if (entries.length > 0) return false;
  return productMatchesRequestedSize(product, requestedSizes);
}

function getAvailableProductSizes(product = {}) {
  const sizes = new Set();
  for (const entry of getProductVariationStockEntries(product)) {
    if (!(Number(entry.stock) > 0)) continue;
    for (const match of normalizeSearchText(entry.label).matchAll(/\b(\d{1,2}|pp|p|m|g|gg|xg|xgg)\b/gi)) {
      const size = normalizeSizeToken(match[1]);
      if (size) sizes.add(size);
    }
  }
  return [...sizes];
}

function getAvailableProductVariationLabels(product = {}) {
  const knownSizes = Array.isArray(product?._sizes) ? product._sizes : extractProductSizes(product);
  const seen = new Set();
  return getProductVariationStockEntries(product)
    .filter(entry => Number(entry.stock) > 0)
    .map(entry => stripSizeFromVariation(entry.label, knownSizes))
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .filter(value => {
      const key = normalizeSearchText(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

function productMatchesRequestedSizeWithStock(product = {}, requestedSizes = []) {
  if (!requestedSizes.length) return true;
  const entries = getProductVariationStockEntries(product);
  return entries.some(entry => {
    if (!(Number(entry.stock) > 0)) return false;
    const label = normalizeSearchText(entry.label);
    return requestedSizes.some(size => new RegExp(`\\b${size}\\b`, 'i').test(label));
  });
}

function collectImageValues(value, pageUrl) {
  const images = [];
  const isFacilZapSource = /facilzap/i.test(String(pageUrl || ''));
  const visit = (item) => {
    if (!item) return;
    if (typeof item === 'string') {
      const resolved = isFacilZapSource ? getFacilZapImageUrl(item) : resolvePageUrl(pageUrl, item);
      if (resolved && (isFacilZapSource || /\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(resolved))) images.push(resolved);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item !== 'object') return;
    visit(item.url || item.src || item.path || item.image || item.imagem);
  };
  visit(value);
  return images.filter(Boolean);
}

function extractGenericJsonProducts(data, sourceUrl, source = {}) {
  const products = [];
  const visit = (value, depth = 0) => {
    if (!value || depth > 6) return;
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;

    const title = firstValue(value.nome, value.name, value.title, value.titulo, value.product_name, value.descricao_curta);
    const imageFields = [
      value.imagens,
      value.images,
      value.fotos,
      value.photos,
      value.image,
      value.imagem,
      value.thumbnail,
      value.photo,
      value.picture
    ];
    const images = [...new Set(imageFields.flatMap(item => collectImageValues(item, sourceUrl)))].slice(0, 5);
    const hasProductSignal = title && (
      images.length > 0
      || value.preco !== undefined
      || value.price !== undefined
      || value.valor !== undefined
      || value.sku !== undefined
      || value.id !== undefined
      || value.estoque !== undefined
      || value.stock !== undefined
    );

    if (hasProductSignal) {
      const price = (function extractPrice(v) {
        function vp(x) {
          if (x === null || x === undefined || x === '') return null;
          const n = Number(String(x).replace(',', '.').replace(/[^\d.-]/g, ''));
          return Number.isFinite(n) && n > 0 ? n : null;
        }
        const directCandidates = [
          v.precos_produto?.promocional,
          v.precos_produto?.preco_a_partir?.preco,
          v.precos_produto?.preco_minimo,
          v.precos_produto?.padrao,
          v.preco_promocional,
          v.preco_venda,
          v.valor_venda,
          v.sale_price,
          v.price,
          v.preco,
          v.valor
        ];
        for (const c of directCandidates) {
          const n = vp(c);
          if (n !== null) return n;
        }
        // FácilZap: preço dentro de catalogos[].precos
        const cats = v.catalogos;
        if (cats && typeof cats === 'object') {
          const catArr = Array.isArray(cats) ? cats : Object.values(cats);
          for (const cat of catArr) {
            if (!cat || typeof cat !== 'object') continue;
            const n = vp(cat.precos?.preco)
              ?? vp(cat.precos?.promocional)
              ?? vp(cat.precos?.preco_promocional)
              ?? vp(cat.precos?.preco_venda);
            if (n !== null) return n;
          }
        }
        // Fallback: variacoes
        const variacoes = v.variacoes || v.variations;
        if (variacoes && typeof variacoes === 'object') {
          const entries = Array.isArray(variacoes) ? variacoes : Object.values(variacoes);
          for (const entry of entries) {
            if (!entry || typeof entry !== 'object') continue;
            const n = vp(entry.preco) ?? vp(entry.valor) ?? vp(entry.price);
            if (n !== null) return n;
          }
        }
        return null;
      })(value);
      const isFacilZapSource = /facilzap/i.test(String(sourceUrl || ''));
      const rawUrl = firstValue(value.url, value.link, value.permalink, value.product_url, value.link_produto, value.url_produto, sourceUrl);
      const url = isFacilZapSource
        ? getFacilZapPublicProductUrl(value, source.publicCatalogUrl || '', resolvePageUrl(source.publicCatalogUrl || '', rawUrl))
        : resolvePageUrl(sourceUrl, rawUrl);
      const variations = [
        value.variacoes,
        value.variations,
        value.tamanhos,
        value.sizes,
        value.cores,
        value.colors
      ].flatMap(item => {
        if (!item) return [];
        if (Array.isArray(item)) return item.map(entry => (typeof entry === 'string' || typeof entry === 'number') ? String(entry) : firstValue(entry.nome, entry.name, entry.label, entry.valor, entry.value, entry.tamanho, entry.size));
        if (typeof item === 'object') return Object.values(item).map(entry => (typeof entry === 'string' || typeof entry === 'number') ? String(entry) : firstValue(entry.nome, entry.name, entry.label, entry.valor, entry.value, entry.tamanho, entry.size));
        return [String(item)];
      }).filter(Boolean).slice(0, 8);
      const variationStocks = [
        value.variacoes,
        value.variations,
        value.tamanhos,
        value.sizes
      ].flatMap(getVariationStockEntries);

      products.push({
        id: firstValue(value.id, value.sku, value.codigo, url, title),
        url,
        title: stripHtml(title),
        description: stripHtml(firstValue(value.descricao, value.description, value.details, value.resumo, '')),
        price: price ? (/^R\$/i.test(String(price)) ? String(price) : formatCurrencyBRL(price)) : '',
        stock: getNestedStockValue(firstValue(value.estoque, value.stock, value.total_estoque, value.quantity, null)),
        category: firstValue(value.categoria, value.category, value.categoria_nome, value.category_name, ''),
        categoryName: firstValue(value.categoria_nome, value.category_name, value.categoria, value.category, ''),
        variations,
        variationStocks,
        images,
        score: 0
      });
      return;
    }

    Object.values(value).forEach(item => visit(item, depth + 1));
  };

  visit(data);
  return dedupeProducts(products);
}

function getProductScore(product, messageTokens) {
  if (!messageTokens.length) return 0;
  const haystack = normalizeSearchText([
    product.title,
    product.description,
    product.category,
    product.categoryName,
    product.categoria_nome,
    product.variations?.join(' ')
  ].join(' '));
  let score = messageTokens.reduce((total, token) => total + (includesToken(haystack, token) ? 1 : 0), 0);
  const title = normalizeSearchText(product.title || '');
  const description = normalizeSearchText(product.description || '');
  for (const token of messageTokens) {
    if (includesToken(title, token)) score += 3;
    if (includesToken(description, token)) score += 1;
  }
  return score;
}

function hasNegativeProductMatch(product, tokens = []) {
  const haystack = normalizeSearchText([
    product.title,
    product.description
  ].join(' '));
  return tokens.some(token => new RegExp(`\\b(?:nao|sem|acompanha|acompanham|acompanhar)\\b.{0,40}\\b${token}\\b|\\b${token}\\b.{0,40}\\b(?:nao|sem|acompanha|acompanham|acompanhar)\\b`, 'i').test(haystack));
}

function isPreviouslyShownProduct(product, excludedTitleKeys = []) {
  if (!excludedTitleKeys.length) return false;
  const title = normalizeSearchText(product?.title || '');
  if (!title) return false;
  return excludedTitleKeys.some(key => key && (title === key || title.includes(key) || key.includes(title)));
}

function preferNotPreviouslyShown(products = [], excludedTitleKeys = []) {
  if (!excludedTitleKeys.length || products.length <= 1) return products;
  const fresh = products.filter(product => !isPreviouslyShownProduct(product, excludedTitleKeys));
  return fresh.length > 0 ? fresh : products;
}

function getRelevantProducts(products, message, options = {}) {
  const messageTokens = getSearchTokens(message);
  const specificTokens = getSpecificProductTokens(messageTokens);
  const colorTokens = getColorTokens(messageTokens);
  const requestedSizes = extractRequestedSizes(message);
  const excludedTitleKeys = Array.isArray(options.excludeTitles)
    ? options.excludeTitles.map(normalizeSearchText).filter(Boolean)
    : [];
  const ragHintTitleKeys = Array.isArray(options.vectorProductHints)
    ? options.vectorProductHints.map(hint => normalizeSearchText(hint?.title || hint?.titleKey || '')).filter(Boolean)
    : [];
  const uniqueProducts = dedupeProducts(products)
    .map(product => {
      const title = normalizeSearchText(product.title || '');
      const titleColors = getTitleColorTokens(title);
      const titleAndVariations = normalizeSearchText([
        product.title,
        product.category,
        product.categoryName,
        product.categoria_nome,
        product.variations?.join(' ')
      ].join(' '));
      const haystack = normalizeSearchText([
        product.title,
        product.description,
        product.category,
        product.categoryName,
        product.categoria_nome,
        product.variations?.join(' ')
      ].join(' '));
      const availableStock = getProductAvailableStock(product);
      const hasStock = Number(availableStock) > 0;
      const hasRequestedSizeInStock = requestedSizes.length > 0 && productMatchesRequestedSizeWithStock(product, requestedSizes);
      return {
        ...product,
        score: getProductScore(product, messageTokens)
          + (product.sourceType && product.sourceType !== 'link' ? 2 : 0)
          + (hasStock ? 4 : 0)
          + (hasRequestedSizeInStock ? 8 : 0),
        _sizes: extractProductSizes(product),
        _availableStock: availableStock,
        _hasStock: hasStock,
        _isRecommendable: productIsRecommendableForRequest(product, requestedSizes),
        _hasRequestedSizeInStock: hasRequestedSizeInStock,
        _wasPreviouslyShown: isPreviouslyShownProduct(product, excludedTitleKeys),
        _ragHintMatched: ragHintTitleKeys.includes(title),
        _titleMatches: countTokenMatches(title, messageTokens),
        _specificMatches: countTokenMatches(haystack, specificTokens),
        _colorMatches: countTokenMatches(titleAndVariations, colorTokens),
        _hasConflictingTitleColor: colorTokens.length > 0 && titleColors.some(color => !colorTokens.includes(color))
      };
    })
    .filter(product => product._isRecommendable)
    .sort((a, b) => b.score - a.score);
  const hintedProducts = ragHintTitleKeys.length > 0
    ? uniqueProducts.filter(product => product._ragHintMatched).map(product => ({ ...product, score: product.score + 12 }))
    : [];
  const freshHintedProducts = hintedProducts.filter(product => !product._wasPreviouslyShown);
  const candidateProducts = hintedProducts.length > 0
    ? (freshHintedProducts.length > 0 ? freshHintedProducts : uniqueProducts)
    : uniqueProducts;
  if (hintedProducts.length > 0) {
    console.log('[RAG PRODUCT PREFILTER APPLY] hints=' + ragHintTitleKeys.length
      + ' matched=' + hintedProducts.length
      + ' fresh=' + freshHintedProducts.length
      + ' scope=' + (freshHintedProducts.length > 0 ? 'fresh_hints' : 'full_catalog'));
  }

  if (requestedSizes.length > 0) {
    const sizeMatched = candidateProducts
      .filter(product => productMatchesRequestedSize(product, requestedSizes))
      .map(product => ({ ...product, score: product.score + 8 }));
    if (sizeMatched.length === 0) return [];
    const sizeMatchedInStock = sizeMatched
      .filter(product => product._hasRequestedSizeInStock || productIsRecommendableForRequest(product, requestedSizes))
      .sort((a, b) => Number(b._hasRequestedSizeInStock) - Number(a._hasRequestedSizeInStock) || b.score - a.score);
    if (sizeMatchedInStock.length > 0 && (messageTokens.length === 0 || specificTokens.length === 0)) {
      return preferNotPreviouslyShown(sizeMatchedInStock, excludedTitleKeys).slice(0, 6);
    }
    if (messageTokens.length === 0 || specificTokens.length === 0) {
      return [];
    }
  }

  if (messageTokens.length === 0) {
    return preferNotPreviouslyShown(candidateProducts, excludedTitleKeys).slice(0, 6);
  }

  const minSpecificMatches = specificTokens.length >= 2 ? specificTokens.length : specificTokens.length;
  const bestScore = candidateProducts[0]?.score || 0;
  const matched = candidateProducts.filter(product => {
    if (product.score <= 0) return false;
    if (specificTokens.length > 0 && hasNegativeProductMatch(product, specificTokens)) return false;
    if (requestedSizes.length > 0 && !productIsRecommendableForRequest(product, requestedSizes)) return false;
    if (minSpecificMatches > 0 && product._specificMatches < minSpecificMatches) return false;
    if (colorTokens.length > 0 && product._colorMatches < colorTokens.length) return false;
    if (product._hasConflictingTitleColor) return false;
    if (bestScore >= 6 && product.score < Math.ceil(bestScore * 0.7)) return false;
    if (messageTokens.length >= 3 && product._titleMatches === 0 && product._specificMatches < 2) return false;
    return true;
  });
  if (matched.length > 0) {
    const titleOrCategoryMatched = matched.filter(product => product._titleMatches > 0 || countTokenMatches(normalizeSearchText([product.category, product.categoryName, product.categoria_nome].join(' ')), specificTokens) > 0);
    if (specificTokens.length > 0 && titleOrCategoryMatched.length > 0) {
      return preferNotPreviouslyShown(titleOrCategoryMatched, excludedTitleKeys).slice(0, 6);
    }
    return preferNotPreviouslyShown(matched, excludedTitleKeys).slice(0, 6);
  }
  return [];
}

function dedupeProducts(products) {
  const seen = new Set();
  return products.filter(product => {
    const key = String(product.id || product.url || product.title || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return decodeHtml(tag.match(new RegExp(`${escaped}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1] || '');
}

function extractPriceNearHtml(fragment) {
  const text = stripHtml(fragment);
  return text.match(/(?:R\$\s*)?\d{1,5}(?:[.,]\d{2})/i)?.[0] || '';
}

function extractTitleNearHtml(fragment, fallback = '') {
  const heading = fragment.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1]
    || fragment.match(/class=["'][^"']*(?:title|titulo|name|nome|product)[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1]
    || fallback;
  return stripHtml(heading).slice(0, 120);
}

function extractGenericHtmlProducts(html, pageUrl, message) {
  const products = [];
  const imgRegex = /<img\b[^>]*>/gi;
  const messageTokens = getSearchTokens(message);
  let match;
  while ((match = imgRegex.exec(html))) {
    const tag = match[0];
    const src = getAttribute(tag, 'src')
      || getAttribute(tag, 'data-src')
      || getAttribute(tag, 'data-original')
      || getAttribute(tag, 'data-lazy')
      || getAttribute(tag, 'data-lazy-src');
    const imageUrl = resolvePageUrl(pageUrl, src);
    if (!imageUrl || /logo|banner|categoria|category|icon|sprite|placeholder|sem_foto/i.test(imageUrl)) continue;

    const start = Math.max(0, match.index - 1200);
    const end = Math.min(html.length, match.index + 1800);
    const fragment = html.slice(start, end);
    const hasProductSignal = /produto|product|price|pre[cç]o|valor|comprar|add-to-cart|cart|sku|variant|varia[cç][aã]o|R\$/i.test(fragment);
    if (!hasProductSignal) continue;

    const alt = getAttribute(tag, 'alt') || getAttribute(tag, 'title');
    const title = extractTitleNearHtml(fragment, alt);
    if (!title || /logo|banner|categoria|menu|icone|icon/i.test(title)) continue;

    const hrefMatches = [...fragment.matchAll(/<a\b[^>]+href=["']([^"']+)["'][^>]*>/gi)];
    const href = hrefMatches.length ? hrefMatches[hrefMatches.length - 1][1] : '';
    const price = extractPriceNearHtml(fragment);
    const description = stripHtml(fragment).slice(0, 300);
    const product = {
      url: resolvePageUrl(pageUrl, href || pageUrl),
      title,
      description,
      price,
      stock: null,
      variations: [],
      images: [imageUrl],
      score: 0
    };
    product.score = getProductScore(product, messageTokens);
    products.push(product);
  }

  return dedupeProducts(products)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

async function enrichProductsFromPages(products, message) {
  const enriched = [];
  for (const product of products.slice(0, 6)) {
    if (!product.url || !/^https?:\/\//i.test(product.url)) {
      enriched.push(product);
      continue;
    }
    try {
      const response = await fetch(product.url, {
        headers: { 'User-Agent': 'ContatoSyncBot/1.0 (+https://contatosync-evolution.vercel.app)' },
        signal: AbortSignal.timeout(6000)
      });
      if (!response.ok) {
        enriched.push(product);
        continue;
      }
      const html = await response.text();
      const jsonProducts = extractJsonLdProducts(html, product.url);
      const pageProduct = jsonProducts[0];
      if (pageProduct) {
        enriched.push({
          ...product,
          ...pageProduct,
          title: pageProduct.title || product.title,
          description: pageProduct.description || product.description,
          price: pageProduct.price || product.price,
          images: pageProduct.images?.length ? pageProduct.images : product.images,
          score: getProductScore({ ...product, ...pageProduct }, getSearchTokens(message))
        });
      } else {
        enriched.push(product);
      }
    } catch (error) {
      enriched.push(product);
    }
  }
  return enriched;
}

async function fetchFacilZapProductsFromHtml(html, pageUrl, message) {
  let catalogHtml = html;
  let catalogPageUrl = pageUrl;
  let listEndpoint = getFacilZapProductListEndpoint(catalogHtml);
  if (!listEndpoint) {
    const productsPageUrl = getFacilZapProductsPageUrl(pageUrl, catalogHtml);
    if (productsPageUrl && productsPageUrl !== pageUrl) {
      try {
        const response = await fetch(productsPageUrl, {
          headers: { 'User-Agent': 'ContatoSyncBot/1.0 (+https://contatosync-evolution.vercel.app)' },
          signal: AbortSignal.timeout(8000)
        });
        if (response.ok) {
          catalogHtml = await response.text();
          catalogPageUrl = productsPageUrl;
          listEndpoint = getFacilZapProductListEndpoint(catalogHtml);
        }
      } catch (error) {
        listEndpoint = '';
      }
    }
  }

  const products = [];
  const catalogBase = getFacilZapCatalogBase(catalogHtml, catalogPageUrl);
  const categories = parseFacilZapCategories(catalogHtml);
  const messageTokens = getSearchTokens(message);
  const matchingCategories = getFacilZapMatchingCategoryIds(categories, messageTokens);

  if (listEndpoint) {
    const categoriesToLoad = matchingCategories.length > 0 ? matchingCategories : ['todas'];
    const seenIds = new Set();
    const searchId = `contatosync-${Date.now().toString(36)}`;
    for (const categoryId of categoriesToLoad) {
      for (let page = 1; page <= 12; page += 1) {
        const url = listEndpoint
          .replace('{PAGE}', String(page))
          .replace('{CATEGORY}', categoryId);
        const requestUrl = `${url}${url.includes('?') ? '&' : '?'}search_id=${encodeURIComponent(searchId)}&mobile=0`;
        let data;
        try {
          const response = await fetch(requestUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'User-Agent': 'ContatoSyncBot/1.0 (+https://contatosync-evolution.vercel.app)'
            },
            body: JSON.stringify({ pagina_especifica: 'todos_produtos' }),
            signal: AbortSignal.timeout(10000)
          });
          if (!response.ok) break;
          data = await response.json();
        } catch (error) {
          break;
        }
        if (data?.acao === 'sem_mais_produtos') break;
        if (data?.acao) break;
        const list = Array.isArray(data) ? data : Object.values(data || {});
        if (list.length === 0) break;
        let newProducts = 0;
        for (const product of list) {
          if (!product?.id || seenIds.has(String(product.id))) continue;
          seenIds.add(String(product.id));
          newProducts += 1;
          products.push(normalizeFacilZapProduct(product, catalogBase));
        }
        if (newProducts === 0) break;
      }
    }
  }

  const sectionsEndpoint = getFacilZapSectionsEndpoint(catalogHtml) || getFacilZapSectionsEndpoint(html);
  if (sectionsEndpoint && products.length === 0) {
    const body = {
      secoes: ['lancamentos', 'mais_vendidos', 'promocoes', 'destaques'],
      categorias: matchingCategories
    };
    try {
      const response = await fetch(sectionsEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'ContatoSyncBot/1.0 (+https://contatosync-evolution.vercel.app)'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
      });
      if (response.ok) {
        const data = await response.json();
        for (const list of Object.values(data)) {
          if (!Array.isArray(list)) continue;
          for (const product of list) {
            products.push(normalizeFacilZapProduct(product, catalogBase));
          }
        }
      }
    } catch (error) {
      // The full product list above is the primary source. Sections are only a fallback.
    }
  }

  return getRelevantProducts(products, message).slice(0, 10);
}

async function fetchProductContext(message, sourceUrls = [], options = {}) {
  const sources = expandProductSourcesForSearch(message, normalizeProductSources([message, ...sourceUrls]));
  if (sources.length === 0) {
    return {
      contextText: '',
      imageUrls: [],
      productCards: [],
      product_context_products: [],
      recent_products_data: []
    };
  }

  const products = [];
  const imageUrls = [];
  console.log('[AI PRODUCT] Buscando catalogo/API | query: ' + normalizeSearchText(message).slice(0, 120) + ' | fontes: ' + sources.map(source => `${source.type}:${sanitizeUrlForLog(source.url)}`).join(', '));
  for (const source of sources) {
    const url = source.url;
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'ContatoSyncBot/1.0 (+https://contatosync-evolution.vercel.app)',
          ...(source.headers || {})
        },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) {
        console.warn(`[AI PRODUCT] Fonte retornou HTTP ${response.status} | ${sanitizeUrlForLog(url)}`);
        continue;
      }
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      const bodyText = await response.text();
      if (contentType.includes('json')) {
        const data = JSON.parse(bodyText);
        const jsonProducts = extractGenericJsonProducts(data, url, source);
        if (jsonProducts.length > 0) {
          console.log('[AI PRODUCT] API de integracao consultada | fonte: ' + source.name + ' | produtos: ' + jsonProducts.length);
          for (const product of jsonProducts) {
            for (const image of product.images || []) {
              if (!imageUrls.includes(image)) imageUrls.push(image);
            }
            products.push({ ...product, sourceType: source.type, sourceName: source.name });
          }
          continue;
        }
      }
      const html = bodyText;
      const facilZapProducts = await fetchFacilZapProductsFromHtml(html, url, message);
      if (facilZapProducts.length > 0) {
        for (const product of facilZapProducts) {
          for (const image of product.images || []) {
            if (!imageUrls.includes(image)) imageUrls.push(image);
          }
          products.push({ ...product, sourceType: source.type, sourceName: source.name });
        }
        continue;
      }
      const jsonLdProducts = extractJsonLdProducts(html, url);
      const genericProducts = jsonLdProducts.length > 0
        ? jsonLdProducts
        : await enrichProductsFromPages(extractGenericHtmlProducts(html, url, message), message);
      if (genericProducts.length > 0) {
        for (const product of genericProducts) {
          for (const image of product.images || []) {
            if (!imageUrls.includes(image)) imageUrls.push(image);
          }
          products.push({ ...product, sourceType: source.type, sourceName: source.name });
        }
        continue;
      }
      const title = getTitleFromHtml(html);
      const description = getMetaContent(html, 'og:description') || getMetaContent(html, 'description');
      const candidateImages = [
        getMetaContent(html, 'og:image'),
        getMetaContent(html, 'twitter:image'),
        ...extractJsonLdImages(html, url)
      ].map(image => resolvePageUrl(url, image)).filter(Boolean);
      for (const image of candidateImages) {
        if (!imageUrls.includes(image)) imageUrls.push(image);
      }
      products.push({ url, title, description, images: candidateImages.slice(0, 5), sourceType: source.type, sourceName: source.name });
    } catch (error) {
      console.warn(`[AI PRODUCT] Falha ao acessar fonte | ${sanitizeUrlForLog(url)} | ${error.message}`);
      products.push({ url, title: '', description: `Nao foi possivel acessar a pagina: ${error.message}`, images: [] });
    }
  }

  const requestedSizes = extractRequestedSizes(message);
  const recommendableProducts = products.filter(product => productIsRecommendableForRequest(product, requestedSizes));
  if (products.length !== recommendableProducts.length) {
    console.log('[AI PRODUCT STOCK FILTER] coletados=' + products.length + ' com_estoque=' + recommendableProducts.length + ' removidos=' + (products.length - recommendableProducts.length));
  }
  const relevantProducts = getRelevantProducts(recommendableProducts, message, options);
  console.log('[AI PRODUCT] Resultado catalogo | produtos_coletados: ' + products.length + ' | produtos_relevantes: ' + relevantProducts.length);

  if (relevantProducts.length === 0) {
    return {
      contextText: '',
      imageUrls: [],
      productCards: [],
      product_context_products: [],
      recent_products_data: [],
      productsFound: false,
      allProductsCollected: recommendableProducts.length > 0 ? recommendableProducts : []
    };
  }

  const contextText = relevantProducts.map((product, index) => [
    `Produto/link ${index + 1}: ${product.url}`,
    product.sourceName ? `Fonte: ${product.sourceName}` : '',
    product.title ? `Titulo: ${product.title}` : '',
    product.price ? `Preco: ${product.price}` : '',
    getProductAvailableStock(product) !== null && getProductAvailableStock(product) !== undefined ? `Estoque informado: ${getProductAvailableStock(product)}` : '',
    product._sizes?.length ? `Tamanhos encontrados: ${product._sizes.join(', ')}` : '',
    getAvailableProductSizes(product).length ? `Tamanhos com estoque: ${getAvailableProductSizes(product).join(', ')}` : '',
    product.variations?.length ? `Variacoes: ${product.variations.join(', ')}` : '',
    product.description ? `Descricao: ${product.description}` : '',
    product.images?.length ? `Imagens disponiveis para envio: ${product.images.slice(0, 5).length}` : ''
  ].filter(Boolean).join('\n')).join('\n\n');

  const displayedProducts = relevantProducts.slice(0, 6);
  const productContextProducts = displayedProducts.map((product, index) => buildProductContextProduct(product, index + 1));
  const productCards = [];
  for (const product of displayedProducts) {
    const images = (product.images || []).slice(0, 2);
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const suffix = images.length > 1 ? ` - foto ${index + 1}` : '';
      productCards.push({
        title: buildCarouselCardTitle(product, suffix),
        description: buildCarouselCardDescription(product),
        url: product.url,
        imageUrl: image
      });
    }
  }

  return {
    contextText: `Informacoes coletadas da loja virtual:\n${contextText}`,
    imageUrls: relevantProducts.flatMap(product => product.images || []).slice(0, 5),
    productCards: productCards.slice(0, 10),
    product_context_products: productContextProducts,
    recent_products_data: productContextProducts,
    productsFound: relevantProducts.length > 0,
    lookupAttempted: true,
    allProductsCollected: recommendableProducts
  };
}

async function fetchSiteInfoContext(message, sourceUrls = []) {
  const sources = normalizeProductSources([message, ...sourceUrls]);
  if (sources.length === 0) return { contextText: '', lookupAttempted: false };

  const entries = [];
  console.log('[AI SITE] Buscando informacoes gerais | query: ' + normalizeSearchText(message).slice(0, 120) + ' | fontes: ' + sources.map(source => `${source.type}:${sanitizeUrlForLog(source.url)}`).join(', '));
  const sourceLimit = sources.some(source => source.operational) ? 8 : 6;
  for (const source of sources.slice(0, sourceLimit)) {
    try {
      const response = await fetch(source.url, {
        headers: {
          'User-Agent': 'ContatoSyncBot/1.0 (+https://contatosync-evolution.vercel.app)',
          ...(source.headers || {})
        },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) {
        console.warn(`[AI SITE] Fonte retornou HTTP ${response.status} | ${sanitizeUrlForLog(source.url)}`);
        if (source.operational) {
          entries.push({
            url: sanitizeUrlForLog(source.url),
            sourceName: source.name,
            title: source.name || 'API configurada',
            description: '',
            snippets: [`A consulta da integracao retornou HTTP ${response.status}. O sistema nao deve afirmar que o pedido nao existe sem outra fonte com dados do pedido.`]
          });
        }
        continue;
      }
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      const bodyText = await response.text();
      if (contentType.includes('json')) {
        const parsedJson = JSON.parse(bodyText);
        const snippets = source.operational
          ? getOperationalJsonSnippets(parsedJson, message, source)
          : getRelevantSiteSnippets(flattenJsonText(parsedJson).join('\n'), message);
        if (snippets.length > 0) {
          entries.push({
            url: sanitizeUrlForLog(source.url),
            sourceName: source.name,
            title: source.name || 'API configurada',
            description: '',
            snippets
          });
        }
        continue;
      }

      const siteInfo = extractSiteInfoFromHtml(bodyText, source.url, message);
      const hasUsefulInfo = siteInfo.title || siteInfo.description || siteInfo.snippets.length > 0;
      if (hasUsefulInfo) entries.push({ ...siteInfo, url: sanitizeUrlForLog(siteInfo.url), sourceName: source.name });
    } catch (error) {
      console.warn(`[AI SITE] Falha ao acessar fonte | ${sanitizeUrlForLog(source.url)} | ${error.message}`);
      entries.push({
        url: sanitizeUrlForLog(source.url),
        sourceName: source.name,
        title: '',
        description: '',
        snippets: [`Nao foi possivel acessar esta fonte: ${error.message}`]
      });
    }
  }

  if (entries.length === 0) return { contextText: '', lookupAttempted: true };

  const contextText = entries.map((entry, index) => [
    `Fonte ${index + 1}: ${entry.url}`,
    entry.sourceName ? `Nome da fonte: ${entry.sourceName}` : '',
    entry.title ? `Titulo da pagina: ${entry.title}` : '',
    entry.description ? `Descricao da pagina: ${entry.description}` : '',
    entry.snippets.length ? `Informacoes encontradas:\n- ${entry.snippets.join('\n- ')}` : ''
  ].filter(Boolean).join('\n')).join('\n\n');

  return {
    contextText: `Informacoes gerais coletadas do site/configuracoes:\n${contextText}`,
    lookupAttempted: true
  };
}

function getMediaKind(media = {}) {
  const type = String(media.messageType || '').toLowerCase();
  const mime = String(media.mimeType || media.mimetype || '').toLowerCase();
  if (type === 'image' || type === 'sticker' || mime.startsWith('image/')) return 'image';
  if (type === 'audio' || mime.startsWith('audio/')) return 'audio';
  if (type === 'video' || type === 'gif' || mime.startsWith('video/')) return 'video';
  if (type === 'document' || mime === 'application/pdf') return 'document';
  return type || 'file';
}

function getMediaDescription(media = {}) {
  const parts = [
    `Tipo da midia: ${media.messageType || 'arquivo'}`,
    `Arquivo: ${media.fileName || 'sem nome'}`,
    `MIME: ${media.mimeType || 'nao informado'}`
  ];
  if (media.url) parts.push(`URL interna: ${media.url}`);
  return parts.join('\n');
}

function getMimeTypeFromPath(filePath, fallback = 'application/octet-stream') {
  const ext = path.extname(filePath || '').toLowerCase();
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.xml': 'application/xml',
    '.log': 'text/plain',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
  return map[ext] || fallback;
}

function fileToDataUrl(filePath, mimeType) {
  const data = fs.readFileSync(filePath);
  return `data:${mimeType || getMimeTypeFromPath(filePath)};base64,${data.toString('base64')}`;
}

function fileToBase64(filePath) {
  return fs.readFileSync(filePath).toString('base64');
}

function canReadTextFile(filePath, mimeType) {
  const ext = path.extname(filePath || '').toLowerCase();
  const mime = String(mimeType || '').toLowerCase();
  return ['.txt', '.csv', '.json', '.md', '.markdown', '.log', '.xml', '.html', '.htm'].includes(ext)
    || mime.startsWith('text/')
    || ['application/json', 'application/xml', 'application/xhtml+xml'].includes(mime);
}

function getKnowledgeFiles(config = {}) {
  return Array.isArray(config.knowledge_files)
    ? config.knowledge_files.filter(file => file && (file.extractedText || file.path || file.originalName))
    : [];
}

function buildKnowledgeContextForConfig(config = {}) {
  const files = getKnowledgeFiles(config);
  if (files.length === 0) return '';

  let remaining = 50000;
  const blocks = [];
  for (const file of files.slice(0, 20)) {
    const name = file.originalName || file.fileName || 'arquivo';
    const mimeType = file.mimetype || getMimeTypeFromPath(file.path || '');
    let text = String(file.extractedText || '').trim();

    if (!text && file.path && fs.existsSync(file.path)) {
      try {
        const stat = fs.statSync(file.path);
        if (canReadTextFile(file.path, mimeType) && stat.size <= 1024 * 1024) {
          text = fs.readFileSync(file.path, 'utf8').slice(0, 20000).trim();
        }
      } catch (readError) {
        text = '';
      }
    }

    if (!text) {
      blocks.push(`Arquivo: ${name}\nTipo: ${mimeType}\nObservacao: arquivo anexado como fonte de conhecimento. Use o nome e metadados quando forem relevantes; se o conteudo nao estiver legivel no contexto, nao invente informacoes.`);
      continue;
    }

    const slice = text.slice(0, Math.max(0, Math.min(remaining, 12000)));
    if (!slice) break;
    blocks.push(`Arquivo: ${name}\nTipo: ${mimeType}\nConteudo:\n${slice}`);
    remaining -= slice.length;
    if (remaining <= 0) break;
  }

  if (blocks.length === 0) return '';
  return `Arquivos de conhecimento configurados para a IA:\n\n${blocks.join('\n\n---\n\n')}\n\nUse estes arquivos como fonte antes de responder. Nao invente dados que nao estejam nos arquivos, APIs, catalogo ou conversa.`;
}

function buildOpenAIKnowledgeFileParts(config = {}) {
  return getKnowledgeFiles(config)
    .filter(file => {
      const mimeType = file.mimetype || getMimeTypeFromPath(file.path || '');
      if (mimeType !== 'application/pdf') return false;
      if (!file.path || !fs.existsSync(file.path)) return false;
      try {
        return fs.statSync(file.path).size <= 50 * 1024 * 1024;
      } catch (error) {
        return false;
      }
    })
    .slice(0, 5)
    .map(file => ({
      type: 'input_file',
      filename: file.originalName || file.fileName || path.basename(file.path),
      file_data: fileToBase64(file.path)
    }));
}

async function convertMediaToMp3(filePath) {
  const ffmpegPath = require('ffmpeg-static');
  if (!ffmpegPath) throw new Error('ffmpeg-static indisponivel');
  const outputPath = path.join(os.tmpdir(), `contatosync-ai-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
  await execFileAsync(ffmpegPath, [
    '-y',
    '-i', filePath,
    '-vn',
    '-acodec', 'libmp3lame',
    '-ar', '16000',
    '-ac', '1',
    outputPath
  ], { timeout: 120000 });
  return outputPath;
}

async function extractVideoFrame(filePath) {
  const ffmpegPath = require('ffmpeg-static');
  if (!ffmpegPath) throw new Error('ffmpeg-static indisponivel');
  const outputPath = path.join(os.tmpdir(), `contatosync-frame-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`);
  await execFileAsync(ffmpegPath, [
    '-y',
    '-ss', '00:00:01',
    '-i', filePath,
    '-frames:v', '1',
    '-q:v', '3',
    outputPath
  ], { timeout: 120000 });
  return outputPath;
}

async function transcribeOpenAIMedia({ apiKey, filePath, mimeType }) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  let uploadPath = filePath;
  let tempPath = '';
  const cleanMime = String(mimeType || '').toLowerCase();
  const supported = ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'video/mp4', 'video/webm'];

  if (!supported.some(item => cleanMime.startsWith(item)) && !['.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm'].includes(path.extname(filePath).toLowerCase())) {
    tempPath = await convertMediaToMp3(filePath);
    uploadPath = tempPath;
  }

  try {
    const stat = fs.statSync(uploadPath);
    if (stat.size > 25 * 1024 * 1024) {
      return 'O audio/video foi recebido, mas e maior que 25 MB e nao foi transcrito automaticamente.';
    }

    const buffer = fs.readFileSync(uploadPath);
    const form = new FormData();
    form.append('model', 'gpt-4o-mini-transcribe');
    form.append('response_format', 'json');
    form.append('file', new Blob([buffer]), path.basename(uploadPath));

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `OpenAI transcricao respondeu HTTP ${response.status}`);
    return data.text || '';
  } finally {
    if (tempPath) fs.promises.unlink(tempPath).catch(() => {});
  }
}

function formatConversationHistory(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const fullHistory = messages.map(item => {
    const author = item.direction === 'out' || item.is_from_ai ? 'Atendente/IA' : 'Cliente';
    return `${author}: ${String(item.content || '').slice(0, 600)}`;
  }).join('\n');

  if (fullHistory.length <= 30000) return fullHistory;

  const firstMessages = messages.slice(0, 12).map(item => {
    const author = item.direction === 'out' || item.is_from_ai ? 'Atendente/IA' : 'Cliente';
    return `${author}: ${String(item.content || '').slice(0, 600)}`;
  }).join('\n');
  const recentMessages = messages.slice(-45).map(item => {
    const author = item.direction === 'out' || item.is_from_ai ? 'Atendente/IA' : 'Cliente';
    return `${author}: ${String(item.content || '').slice(0, 600)}`;
  }).join('\n');

  return [
    'Inicio da conversa:',
    firstMessages,
    '',
    'Historico intermediario omitido por limite de contexto. Preserve nomes, preferencias e combinados do inicio acima.',
    '',
    'Mensagens mais recentes:',
    recentMessages
  ].join('\n');
}

function getRecentCustomerProductRequest(conversationHistory = [], conversation = {}) {
  const memoryRequest = getLastProductSearchRequestMemory(conversation);
  if (memoryRequest) return memoryRequest;
  const recentCustomerMessages = Array.isArray(conversationHistory)
    ? conversationHistory
      .filter(item => item && item.direction !== 'out' && !item.is_from_ai)
      .slice(-8)
      .map(item => String(item.content || '').trim())
      .filter(Boolean)
    : [];
  return [...recentCustomerMessages]
    .reverse()
    .find(item => shouldUseConfiguredProductSources(item) || getSpecificProductTokens(getSearchTokens(item)).length > 0)
    || '';
}

function extractPreviouslyMentionedProductTitles(conversationHistory = []) {
  if (!Array.isArray(conversationHistory)) return [];
  const ignored = /^(alberto|encontrei|enviei|no momento|infelizmente|posso|quer|temos|essas opcoes|opcoes|estoque atual|na loja|aqui estao)/i;
  const seen = new Set();
  return conversationHistory
    .filter(item => item && (item.direction === 'out' || item.is_from_ai))
    .slice(-8)
    .flatMap(item => String(item.content || '').split(/\r?\n/))
    .map(line => stripHtml(line)
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .replace(/^(?:produto|titulo|opcao)\s*[:\-]\s*/i, '')
      .trim())
    .filter(line => line.length >= 4 && line.length <= 90)
    .filter(line => !ignored.test(normalizeSearchText(line)))
    .filter(line => /\b(saia|short|vestido|conjunto|blusa|body|calca|macacao|jardineira|camiseta|cropped|tshirt|moletom|moleton)\b/i.test(normalizeSearchText(line)))
    .filter(line => {
      const key = normalizeSearchText(line);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function buildProductSearchText(message, conversationHistory = [], options = {}) {
  const current = String(message || '').trim();
  const normalizedCurrent = normalizeSearchText(current);
  const currentIsFollowUp = isCatalogFollowUpRequest(normalizedCurrent) || isMoreProductOptionsRequest(current);
  const lastProductRequest = String(options.baseProductRequest || '').trim() || getRecentCustomerProductRequest(conversationHistory, options.conversation);
  const currentForIntent = currentIsFollowUp && lastProductRequest ? `${lastProductRequest}\n${current}` : current;
  const currentShouldSearch = shouldUseConfiguredProductSources(currentForIntent);
  if (!currentShouldSearch) return currentForIntent;
  if (!currentIsFollowUp && getSpecificProductTokens(getSearchTokens(current)).length > 0) return current;
  const parts = currentIsFollowUp && lastProductRequest ? [lastProductRequest, current] : [current];
  return [...new Set(parts)].join('\n');
}

// ─── NOVAS FUNÇÕES DE CLASSIFICAÇÃO DE INTENÇÃO ──────────────────────────────

/**
 * Classifica a intenção do cliente usando IA.
 * Retorna objeto com intent, source, search_query, filters, etc.
 * Se a IA falhar, usa fallback determinístico leve.
 */
async function classifyCustomerIntent({ apiKey, provider, message, conversationHistory, config }) {
  if (getStorePolicyKnowledgeQuery(message)) {
    return classifyCustomerIntentFallback(message, conversationHistory);
  }

  // Tenta classificação por IA se houver API key válida
  if (isUsableProviderApiKey(provider, apiKey)) {
    try {
      const llmResult = await classifyCustomerIntentWithLLM({ apiKey, provider, message, conversationHistory });
      if (llmResult) {
        console.log('[CLASSIFY] intent=' + llmResult.intent + ' source=' + llmResult.source + ' query="' + (llmResult.search_query || '') + '"');
        return llmResult;
      }
    } catch (error) {
      console.warn('[CLASSIFY] Falha na classificação LLM, usando fallback determinístico | erro: ' + String(error.message || error));
    }
  }

  // Fallback determinístico leve
  const fallback = classifyCustomerIntentFallback(message, conversationHistory);
  console.log('[CLASSIFY-FALLBACK] intent=' + fallback.intent + ' source=' + fallback.source + ' query="' + (fallback.search_query || '') + '"');
  return fallback;
}

/**
 * Classificação via LLM.
 * Retorna o schema de intenção ou null se falhar.
 */
async function classifyCustomerIntentWithLLM({ apiKey, provider, message, conversationHistory }) {
  const recentHistory = (conversationHistory || [])
    .slice(-8)
    .map(item => {
      const author = (item.direction === 'out' || item.is_from_ai) ? 'Atendente/IA' : 'Cliente';
      return `${author}: ${String(item.content || '').slice(0, 300)}`;
    })
    .join('\n');

  const recentProductTitles = getRecentlySentProductTitles(conversationHistory);
  const recentProductsText = recentProductTitles.length > 0
    ? recentProductTitles.join(', ')
    : 'nenhum produto enviado recentemente';

  const classifyPrompt = `Você é um classificador de intenções para um chatbot de loja virtual no WhatsApp.
Analise a mensagem do cliente e o histórico recente da conversa.
Retorne APENAS um JSON válido, sem markdown, sem comentários, sem texto adicional.

### INTENÇÕES POSSÍVEIS:

1. "product_search" - Cliente quer buscar um produto NOVO no catálogo.
   Ex: "tem moletom?", "quero ver vestidos", "mostra blusas", "moletom tamanho 6", "tem azul?"
   → source: "product_api", search_query preenchido com nome/categoria do produto (sem palavras como "tem", "quero", "mostra")
   → filters: size, color, category se mencionados

2. "product_stock_followup" - Cliente pergunta sobre tamanho/estoque de produtos JÁ ENVIADOS.
   Ex: "tem no tamanho 6?", "quantas tem?", "tem PP?", "ainda tem?", "tem em estoque?"
   → source: "recent_context", search_query vazio
   → filters: size preenchido se mencionado
   → IMPORTANTE: se há vários produtos no histórico e o cliente não especificou qual, needs_clarification=true

3. "product_followup" - Cliente pede mais opções/fotos de produtos já enviados.
   Ex: "manda mais", "tem outras cores?", "mostra mais fotos", "e esse?", "o primeiro", "o segundo"
   → source: "recent_context"

4. "order_lookup" - Cliente pergunta sobre pedido/compra.
   Ex: "pedido 1234", "onde está meu pedido?", "não chegou", "qual status da compra?"
   → source: "order_api", order_id preenchido se houver número

5. "tracking_lookup" - Cliente pergunta sobre rastreio/envio.
   Ex: "código de rastreio?", "já enviou?", "quando chega?"
   → source: "tracking_api"

6. "knowledge_question" - Cliente pergunta sobre loja, políticas, funcionamento.
   Ex: "qual prazo de entrega?", "como comprar?", "endereço?", "formas de pagamento?", "troca?"
   → source: "knowledge_base", search_query preenchido

7. "general_message" - Mensagem geral que não se encaixa nas anteriores.
   → source: "llm_only"

8. "clarification" - Ambiguidade real que precisa de pergunta ao cliente.
   → needs_clarification=true, clarification_question preenchido

### REGRAS CRÍTICAS:
- REGRA ABSOLUTA: se a mensagem contém nome de produto (camisa, camiseta, blusa, vestido, saia, conjunto, moletom, body, roupa, pijama, jaqueta, casaco, bermuda, short, calca, cropped) OU tema/personagem/marca/estampa, é SEMPRE product_search, NUNCA product_stock_followup.
- product_stock_followup SOMENTE para mensagens sem nome de produto E sem tema/personagem: "tem no tamanho 6?", "quantas tem?", "tem PP?", "ainda tem?".
- "quantas" NUNCA é nome de produto.
- Perguntas sobre pedido minimo ou quantidade minima de compra sao knowledge_question, nao product_search. Ex: "posso comprar menos que o minimo?", "qual e a compra minima?", "quantas unidades precisa comprar?".
- Perguntas sobre retirada, entrega, ponto de encontro, motoboy, frete, envio ou endereco sao knowledge_question/store_info, nao general_message.
- Confirmacoes curtas como "sim quero", "quero", "sim", "pode", "manda" so podem virar acao se houver contexto pendente; sem contexto, use clarification.
- Se há produtos no contexto recente e o cliente pergunta sobre tamanho/estoque sem especificar qual produto, needs_clarification=true.
- search_query deve conter o substantivo de produto E os modificadores importantes: tema, personagem, marca, estampa. NUNCA remova tema/personagem/marca do search_query. Exemplos corretos: "camiseta tema personagem", "camisa marca especifica", "produto com estampa solicitada". Exemplos ERRADOS (perdem o modificador): "camiseta", "camisa", "produto".
- Se a mensagem pede tema/personagem de forma ampla, é product_search com search_query apenas dos tokens do tema, SEM herdar produto anterior do contexto.
- semantic_query: descrição semântica do que o cliente quer (tipo de produto + tema/característica). Preencher APENAS para product_search. Ex: "produto da categoria solicitada com tema/personagem informado". Deixar "" para outras intencoes.
- product_type: tipo/categoria do produto mencionado. Preencher APENAS para product_search. Ex: "camiseta", "vestido", "categoria do produto". Deixar "" se nao aplicavel.
- theme: tema, estampa ou personagem mencionado. Preencher APENAS para product_search. Ex: "personagem", "marca", "estampa". Deixar "" se nao aplicavel.
- allow_related_products: true se o cliente parece aberto a sugestoes relacionadas (pedido com tema/personagem/conceito amplo), false se o pedido e muito especifico (cor + tamanho + modelo exato).

### CAMPOS NOVOS (adicionais — não alteram intent nem search_query):
- question_type: subcategoria da pergunta. Valores: "product_search", "stock_by_size_color", "price_check", "availability_check", "order_status", "tracking_code", "delivery_policy", "payment_policy", "exchange_policy", "store_info", "semantic_product_search", "other".
  Exemplos: "tem moletom tamanho 6?" → "product_search". "tem quantas azul tamanho 6?" → "stock_by_size_color". "qual prazo de entrega?" → "delivery_policy". "pedido 1234" → "order_status".
- sources_needed: array com as fontes que precisam ser consultadas para responder. Valores possíveis: "product_api", "recent_products", "order_api", "tracking_api", "knowledge_base", "site_urls", "files", "conversation_history".
  Exemplos: product_search → ["product_api"]. stock_by_size_color com produto recente → ["recent_products", "product_api"]. prazo entrega → ["knowledge_base", "site_urls"]. pedido → ["order_api"].
- entities: objeto com entidades extraídas da mensagem. Preencher apenas o que for mencionado, deixar "" o restante.
  Campos: product (nome do produto mencionado), product_id (id se mencionado), size (tamanho), color (cor), theme (tema/personagem/marca), category (categoria), order_id (número do pedido), date (data mencionada), location (localização mencionada).
- operation: tipo de operação. Valores: "search" (buscar produto), "lookup" (consultar dado específico), "calculate" (calcular estoque/disponibilidade), "compare" (comparar opções), "summarize" (resumir informações), "clarify" (pedir esclarecimento).

### CONTEXTO:
Histórico recente:
${recentHistory || '(sem histórico)'}

Produtos enviados recentemente: ${recentProductsText}

Mensagem atual: "${message}"

Responda SOMENTE com JSON (todos os campos obrigatórios):
{"intent":"...","source":"...","search_query":"...","semantic_query":"","product_type":"","theme":"","allow_related_products":false,"filters":{"size":"","color":"","category":""},"order_id":"","tracking_id":"","reference":"none","selected_product_index":null,"needs_clarification":false,"clarification_question":"","question_type":"other","sources_needed":[],"entities":{"product":"","product_id":"","size":"","color":"","theme":"","category":"","order_id":"","date":"","location":""},"operation":"search"}`;

  try {
    let responseText = '';
    if (provider === 'claude') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 500,
          temperature: 0,
          messages: [{ role: 'user', content: classifyPrompt }]
        }),
        signal: AbortSignal.timeout(4000)
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      responseText = data?.content?.[0]?.text || '';
    } else {
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0,
          max_output_tokens: 500,
          input: [{ role: 'user', content: [{ type: 'input_text', text: classifyPrompt }] }]
        }),
        signal: AbortSignal.timeout(4000)
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      responseText = getOpenAIText(data) || '';
    }

    const clean = responseText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // Validação mínima — campos antigos
    const validIntents = ['product_search', 'product_stock_followup', 'product_followup', 'order_lookup', 'tracking_lookup', 'knowledge_question', 'general_message', 'clarification'];
    if (!validIntents.includes(parsed.intent)) return null;

    // Normalizar campos novos (Fase 1) — defaults seguros se LLM omitiu
    const validQuestionTypes = ['product_search','stock_by_size_color','price_check','availability_check','order_status','tracking_code','delivery_policy','payment_policy','exchange_policy','store_info','semantic_product_search','other'];
    const validOperations = ['search','lookup','calculate','compare','summarize','clarify'];
    const validSources = ['product_api','recent_products','order_api','tracking_api','knowledge_base','site_urls','files','conversation_history'];

    parsed.question_type = validQuestionTypes.includes(parsed.question_type) ? parsed.question_type : 'other';
    parsed.operation = validOperations.includes(parsed.operation) ? parsed.operation : 'search';
    parsed.sources_needed = Array.isArray(parsed.sources_needed)
      ? parsed.sources_needed.filter(s => validSources.includes(s))
      : [];
    parsed.entities = {
      product:    String(parsed.entities?.product    || ''),
      product_id: String(parsed.entities?.product_id || ''),
      size:       String(parsed.entities?.size       || parsed.filters?.size || ''),
      color:      String(parsed.entities?.color      || parsed.filters?.color || ''),
      theme:      String(parsed.entities?.theme      || parsed.theme || ''),
      category:   String(parsed.entities?.category   || parsed.filters?.category || ''),
      order_id:   String(parsed.entities?.order_id   || parsed.order_id || ''),
      date:       String(parsed.entities?.date       || ''),
      location:   String(parsed.entities?.location   || '')
    };

    // Se LLM não preencheu sources_needed, inferir a partir do intent (compatibilidade)
    if (parsed.sources_needed.length === 0) {
      const intentToSources = {
        product_search:       ['product_api'],
        product_stock_followup: ['recent_products'],
        product_followup:     ['recent_products', 'product_api'],
        order_lookup:         ['order_api'],
        tracking_lookup:      ['tracking_api'],
        knowledge_question:   ['knowledge_base', 'site_urls'],
        general_message:      [],
        clarification:        ['conversation_history']
      };
      parsed.sources_needed = intentToSources[parsed.intent] || [];
    }

    return parsed;
  } catch (error) {
    return null;
  }
}

/**
 * Fallback determinístico leve quando a IA falha.
 * NÃO usa lista de palavras-chave extensa.
 * NÃO retorna search_query com a mensagem bruta.
 */
function classifyCustomerIntentFallback(message, conversationHistory) {
  const normalized = normalizeSearchText(message);

  // Helper: monta campos novos da Fase 1 a partir de dados já extraídos
  function _buildPhase1Fields(intent, overrides = {}) {
    const intentToSources = {
      product_search:         ['product_api'],
      product_stock_followup: ['recent_products'],
      product_followup:       ['recent_products', 'product_api'],
      order_lookup:           ['order_api'],
      tracking_lookup:        ['tracking_api'],
      knowledge_question:     ['knowledge_base', 'site_urls'],
      general_message:        [],
      clarification:          ['conversation_history']
    };
    const intentToQType = {
      product_search:         'product_search',
      product_stock_followup: 'stock_by_size_color',
      product_followup:       'product_search',
      order_lookup:           'order_status',
      tracking_lookup:        'tracking_code',
      knowledge_question:     'other',
      general_message:        'other',
      clarification:          'other'
    };
    const intentToOp = {
      product_search:         'search',
      product_stock_followup: 'calculate',
      product_followup:       'search',
      order_lookup:           'lookup',
      tracking_lookup:        'lookup',
      knowledge_question:     'lookup',
      general_message:        'summarize',
      clarification:          'clarify'
    };
    return {
      question_type:  overrides.question_type  || intentToQType[intent]  || 'other',
      sources_needed: overrides.sources_needed || intentToSources[intent] || [],
      entities: {
        product:    overrides.product    || '',
        product_id: overrides.product_id || '',
        size:       overrides.size       || '',
        color:      overrides.color      || '',
        theme:      overrides.theme      || '',
        category:   overrides.category   || '',
        order_id:   overrides.order_id   || '',
        date:       '',
        location:   ''
      },
      operation: overrides.operation || intentToOp[intent] || 'search'
    };
  }

  // 1. Se tem número de pedido → order_lookup ou tracking_lookup
  const minimumOrderQuery = getMinimumOrderPolicyQuery(message);
  if (minimumOrderQuery) {
    console.log('[CLASSIFY-FALLBACK KNOWLEDGE] reason=minimum_order query="pedido mínimo"');
    return {
      intent: 'knowledge_question',
      source: 'knowledge_base',
      search_query: minimumOrderQuery,
      filters: { size: '', color: '', category: '' },
      order_id: '',
      reference: 'none',
      needs_clarification: false,
      clarification_question: '',
      ..._buildPhase1Fields('knowledge_question', {
        question_type: 'store_info',
        sources_needed: ['knowledge_base', 'site_urls', 'files'],
        operation: 'lookup'
      })
    };
  }

  const storePolicyQuery = getStorePolicyKnowledgeQuery(message);
  if (storePolicyQuery) {
    console.log('[CLASSIFY-FALLBACK KNOWLEDGE] reason=store_policy query="' + storePolicyQuery + '"');
    return {
      intent: 'knowledge_question',
      source: 'knowledge_base',
      search_query: storePolicyQuery,
      filters: { size: '', color: '', category: '' },
      order_id: '',
      reference: 'none',
      needs_clarification: false,
      clarification_question: '',
      ..._buildPhase1Fields('knowledge_question', {
        question_type: 'store_info',
        sources_needed: ['knowledge_base', 'site_urls', 'files'],
        operation: 'lookup'
      })
    };
  }

  const orderId = extractOrderReference(message);
  if (orderId) {
    const isTracking = /rastreio|rastrear|codigo de rastreio|enviado|despacho/i.test(normalized);
    if (isTracking) {
      return {
        intent: 'tracking_lookup',
        source: 'tracking_api',
        search_query: '',
        filters: { size: '', color: '', category: '' },
        order_id: orderId,
        reference: 'none',
        needs_clarification: false,
        clarification_question: '',
        ..._buildPhase1Fields('tracking_lookup', { order_id: orderId })
      };
    }
    return {
      intent: 'order_lookup',
      source: 'order_api',
      search_query: '',
      filters: { size: '', color: '', category: '' },
      order_id: orderId,
      reference: 'none',
      needs_clarification: false,
      clarification_question: '',
      ..._buildPhase1Fields('order_lookup', { order_id: orderId })
    };
  }

  // 2. Pergunta sobre pedido sem número
  const isOrderQuery = /\b(meu pedido|minha compra|comprei|nao chegou|nao recebi|onde esta meu|status do pedido|pagamento confirmado)\b/i.test(normalized);
  if (isOrderQuery) {
    return {
      intent: 'order_lookup',
      source: 'order_api',
      search_query: '',
      filters: { size: '', color: '', category: '' },
      order_id: '',
      reference: 'none',
      needs_clarification: false,
      clarification_question: '',
      ..._buildPhase1Fields('order_lookup')
    };
  }

  // 3. Se a mensagem tem tamanho + NÃO tem nome de produto + NÃO tem tema/personagem + tem produtos recentes → stock_followup
  const hasSize = extractRequestedSizes(message).length > 0;
  const productSearchPhrase = getProductSearchPhrase(message);
  const hasProductName = productSearchPhrase.length > 0;
  const recentProducts = getReliableRecentProductStockContext(conversationHistory);
  // Guard: mensagem com tema/personagem/marca nunca é stock_followup
  const hasThemeOrBrand = /\b(tema|personagem|personagens|marca|estampa|licenciado|licenciada)\b/i.test(normalizeSearchText(message));

  const stockFollowupIntent = isStockAvailabilityFollowUp(message) && !hasThemeOrBrand
    ? buildStockFollowupIntentFromMessage(message, conversationHistory, hasSize ? 'size_or_quantity' : 'quantity_or_availability')
    : null;
  if (stockFollowupIntent) return stockFollowupIntent;

  if (hasSize && !hasProductName && !hasThemeOrBrand && recentProducts.length > 0) {
    const requestedSizes = extractRequestedSizes(message);
    return {
      intent: 'product_stock_followup',
      source: 'recent_context',
      search_query: '',
      filters: {
        size: requestedSizes.join(','),
        color: getColorTokens(getSearchTokens(message)).join(','),
        category: ''
      },
      order_id: '',
      reference: 'recent_products',
      needs_clarification: recentProducts.length > 1,
      clarification_question: recentProducts.length > 1 ? 'Você quer saber o tamanho de qual opção?' : '',
      ..._buildPhase1Fields('product_stock_followup', {
        size: requestedSizes.join(','),
        color: getColorTokens(getSearchTokens(message)).join(',')
      })
    };
  }

  // 4. Se tem nome de produto → product_search com query limpa
  if (hasProductName) {
    const colorTokens = getColorTokens(getSearchTokens(message));
    const requestedSizes = extractRequestedSizes(message);
    return {
      intent: 'product_search',
      source: 'product_api',
      search_query: productSearchPhrase,
      filters: {
        size: requestedSizes.join(','),
        color: colorTokens.join(','),
        category: ''
      },
      order_id: '',
      reference: 'none',
      needs_clarification: false,
      clarification_question: '',
      ..._buildPhase1Fields('product_search', {
        product: productSearchPhrase,
        size: requestedSizes.join(','),
        color: colorTokens.join(',')
      })
    };
  }

  // 5. Se hasStrongProductIntent mas sem nome de produto → tentar extrair do histórico
  if (hasStrongProductIntent(message) && recentProducts.length > 0) {
    const lastProductRequest = getRecentCustomerProductRequest(conversationHistory);
    if (lastProductRequest) {
      const cleanQuery = getProductSearchPhrase(lastProductRequest);
      if (cleanQuery) {
        return {
          intent: 'product_search',
          source: 'product_api',
          search_query: cleanQuery,
          filters: { size: '', color: '', category: '' },
          order_id: '',
          reference: 'none',
          needs_clarification: false,
          clarification_question: '',
          ..._buildPhase1Fields('product_search', { product: cleanQuery })
        };
      }
    }
  }

  // 6. Se é pergunta sobre loja/políticas → knowledge_question
  if (shouldUseConfiguredSiteSources(message)) {
    return {
      intent: 'knowledge_question',
      source: 'knowledge_base',
      search_query: message,
      filters: { size: '', color: '', category: '' },
      order_id: '',
      reference: 'none',
      needs_clarification: false,
      clarification_question: '',
      ..._buildPhase1Fields('knowledge_question')
    };
  }

  // 7. Fallback final seguro: general_message (NÃO busca catálogo com mensagem bruta)
  return {
    intent: 'general_message',
    source: 'llm_only',
    search_query: '',
    filters: { size: '', color: '', category: '' },
    order_id: '',
    reference: 'none',
    needs_clarification: false,
    clarification_question: '',
    ..._buildPhase1Fields('general_message')
  };
}

/**
 * Extrai títulos de produtos enviados recentemente pela IA no histórico.
 * Limpa emoji 🛍️, marcador •, sufixo "- foto N", preço depois de "— R$",
 * e linhas genéricas como "As fotos foram enviadas acima".
 * Retorna array com no máximo 5 títulos únicos.
 */
/**
 * Extrai contexto de estoque/tamanho dos cards enviados recentemente.
 * Lê o content das mensagens da IA e identifica linhas como:
 * "Tamanho: 6" / "Estoque: 2" / "Tamanhos com estoque: 4, 6, 8"
 * Retorna array de { title, sizes, stock } para usar em follow-up de estoque.
 */
function buildCompactRawProduct(product = {}) {
  return {
    id: product.id || '',
    title: product.title || '',
    price: product.price || '',
    url: product.url || '',
    stock: getProductAvailableStock(product),
    category: product.category || product.categoryName || product.categoria_nome || '',
    description: product.description ? String(product.description).slice(0, 300) : '',
    sizes: Array.isArray(product._sizes) ? product._sizes : extractProductSizes(product),
    availableSizes: getAvailableProductSizes(product),
    colors: getAvailableProductVariationLabels(product).length
      ? getAvailableProductVariationLabels(product)
      : getDisplayColorVariations(product),
    variations: Array.isArray(product.variations) ? product.variations.slice(0, 30) : [],
    variationStocks: getProductVariationStockEntries(product).slice(0, 60)
  };
}

function buildProductContextProduct(product = {}, displayIndex = 1) {
  const sizes = Array.isArray(product._sizes) ? product._sizes : extractProductSizes(product);
  const availableSizes = getAvailableProductSizes(product);
  const colors = getAvailableProductVariationLabels(product).length
    ? getAvailableProductVariationLabels(product)
    : getDisplayColorVariations(product);
  return {
    displayIndex,
    id: product.id || '',
    title: product.title || '',
    price: product.price || '',
    url: product.url || '',
    stock: getProductAvailableStock(product),
    sizes,
    availableSizes,
    colors,
    variations: Array.isArray(product.variations) ? product.variations : [],
    variationStocks: getProductVariationStockEntries(product),
    rawProduct: buildCompactRawProduct(product)
  };
}

function normalizeRecentProductDataList(value = []) {
  if (!Array.isArray(value)) return [];
  return value
    .map((product, index) => {
      if (!product || typeof product !== 'object') return null;
      return {
        displayIndex: Number(product.displayIndex || product.display_index || index + 1),
        id: product.id || '',
        title: product.title || '',
        price: product.price || '',
        url: product.url || '',
        stock: getStockNumber(firstValue(product.stock, product.total_estoque, product.quantity, null)),
        sizes: Array.isArray(product.sizes) ? product.sizes.map(String).filter(Boolean) : [],
        availableSizes: Array.isArray(product.availableSizes) ? product.availableSizes.map(String).filter(Boolean) : [],
        colors: Array.isArray(product.colors) ? product.colors.map(String).filter(Boolean) : [],
        variations: Array.isArray(product.variations) ? product.variations.map(String).filter(Boolean) : [],
        variationStocks: getProductVariationStockEntries(product).length
          ? getProductVariationStockEntries(product)
          : (Array.isArray(product.variationStocks) ? product.variationStocks : []),
        rawProduct: product.rawProduct || null
      };
    })
    .filter(isReliableProductMemoryItem);
}

function filtersFromCustomerIntent(customerIntent = {}, message = '') {
  const entities = customerIntent.entities || {};
  const filters = customerIntent.filters || {};
  const requestedSizes = extractRequestedSizes(message);
  const colorTokens = getColorTokens(getSearchTokens(message));
  return {
    size: String(entities.size || filters.size || requestedSizes[0] || '').trim(),
    color: String(entities.color || filters.color || colorTokens[0] || '').trim(),
    variation: String(entities.variation || filters.variation || '').trim()
  };
}

function isStockAvailabilityFollowUp(message = '') {
  const text = normalizeSearchText(message);
  if (!text) return false;
  const hasSize = extractRequestedSizes(message).length > 0;
  const hasColor = getColorTokens(getSearchTokens(message)).length > 0
    || PRODUCT_COLOR_TOKENS.some(color => new RegExp(`\\b${color}\\b`, 'i').test(text));
  const asksQuantity = /\b(quantas|quantos|quanta|quanto|qtd|quantidade)\b/i.test(text);
  const asksAvailability = /\b(tem|teria|possui|disponivel|disponiveis|estoque|peca|pecas)\b/i.test(text);
  const referencesRecent = /\b(esse|essa|desse|dessa|modelo|primeiro|primeira|segundo|segunda|terceiro|terceira|quarto|quarta|quinto|quinta|opcao|produto|item)\b/i.test(text);
  const shortSizeFollowup = hasSize && text.split(' ').filter(Boolean).length <= 5;
  return asksQuantity || shortSizeFollowup || (hasSize && asksAvailability) || (hasColor && asksAvailability) || (referencesRecent && asksAvailability);
}

function isSelectedProductFollowUp(message = '') {
  const text = normalizeSearchText(message);
  if (!text) return false;
  return /\b(outros tamanhos|outro tamanho|demais tamanhos|cada tamanho|por tamanho|todos tamanhos|todos os tamanhos|outras cores|outra cor|cores|desse|dessa|desse modelo|dessa opcao)\b/i.test(text);
}

function isSelectedProductPurchaseIntent(message = '') {
  const text = normalizeSearchText(message);
  if (!text) return false;
  return /^(quero|quero esse|quero essa|quero esse produto|quero essa peca|quero comprar|vou querer|fico com esse|fico com essa|pode separar|separa pra mim|reserva|reservar|fechar|fechar pedido|comprar|como faco pra comprar|como faço pra comprar)$/i.test(text)
    || /\b(quero esse|quero essa|vou querer esse|vou querer essa|fico com esse|fico com essa|pode separar|separa pra mim|reservar esse|reservar essa|fechar pedido|comprar esse|comprar essa|como faco pra comprar|como faço pra comprar)\b/i.test(text);
}

function isExplicitNewProductRequest(message = '') {
  const text = normalizeSearchText(message);
  if (!text) return false;
  const hasProductNoun = /\b(produto|produtos|roupa|roupas|vestido|vestidos|conjunto|conjuntos|blusa|blusas|body|bodys|calca|calcas|macacao|jardineira|saia|saias|short|shorts|camiseta|camisetas|camisa|camisas|tshirt|cropped|moletom|moletons|moleton|pijama|pijamas|regata|regatas|jaqueta|jaquetas|casaco|casacos)\b/i.test(text);
  const hasSearchVerb = /\b(tem|vende|vendem|quero|queria|procuro|busco|preciso|gostaria)\b/i.test(text);
  const hasSpecificModifier = getSpecificProductTokens(getSearchTokens(message)).length >= 2;
  return hasProductNoun && (hasSearchVerb || hasSpecificModifier);
}

function buildStockFollowupIntentFromMessage(message = '', conversationHistory = [], reason = 'stock_followup', conversation = {}) {
  const recentProducts = getReliableRecentProductStockContext(conversationHistory, conversation);
  const selectedMemory = getSelectedProductMemory(conversation);
  const pendingSelection = getPendingProductSelectionMemory(conversation);
  if (recentProducts.length === 0 && !selectedMemory && !pendingSelection) return null;
  const requestedSizes = extractRequestedSizes(message);
  const colorTokens = getColorTokens(getSearchTokens(message));
  const selectedIndex = extractProductIndexReference(message);
  console.log('[STOCK FOLLOWUP DETECTED] size=' + (requestedSizes.join(',') || '') + ' color=' + (colorTokens.join(',') || '') + ' reason=' + reason);
  return {
    intent: 'product_stock_followup',
    source: 'recent_context',
    search_query: '',
    semantic_query: '',
    product_type: '',
    theme: '',
    allow_related_products: false,
    filters: {
      size: requestedSizes.join(','),
      color: colorTokens.join(','),
      category: ''
    },
    order_id: '',
    tracking_id: '',
    reference: 'recent_products',
    selected_product_index: selectedIndex,
    needs_clarification: !selectedMemory && !selectedIndex && recentProducts.length > 1,
    clarification_question: !selectedMemory && !selectedIndex && recentProducts.length > 1 ? 'Voce quer saber de qual opcao?' : '',
    question_type: 'stock_by_size_color',
    sources_needed: ['recent_products'],
    entities: {
      product: '',
      product_id: '',
      size: requestedSizes.join(','),
      color: colorTokens.join(','),
      theme: '',
      category: '',
      order_id: '',
      date: '',
      location: ''
    },
    operation: 'calculate'
  };
}

function coerceStockFollowupIntent(customerIntent = {}, message = '', conversationHistory = [], conversation = {}) {
  if (!isStockAvailabilityFollowUp(message)) return customerIntent;
  if (isExplicitNewProductRequest(message)) {
    console.log('[STOCK FOLLOWUP COERCE SKIP] reason=explicit_new_product_request');
    if (customerIntent.intent === 'product_stock_followup' || customerIntent.question_type === 'stock_by_size_color') {
      const productSearchPhrase = customerIntent.search_query || getProductSearchPhrase(message);
      const requestedSizes = extractRequestedSizes(message);
      const colorTokens = getColorTokens(getSearchTokens(message));
      const product = customerIntent.entities?.product || productSearchPhrase;
      const theme = customerIntent.theme || customerIntent.entities?.theme || '';
      console.log('[STOCK FOLLOWUP COERCE OVERRIDE] reason=explicit_new_product_request query="' + productSearchPhrase + '"');
      return {
        ...customerIntent,
        intent: 'product_search',
        source: 'product_api',
        search_query: productSearchPhrase,
        semantic_query: customerIntent.semantic_query || 'produto da categoria solicitada com tema/personagem informado',
        product_type: customerIntent.product_type || product,
        theme,
        allow_related_products: customerIntent.allow_related_products === true,
        filters: {
          size: requestedSizes.join(','),
          color: colorTokens.join(','),
          category: customerIntent.filters?.category || ''
        },
        question_type: 'product_search',
        sources_needed: ['product_api'],
        reference: 'none',
        selected_product_index: null,
        needs_clarification: false,
        clarification_question: '',
        operation: 'search',
        entities: {
          ...(customerIntent.entities || {}),
          product,
          size: requestedSizes.join(','),
          color: colorTokens.join(','),
          theme
        }
      };
    }
    return customerIntent;
  }
  const recentProducts = getReliableRecentProductStockContext(conversationHistory, conversation);
  if (recentProducts.length === 0) return customerIntent;
  if (customerIntent.intent === 'product_stock_followup' || customerIntent.question_type === 'stock_by_size_color') {
    return {
      ...customerIntent,
      intent: 'product_stock_followup',
      source: 'recent_context',
      search_query: '',
      semantic_query: '',
      question_type: 'stock_by_size_color',
      sources_needed: ['recent_products'],
      reference: 'recent_products',
      operation: 'calculate',
      entities: {
        ...(customerIntent.entities || {}),
        product: '',
        size: String(customerIntent.entities?.size || customerIntent.filters?.size || extractRequestedSizes(message).join(',') || ''),
        color: String(customerIntent.entities?.color || customerIntent.filters?.color || getColorTokens(getSearchTokens(message)).join(',') || '')
      }
    };
  }
  return buildStockFollowupIntentFromMessage(message, conversationHistory, 'coerced_from_' + (customerIntent.intent || 'unknown'), conversation) || customerIntent;
}

function labelMatchesStockFilters(label, filters = {}) {
  const text = normalizeSearchText(label);
  if (!text) return { matchedAll: false, matchedAny: false };
  const wanted = [filters.size, filters.color, filters.variation]
    .map(normalizeSearchText)
    .filter(Boolean);
  if (wanted.length === 0) return { matchedAll: true, matchedAny: true };
  const matches = wanted.map(value => value.split(' ').filter(Boolean).every(token => includesToken(text, token)));
  return {
    matchedAll: matches.every(Boolean),
    matchedAny: matches.some(Boolean)
  };
}

function listIncludesNormalized(values = [], wanted = '') {
  const target = normalizeSizeToken(wanted) || normalizeSearchText(wanted);
  if (!target) return false;
  return (Array.isArray(values) ? values : [])
    .map(value => normalizeSizeToken(value) || normalizeSearchText(value))
    .some(value => value === target || (target.length > 2 && includesToken(value, target)));
}

function getStockForFilters(product = {}, filters = {}) {
  const normalizedFilters = {
    size: normalizeSizeToken(filters.size) || normalizeSearchText(filters.size),
    color: normalizeSearchText(filters.color),
    variation: normalizeSearchText(filters.variation)
  };
  const hasSpecificFilter = Boolean(normalizedFilters.size || normalizedFilters.color || normalizedFilters.variation);
  const variationEntries = getProductVariationStockEntries(product);
  const totalStock = getStockNumber(firstValue(product.stock, product.estoque, product.total_estoque, product.quantity, product.rawProduct?.stock, null));
  const hasPositiveTotalStock = Number(totalStock) > 0;
  const availableSizes = Array.isArray(product.availableSizes) && product.availableSizes.length
    ? product.availableSizes
    : getAvailableProductSizes(product);
  const sizes = Array.isArray(product.sizes) && product.sizes.length ? product.sizes : extractProductSizes(product);
  const sizeFound = normalizedFilters.size && (listIncludesNormalized(availableSizes, normalizedFilters.size) || listIncludesNormalized(sizes, normalizedFilters.size));
  const colors = Array.isArray(product.colors) ? product.colors : [];
  const variations = Array.isArray(product.variations) ? product.variations : [];
  const colorFound = normalizedFilters.color && (listIncludesNormalized(colors, normalizedFilters.color) || listIncludesNormalized(variations, normalizedFilters.color));
  let explicitZeroMatch = null;

  for (const entry of variationEntries) {
    const match = labelMatchesStockFilters(entry.label, normalizedFilters);
    if (match.matchedAll && entry.stock !== null && entry.stock !== undefined) {
      const quantity = Number(entry.stock);
      if (quantity > 0) {
        return { quantity, confidence: 'exact', matchedVariation: entry.label || '', messageHint: '', reason: 'explicit_variation_stock' };
      }
      explicitZeroMatch = { quantity: 0, confidence: 'exact', matchedVariation: entry.label || '', messageHint: '', reason: 'explicit_variation_zero' };
    }
  }

  if (sizeFound && hasPositiveTotalStock) {
    return {
      quantity: Number(totalStock),
      confidence: normalizedFilters.color && colorFound ? 'partial' : 'total_only',
      matchedVariation: '',
      messageHint: '',
      reason: normalizedFilters.color && colorFound ? 'size_color_found_total_stock_only' : 'size_found_total_stock_only'
    };
  }

  if (hasSpecificFilter) {
    const partialEntry = variationEntries.find(entry => {
      const match = labelMatchesStockFilters(entry.label, normalizedFilters);
      return match.matchedAny && Number(entry.stock) > 0;
    });
    if (partialEntry) {
      return { quantity: Number(partialEntry.stock), confidence: 'partial', matchedVariation: partialEntry.label || '', messageHint: '', reason: 'partial_variation_stock' };
    }
  }

  const rawProducts = [product.rawProduct, product.raw_product].filter(Boolean);
  for (const rawProduct of rawProducts) {
    const rawEntries = [
      rawProduct.variacoes,
      rawProduct.variations,
      rawProduct.tamanhos,
      rawProduct.sizes,
      rawProduct.variationStocks
    ].flatMap(getVariationStockEntries);
    for (const entry of rawEntries) {
      const match = labelMatchesStockFilters(entry.label, normalizedFilters);
      if (match.matchedAll && entry.stock !== null && entry.stock !== undefined) {
        const quantity = Number(entry.stock);
        if (quantity > 0) {
          return { quantity, confidence: 'exact', matchedVariation: entry.label || '', messageHint: '', reason: 'explicit_raw_variation_stock' };
        }
        explicitZeroMatch = { quantity: 0, confidence: 'exact', matchedVariation: entry.label || '', messageHint: '', reason: 'explicit_variation_zero' };
      }
    }
  }

  if (explicitZeroMatch && !hasPositiveTotalStock) {
    return explicitZeroMatch;
  }

  if (normalizedFilters.size && !sizeFound) {
    return { quantity: null, confidence: 'unknown', matchedVariation: '', messageHint: '', reason: 'requested_size_not_found' };
  }

  if (totalStock !== null && totalStock !== undefined) {
    return { quantity: Number(totalStock), confidence: hasSpecificFilter ? 'total_only' : 'exact', matchedVariation: '', messageHint: '', reason: hasSpecificFilter ? 'total_stock_only' : 'total_stock_no_filter' };
  }

  return { quantity: null, confidence: 'unknown', matchedVariation: '', messageHint: '', reason: 'no_stock_data' };
}

function extractProductIndexReference(message = '') {
  if (/^\s*\d{1,2}\s*$/.test(String(message || ''))) return Number(String(message || '').trim());
  const text = normalizeSearchText(message);
  const directNumber = text.match(/\b(?:opcao|produto|modelo|item)\s*(\d{1,2})\b/)?.[1];
  if (directNumber) return Number(directNumber);
  const contextualNumber = text.match(/^(?:e\s+)?(?:o|a|do|da)?\s*(\d{1,2})\b/)?.[1];
  if (contextualNumber && /\b(e|o|a|do|da)\b/i.test(text)) return Number(contextualNumber);
  const map = { primeiro: 1, primeira: 1, segundo: 2, segunda: 2, terceiro: 3, terceira: 3, quarto: 4, quarta: 4, quinto: 5, quinta: 5 };
  for (const [word, index] of Object.entries(map)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) return index;
  }
  return null;
}

function buildStockAnswerText(product, stockResult, filters = {}) {
  const title = product?.title ? ` desse modelo (${product.title})` : ' desse modelo';
  const sizeText = filters.size ? ` no tamanho ${filters.size}` : '';
  const colorText = filters.color ? ` ${filters.color}` : '';
  if (stockResult.confidence === 'exact') {
    return `Tenho ${stockResult.quantity} peca${Number(stockResult.quantity) === 1 ? '' : 's'}${title}${sizeText}${colorText}.`;
  }
  if (stockResult.confidence === 'partial') {
    const sizeColorText = [filters.size ? `tamanho ${filters.size}` : '', filters.color ? `cor ${filters.color}` : ''].filter(Boolean).join(' e ');
    return `Esse produto aparece${sizeColorText ? ` com ${sizeColorText}` : ''} e estoque total ${stockResult.quantity}, mas nao encontrei a separacao exata por variacao.`;
  }
  if (stockResult.confidence === 'total_only') {
    return filters.size
      ? `Esse produto aparece com tamanho ${filters.size} e estoque total ${stockResult.quantity}. Nao encontrei a quantidade separada por tamanho.`
      : `Esse produto aparece com estoque total ${stockResult.quantity}. Nao encontrei a quantidade separada por tamanho/cor.`;
  }
  return filters.size || filters.color
    ? 'Nao encontrei a quantidade exata desse tamanho/cor para esse produto.'
    : 'Nao encontrei a quantidade exata desse produto.';
}

function getSelectedProductQuestionType(message = '', filters = {}) {
  const text = normalizeSearchText(message);
  if (/\b(cada tamanho|por tamanho|todos tamanhos|todos os tamanhos|quantos de cada tamanho|quantas de cada tamanho)\b/i.test(text)) return 'all_sizes';
  if (/\b(outros tamanhos|outro tamanho|demais tamanhos)\b/i.test(text)) return 'other_sizes';
  if (/\b(cor|cores|outras cores|outra cor)\b/i.test(text)) return 'colors';
  if (filters.size) return 'stock_by_size';
  return 'stock_total';
}

function formatList(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).map(item => item.trim()).filter(Boolean))].join(', ');
}

function answerSelectedProductQuestion(message = '', selectedProduct = {}, filters = {}) {
  const questionType = getSelectedProductQuestionType(message, filters);
  const totalStock = getStockNumber(firstValue(selectedProduct.stock, selectedProduct.total_estoque, selectedProduct.quantity, selectedProduct.rawProduct?.stock, null));
  const sizes = (Array.isArray(selectedProduct.availableSizes) && selectedProduct.availableSizes.length)
    ? selectedProduct.availableSizes
    : (Array.isArray(selectedProduct.sizes) ? selectedProduct.sizes : []);
  const colors = Array.isArray(selectedProduct.colors) ? selectedProduct.colors : [];
  const variationEntries = getProductVariationStockEntries(selectedProduct);
  const sizeStockMap = new Map();
  variationEntries
    .map(entry => {
      const size = normalizeSearchText(entry.label).match(/\b(\d{1,2}|pp|p|m|g|gg|xg|xgg)\b/i)?.[1] || '';
      return size && entry.stock !== null && entry.stock !== undefined ? { size: normalizeSizeToken(size) || size, stock: Number(entry.stock) } : null;
    })
    .filter(Boolean)
    .filter(entry => Number.isFinite(entry.stock))
    .forEach(entry => {
      sizeStockMap.set(entry.size, (sizeStockMap.get(entry.size) || 0) + entry.stock);
    });
  const sizeStockEntries = Array.from(sizeStockMap.entries()).map(([size, stock]) => ({ size, stock }));

  if (questionType === 'all_sizes' || questionType === 'other_sizes') {
    if (sizeStockEntries.length > 0) {
      const lines = sizeStockEntries.map(entry => `Tamanho ${entry.size}: ${entry.stock} peca${entry.stock === 1 ? '' : 's'}`);
      return {
        response: `Desse modelo encontrei:\n${lines.join('\n')}`,
        questionType,
        confidence: 'exact'
      };
    }
    if (sizes.length > 0 && totalStock !== null && totalStock !== undefined) {
      return {
        response: `Esse modelo aparece nos tamanhos ${formatList(sizes)}, com estoque total ${totalStock}. Nao encontrei a quantidade separada por cada tamanho.`,
        questionType,
        confidence: 'total_only'
      };
    }
    return {
      response: 'Nao encontrei a quantidade separada por tamanho para esse produto.',
      questionType,
      confidence: 'unknown'
    };
  }

  if (questionType === 'colors') {
    return {
      response: colors.length > 0
        ? `Esse modelo aparece nas cores ${formatList(colors)}.`
        : 'Nao encontrei as cores disponiveis desse produto.',
      questionType,
      confidence: colors.length > 0 ? 'partial' : 'unknown'
    };
  }

  const stockResult = getStockForFilters(selectedProduct, filters);
  return {
    response: buildStockAnswerText(selectedProduct, stockResult, filters),
    questionType,
    confidence: stockResult.confidence,
    stockResult
  };
}

function buildSelectedProductPurchaseResponse(selectedProduct = {}, filters = {}) {
  const title = String(selectedProduct.title || 'esse produto').trim();
  const sizeText = filters?.size ? ` tamanho ${filters.size}` : '';
  const colorText = filters?.color ? ` cor ${filters.color}` : '';
  const detailText = [sizeText, colorText].filter(Boolean).join(' e');
  const url = String(selectedProduct.url || selectedProduct.link || selectedProduct.publicUrl || '').trim();
  const lines = [
    `Perfeito, deixei anotado: ${title}${detailText}.`,
    url ? `Para comprar, toque no botao Ver produto ou acesse: ${url}` : 'Para comprar, toque no botao Ver produto do card ou me diga a quantidade que deseja.',
    'Se quiser, posso verificar outro tamanho ou outra opcao antes de fechar.'
  ];
  return lines.join('\n');
}

function buildRecentProductStockAnswer(customerIntent = {}, message = '', conversationHistory = [], conversation = {}) {
  const recentProducts = getReliableRecentProductStockContext(conversationHistory, conversation);
  console.log('[RECENT PRODUCTS DATA] count=' + recentProducts.length);

  const selectedIndex = customerIntent.selected_product_index !== null && customerIntent.selected_product_index !== undefined
    ? Number(customerIntent.selected_product_index)
    : extractProductIndexReference(message);
  let filters = filtersFromCustomerIntent(customerIntent, message);
  const pendingFilters = getPendingStockFilters(conversation);
  if (!filters.size && pendingFilters.size) filters = { ...filters, size: pendingFilters.size };
  if (!filters.color && pendingFilters.color) filters = { ...filters, color: pendingFilters.color };
  if (!filters.variation && pendingFilters.variation) filters = { ...filters, variation: pendingFilters.variation };
  const pendingSelection = getPendingProductSelectionMemory(conversation);
  if (selectedIndex && pendingSelection?.options?.length) {
    const pendingProduct = pendingSelection.options.find(item => Number(item.displayIndex) === selectedIndex)
      || pendingSelection.options[selectedIndex - 1];
    if (pendingProduct) {
      const mergedFilters = {
        ...filters,
        ...Object.fromEntries(Object.entries(pendingSelection.pendingFilters || {}).filter(([, value]) => value))
      };
      console.log('[PENDING PRODUCT SELECTION USE] selectedIndex=' + selectedIndex + ' title="' + String(pendingProduct.title || '').replace(/"/g, '\\"') + '"');
      saveSelectedProductMemory(conversation, pendingProduct, selectedIndex, mergedFilters);
      pendingProductSelectionByConversation.delete(getConversationMemoryKey(conversation));
      const selectedAnswer = answerSelectedProductQuestion(message, pendingProduct, mergedFilters);
      console.log('[SELECTED PRODUCT ANSWER] question_type=' + selectedAnswer.questionType + ' confidence=' + selectedAnswer.confidence);
      if (selectedAnswer.stockResult) {
        console.log('[STOCK FILTER RESULT] confidence=' + selectedAnswer.stockResult.confidence + ' quantity=' + (selectedAnswer.stockResult.quantity === null || selectedAnswer.stockResult.quantity === undefined ? '' : selectedAnswer.stockResult.quantity) + ' reason=' + (selectedAnswer.stockResult.reason || ''));
      }
      return {
        response: selectedAnswer.response,
        model: 'selected_product_stock',
        product: pendingProduct,
        stockResult: selectedAnswer.stockResult || { confidence: selectedAnswer.confidence }
      };
    }
  }
  const selectedMemory = getSelectedProductMemory(conversation);
  if (selectedMemory && !selectedIndex) {
    if (!filters.size && selectedMemory.lastFilters?.size) filters = { ...filters, size: selectedMemory.lastFilters.size };
    if (!filters.color && selectedMemory.lastFilters?.color) filters = { ...filters, color: selectedMemory.lastFilters.color };
    const selectedAnswer = answerSelectedProductQuestion(message, selectedMemory.product, filters);
    console.log('[SELECTED PRODUCT ANSWER] question_type=' + selectedAnswer.questionType + ' confidence=' + selectedAnswer.confidence);
    if (selectedAnswer.stockResult) {
      console.log('[STOCK FILTER RESULT] confidence=' + selectedAnswer.stockResult.confidence + ' quantity=' + (selectedAnswer.stockResult.quantity === null || selectedAnswer.stockResult.quantity === undefined ? '' : selectedAnswer.stockResult.quantity) + ' reason=' + (selectedAnswer.stockResult.reason || ''));
    }
    return {
      response: selectedAnswer.response,
      model: 'selected_product_stock',
      product: selectedMemory.product,
      stockResult: selectedAnswer.stockResult || { confidence: selectedAnswer.confidence }
    };
  }

  if (recentProducts.length === 0) return null;

  const product = selectedIndex
    ? recentProducts.find(item => Number(item.displayIndex) === selectedIndex)
    : recentProducts.length === 1
      ? recentProducts[0]
      : null;

  if (!product) {
    savePendingStockFilters(conversation, filters);
    const pendingOptions = savePendingProductSelectionMemory(conversation, recentProducts, filters, 5)
      || buildPendingProductSelectionOptions(recentProducts, 5);
    return {
      response: buildProductSelectionList(pendingOptions.map(item => item.title).filter(Boolean)),
      model: 'recent_product_selection'
    };
  }

  saveSelectedProductMemory(conversation, product, selectedIndex || product.displayIndex || null, filters);
  const selectedAnswer = answerSelectedProductQuestion(message, product, filters);
  if (selectedAnswer.questionType !== 'stock_total' || !filters.size) {
    console.log('[SELECTED PRODUCT ANSWER] question_type=' + selectedAnswer.questionType + ' confidence=' + selectedAnswer.confidence);
    if (selectedAnswer.stockResult) {
      console.log('[STOCK FILTER RESULT] confidence=' + selectedAnswer.stockResult.confidence + ' quantity=' + (selectedAnswer.stockResult.quantity === null || selectedAnswer.stockResult.quantity === undefined ? '' : selectedAnswer.stockResult.quantity) + ' reason=' + (selectedAnswer.stockResult.reason || ''));
    }
    return {
      response: selectedAnswer.response,
      model: 'selected_product_stock',
      product,
      stockResult: selectedAnswer.stockResult || { confidence: selectedAnswer.confidence }
    };
  }

  const stockResult = getStockForFilters(product, filters);
  console.log('[STOCK FILTER RESULT] confidence=' + stockResult.confidence + ' quantity=' + (stockResult.quantity === null || stockResult.quantity === undefined ? '' : stockResult.quantity) + ' reason=' + (stockResult.reason || ''));
  return {
    response: buildStockAnswerText(product, stockResult, filters),
    model: 'recent_product_stock',
    product,
    stockResult
  };
}

function isOrderLikeRecentProductLine(value = '') {
  const text = normalizeSearchText(value);
  if (!text) return true;
  if (/\b(certo me diga|me diga o que voce quer consultar|como posso ajudar|claro de qual produto|voce quer saber de qual opcao)\b/i.test(text)) return true;
  return /\b(pedido|codigo interno|codigo|cliente|total|entrega|status|pagamento|rastreio|integracao|transportadora|sedex|pac|forma entrega|forma_entrega|despachado|separacao|separado|entregue)\b/i.test(text)
    || /\b(desse modelo encontrei|nao encontrei|não encontrei|no momento|quer que eu|posso procurar|posso buscar|de qual produto|qual opcao|atendente|pode me mandar|o endereco|esse produto aparece)\b/i.test(text)
    || /^\s*tenho\s+\d+\s+peca/i.test(text)
    || /^\s*tamanho\s+\w+\s*:/i.test(text);
}

function isBotStockResponseLine(value = '') {
  const text = normalizeSearchText(value);
  if (!text) return true;
  return /\b(desse modelo encontrei|nao encontrei|não encontrei|posso procurar|quer que eu|esse produto aparece)\b/i.test(text)
    || /^\s*tamanho\s+\w+\s*:/i.test(text)
    || /^\s*tenho\s+\d+\s+peca/i.test(text);
}

function hasProductLineSignal(value = '') {
  const raw = String(value || '');
  const text = normalizeSearchText(raw);
  if (!text || isOrderLikeRecentProductLine(raw)) return false;
  const hasProductWord = /\b(saia|short|vestido|conjunto|blusa|body|calca|macacao|jardineira|camiseta|cropped|tshirt|moletom|moleton|camisa|bermuda|jaqueta|casaco|manga|bone|pijama|regata|produto)\b/i.test(text);
  const hasCardSignal = /🛍|produto\/\d+|#produto\d+|preco:|pre[cç]o:|tamanho:|cor:|estoque:|detalhes:/i.test(raw);
  const hasProductSummary = /^encontrei\s+.+\s+na loja/i.test(raw) && !/\b(pedido|integracao)\b/i.test(text);
  return hasCardSignal || hasProductSummary || (hasProductWord && /\b(preco|tamanho|cor|estoque|detalhes)\b/i.test(text));
}

function isReliableProductMemoryItem(product = {}) {
  const title = String(product?.title || '').trim();
  if (!title || isOrderLikeRecentProductLine(title) || isBotStockResponseLine(title)) return false;
  const evidenceText = [
    title,
    product.price,
    product.url,
    product.stock,
    ...(Array.isArray(product.sizes) ? product.sizes : []),
    ...(Array.isArray(product.availableSizes) ? product.availableSizes : []),
    ...(Array.isArray(product.variations) ? product.variations : [])
  ].filter(value => value !== null && value !== undefined && String(value).trim()).join(' ');
  const hasStructuredProductData = Boolean(
    product.id
    || product.url
    || product.rawProduct
    || product.price
    || product.stock !== null && product.stock !== undefined
    || (Array.isArray(product.sizes) && product.sizes.length > 0)
    || (Array.isArray(product.availableSizes) && product.availableSizes.length > 0)
    || (Array.isArray(product.variations) && product.variations.length > 0)
  );
  return hasProductLineSignal(evidenceText) || hasStructuredProductData;
}

function cleanRecentProductTitleLine(value = '') {
  return String(value || '')
    .replace(/^🛍️?\s*/u, '')
    .replace(/^ðŸ›ï¸?\s*/u, '')
    .replace(/^\u2022\s*/, '')
    .replace(/^â€¢\s*/, '')
    .replace(/^\d+\.\s*/, '')
    .replace(/\s*-\s*foto\s*\d+$/i, '')
    .replace(/\s*[-—â€”]\s*R\$\s*[\d.,]+$/i, '')
    .replace(/^encontrei\s+/i, '')
    .replace(/\s+na loja\.?$/i, '')
    .trim();
}

function logRecentProductOptions(products = []) {
  products.slice(0, 8).forEach(product => {
    console.log('[RECENT PRODUCT OPTION] index=' + product.displayIndex + ' title="' + String(product.title || '').replace(/"/g, '\\"') + '"');
  });
}

function getConversationMemoryKey(conversation = {}) {
  return conversation?.id ? String(conversation.id) : '';
}

function savePendingStockFilters(conversation = {}, filters = {}) {
  const key = getConversationMemoryKey(conversation);
  if (!key) return;
  pendingStockFiltersByConversation.set(key, {
    filters: {
      size: String(filters.size || '').trim(),
      color: String(filters.color || '').trim(),
      variation: String(filters.variation || '').trim()
    },
    createdAt: Date.now()
  });
}

function getPendingStockFilters(conversation = {}) {
  const key = getConversationMemoryKey(conversation);
  if (!key) return {};
  const entry = pendingStockFiltersByConversation.get(key);
  if (!entry) return {};
  if (Date.now() - Number(entry.createdAt || 0) > RECENT_PRODUCTS_MEMORY_TTL_MS) {
    pendingStockFiltersByConversation.delete(key);
    return {};
  }
  return entry.filters || {};
}

function saveSelectedProductMemory(conversation = {}, product = {}, selectedProductIndex = null, filters = {}) {
  const key = getConversationMemoryKey(conversation);
  if (!key || !product?.title) return;
  if (!isReliableProductMemoryItem(product)) {
    console.log('[SELECTED PRODUCT REJECT] reason=unreliable_product title="' + String(product.title || '').replace(/"/g, '\\"') + '"');
    return;
  }
  selectedProductByConversation.set(key, {
    product,
    selectedProductIndex,
    selectedAt: Date.now(),
    ttlMs: RECENT_PRODUCTS_MEMORY_TTL_MS,
    lastFilters: {
      size: String(filters.size || '').trim(),
      color: String(filters.color || '').trim(),
      variation: String(filters.variation || '').trim()
    }
  });
  console.log('[SELECTED PRODUCT SAVE] conv=' + key + ' index=' + (selectedProductIndex || '') + ' title="' + String(product.title || '').replace(/"/g, '\\"') + '"');
}

function getSelectedProductMemory(conversation = {}) {
  const key = getConversationMemoryKey(conversation);
  if (!key) return null;
  const entry = selectedProductByConversation.get(key);
  if (!entry) return null;
  if (Date.now() - Number(entry.selectedAt || 0) > Number(entry.ttlMs || RECENT_PRODUCTS_MEMORY_TTL_MS)) {
    selectedProductByConversation.delete(key);
    return null;
  }
  if (!isReliableProductMemoryItem(entry.product)) {
    selectedProductByConversation.delete(key);
    console.log('[SELECTED PRODUCT CLEAR] reason=unreliable_product');
    return null;
  }
  if (entry.product?.title) {
    console.log('[SELECTED PRODUCT SOURCE] source=selected_cache title="' + String(entry.product.title || '').replace(/"/g, '\\"') + '"');
    return entry;
  }
  return null;
}

function buildPendingProductSelectionOptions(products = [], limit = 5) {
  return (Array.isArray(products) ? products : [])
    .filter(isReliableProductMemoryItem)
    .slice(0, limit)
    .map((product, index) => ({
      ...product,
      displayIndex: index + 1
    }));
}

function savePendingProductSelectionMemory(conversation = {}, products = [], pendingFilters = {}, limit = 5) {
  const key = getConversationMemoryKey(conversation);
  const totalCandidates = Array.isArray(products) ? products.length : 0;
  const options = buildPendingProductSelectionOptions(products, limit);
  if (!key || options.length === 0) return;
  pendingProductSelectionByConversation.set(key, {
    options,
    pendingFilters,
    createdAt: Date.now(),
    ttlMs: RECENT_PRODUCTS_MEMORY_TTL_MS
  });
  console.log('[PENDING PRODUCT SELECTION SAVE] conv=' + key + ' count=' + options.length + ' totalCandidates=' + totalCandidates + ' limit=' + limit);
  return options;
}

function getPendingProductSelectionMemory(conversation = {}) {
  const key = getConversationMemoryKey(conversation);
  if (!key) return null;
  const entry = pendingProductSelectionByConversation.get(key);
  if (!entry) return null;
  if (Date.now() - Number(entry.createdAt || 0) > Number(entry.ttlMs || RECENT_PRODUCTS_MEMORY_TTL_MS)) {
    pendingProductSelectionByConversation.delete(key);
    return null;
  }
  entry.options = (entry.options || []).filter(isReliableProductMemoryItem).map((product, index) => ({ ...product, displayIndex: index + 1 }));
  if (entry.options.length === 0) {
    pendingProductSelectionByConversation.delete(key);
    console.log('[PENDING PRODUCT SELECTION CLEAR] reason=no_reliable_options');
    return null;
  }
  return entry;
}

function getPlannerMemoryEntry(map, key) {
  if (!key || !map || typeof map.get !== 'function') return null;
  const entry = map.get(key);
  if (!entry) return null;
  const ttlMs = Number(entry.ttlMs || RECENT_PRODUCTS_MEMORY_TTL_MS);
  const createdAt = Number(entry.createdAt || entry.selectedAt || 0);
  if (createdAt && Date.now() - createdAt > ttlMs) return null;
  return entry;
}

function summarizePlannerHistory(conversationHistory = []) {
  return (Array.isArray(conversationHistory) ? conversationHistory : [])
    .slice(-8)
    .map(item => {
      const author = (item.direction === 'out' || item.is_from_ai) ? 'Atendente/IA' : 'Cliente';
      return `${author}: ${String(item.content || '').replace(/\s+/g, ' ').trim().slice(0, 160)}`;
    })
    .filter(line => line.trim() !== 'Cliente:' && line.trim() !== 'Atendente/IA:')
    .join('\n')
    .slice(0, 1200);
}

function buildPlannerProductSnapshot(product = {}, index = 1) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const rawProduct = safeProduct.rawProduct || safeProduct.raw_product || {};
  return {
    index: Number(safeProduct.displayIndex || safeProduct.display_index || index),
    id: String(safeProduct.id || rawProduct.id || ''),
    title: String(safeProduct.title || rawProduct.title || ''),
    price: String(safeProduct.price || rawProduct.price || ''),
    stock: firstValue(safeProduct.stock, safeProduct.total_estoque, safeProduct.quantity, rawProduct.stock, ''),
    sizes: Array.isArray(safeProduct.sizes) && safeProduct.sizes.length
      ? safeProduct.sizes.map(String).filter(Boolean).slice(0, 12)
      : extractProductSizes(safeProduct).map(String).filter(Boolean).slice(0, 12),
    availableSizes: Array.isArray(safeProduct.availableSizes) && safeProduct.availableSizes.length
      ? safeProduct.availableSizes.map(String).filter(Boolean).slice(0, 12)
      : getAvailableProductSizes(safeProduct).map(String).filter(Boolean).slice(0, 12),
    colors: Array.isArray(safeProduct.colors) && safeProduct.colors.length
      ? safeProduct.colors.map(String).filter(Boolean).slice(0, 12)
      : (getAvailableProductVariationLabels(safeProduct).length
        ? getAvailableProductVariationLabels(safeProduct)
        : getDisplayColorVariations(safeProduct)).map(String).filter(Boolean).slice(0, 12)
  };
}

function buildCompactPlannerState(conversationState = {}) {
  return {
    message: String(conversationState.message || ''),
    hasRecentProducts: Boolean(conversationState.hasRecentProducts),
    hasSelectedProduct: Boolean(conversationState.hasSelectedProduct),
    hasPendingAction: Boolean(conversationState.hasPendingAction),
    hasPendingSelection: Boolean(conversationState.hasPendingSelection),
    pendingActionType: String(conversationState.pendingActionType || ''),
    pendingSelectionCount: Number(conversationState.pendingSelectionCount || 0),
    recentProducts: (conversationState.recentProducts || []).slice(0, 5).map(product => ({
      index: product.index,
      id: product.id,
      title: product.title,
      stock: product.stock,
      availableSizes: (product.availableSizes || []).slice(0, 8),
      colors: (product.colors || []).slice(0, 8)
    })),
    selectedProduct: conversationState.hasSelectedProduct ? {
      id: conversationState.selectedProduct.id,
      title: conversationState.selectedProduct.title,
      stock: conversationState.selectedProduct.stock,
      availableSizes: (conversationState.selectedProduct.availableSizes || []).slice(0, 8),
      colors: (conversationState.selectedProduct.colors || []).slice(0, 8)
    } : null,
    availableSources: conversationState.availableSources || []
  };
}

function getPlannerProductSource(product = {}) {
  if (!product || typeof product !== 'object') return {};
  return product.rawProduct || product.raw_product || product;
}

function buildConversationStateForPlanner(context = {}) {
  const conversation = context.conversation || {};
  const contact = context.contact || {};
  const key = getConversationMemoryKey(conversation);
  const recentEntry = getPlannerMemoryEntry(recentProductsByConversation, key);
  const selectedEntry = getPlannerMemoryEntry(selectedProductByConversation, key);
  const pendingSelectionEntry = getPlannerMemoryEntry(pendingProductSelectionByConversation, key);
  const pendingActionEntry = getPlannerMemoryEntry(pendingActionByConversation, key);
  const pendingFiltersEntry = getPlannerMemoryEntry(pendingStockFiltersByConversation, key);
  const recentProducts = dedupeRecentProductContext(recentEntry?.products || [])
    .slice(0, 8)
    .map((product, index) => buildPlannerProductSnapshot(product, index + 1));
  const selectedProduct = selectedEntry?.product
    ? buildPlannerProductSnapshot(selectedEntry.product, selectedEntry.selectedProductIndex || 1)
    : null;

  return {
    conversationId: key,
    message: String(context.message || ''),
    contactPhone: String(contact.phone || contact.number || contact.whatsapp || ''),
    recentHistorySummary: summarizePlannerHistory(context.conversationHistory || []),
    hasRecentProducts: recentProducts.length > 0,
    recentProducts,
    hasSelectedProduct: Boolean(selectedProduct),
    selectedProduct: selectedProduct || {
      id: '',
      title: '',
      price: '',
      stock: '',
      sizes: [],
      availableSizes: [],
      colors: []
    },
    hasPendingSelection: Boolean(pendingSelectionEntry?.options?.length),
    pendingSelectionCount: Array.isArray(pendingSelectionEntry?.options) ? pendingSelectionEntry.options.length : 0,
    pendingSelectionOptions: Array.isArray(pendingSelectionEntry?.options)
      ? pendingSelectionEntry.options.slice(0, 5).map((product, index) => buildPlannerProductSnapshot(product, index + 1))
      : [],
    hasPendingAction: Boolean(pendingActionEntry?.type),
    pendingActionType: String(pendingActionEntry?.type || ''),
    pendingFilters: pendingFiltersEntry?.filters || {},
    availableSources: [
      'product_api',
      'order_api',
      'tracking_api',
      'knowledge_base',
      'site_urls',
      'files',
      'conversation_history',
      'recent_products',
      'selected_product'
    ]
  };
}

function sanitizePlannerTool(tool = {}) {
  const allowedTools = new Set([
    'get_recent_products',
    'get_selected_product',
    'get_pending_product_selection',
    'use_pending_action',
    'search_vector_knowledge',
    'search_config_knowledge',
    'search_vector_products',
    'search_product_api',
    'hydrate_products_from_api',
    'filter_products_by_size',
    'search_products',
    'semantic_search_products',
    'inspect_product',
    'inspect_product_variations',
    'get_product_stock',
    'get_order_status',
    'get_tracking',
    'search_knowledge_base',
    'search_site_sources',
    'search_files',
    'get_store_policy',
    'ask_clarification'
  ]);
  const name = String(tool.name || '').trim();
  if (!allowedTools.has(name)) return null;
  return {
    name,
    args: tool.args && typeof tool.args === 'object' && !Array.isArray(tool.args) ? tool.args : {},
    reason: String(tool.reason || '').slice(0, 180)
  };
}

function sanitizePlannerPlan(plan = {}) {
  const validAnswerTypes = new Set([
    'product_search',
    'product_info',
    'stock',
    'variation',
    'store_policy',
    'order',
    'tracking',
    'pending_confirmation',
    'selection',
    'general',
    'clarification'
  ]);
  const validConfidence = new Set(['high', 'medium', 'low']);
  const tools = Array.isArray(plan.tools) ? plan.tools.map(sanitizePlannerTool).filter(Boolean).slice(0, 5) : [];
  return {
    understanding: String(plan.understanding || '').slice(0, 220),
    answer_type: validAnswerTypes.has(plan.answer_type) ? plan.answer_type : 'general',
    confidence: validConfidence.has(plan.confidence) ? plan.confidence : 'low',
    needs_clarification: Boolean(plan.needs_clarification),
    clarification_question: String(plan.clarification_question || '').slice(0, 220),
    tools,
    expected_answer_strategy: String(plan.expected_answer_strategy || '').slice(0, 300)
  };
}

function buildDeterministicStorePolicyPlannerPlan(message = '') {
  const query = getStorePolicyKnowledgeQuery(message);
  if (!query) return null;
  console.log('[PLANNER SHADOW] deterministic=true reason=store_policy');
  const minimumOrderQuery = getMinimumOrderPolicyQuery(message);
  const shouldSearchSite = /\b(entrega|entregam|excursao|ponto de encontro|local de retirada|retirada|retirar|pessoalmente|endereco|motoboy|frete|envio|enviam|enviamos|todo brasil|brasil todo)\b/i.test(normalizeSearchText(message));
  const tools = [
    { name: 'search_vector_knowledge', args: { query, entity_type: 'store_policy' }, reason: 'recuperar evidencias semanticas do cliente atual' },
    { name: 'search_config_knowledge', args: { query }, reason: 'consultar configuracao e prompt do cliente atual' },
    { name: 'get_store_policy', args: { topic: query }, reason: 'pergunta sobre regra da loja' },
    { name: 'search_knowledge_base', args: { query }, reason: 'confirmar a regra nas fontes disponiveis' }
  ];
  if (shouldSearchSite || query) {
    tools.push({ name: 'search_site_sources', args: { query }, reason: 'confirmar informacao em fontes do site' });
  }
  return {
    understanding: minimumOrderQuery
      ? 'Cliente quer saber se pode comprar abaixo do pedido minimo.'
      : shouldSearchSite
        ? 'Cliente quer saber uma regra de entrega, retirada ou endereco da loja.'
        : 'Cliente quer saber uma regra de compra ou politica da loja.',
    answer_type: 'store_policy',
    confidence: 'high',
    needs_clarification: false,
    clarification_question: '',
    tools,
    expected_answer_strategy: 'Responder usando somente a politica encontrada nas fontes da loja.'
  };
}

function buildDeterministicContextualPlannerPlan(message = '', conversationState = {}) {
  if (!isShortContextualReply(message)) return null;
  if (conversationState.hasPendingAction) {
    return {
      understanding: 'Cliente esta confirmando a acao pendente.',
      answer_type: 'pending_confirmation',
      confidence: 'high',
      needs_clarification: false,
      clarification_question: '',
      tools: [{ name: 'use_pending_action', args: {}, reason: 'mensagem curta confirma a acao pendente' }],
      expected_answer_strategy: 'Executar a acao pendente e responder com evidencias reais.'
    };
  }
  if (conversationState.hasPendingSelection) {
    return {
      understanding: 'Cliente respondeu dentro de uma selecao pendente.',
      answer_type: 'selection',
      confidence: 'medium',
      needs_clarification: false,
      clarification_question: '',
      tools: [{ name: 'get_pending_product_selection', args: {}, reason: 'ha selecao de produto pendente' }],
      expected_answer_strategy: 'Usar a selecao pendente antes de qualquer busca nova.'
    };
  }
  if (conversationState.hasSelectedProduct) {
    return {
      understanding: 'Cliente confirmou algo sobre o produto ativo, mas falta a pergunta especifica.',
      answer_type: 'clarification',
      confidence: 'medium',
      needs_clarification: true,
      clarification_question: 'Claro. Me diz o que voce quer saber desse produto.',
      tools: [{ name: 'get_selected_product', args: {}, reason: 'ha produto ativo na conversa' }],
      expected_answer_strategy: 'Pedir o detalhe que falta antes de consultar dados do produto.'
    };
  }
  return {
    understanding: 'Cliente enviou uma confirmacao curta sem contexto pendente.',
    answer_type: 'clarification',
    confidence: 'high',
    needs_clarification: true,
    clarification_question: 'Claro 😊 Me diz qual produto ou informação você quer que eu veja.',
    tools: [{ name: 'ask_clarification', args: { topic: 'missing_context' }, reason: 'nao ha estado pendente para confirmar' }],
    expected_answer_strategy: 'Pedir contexto antes de buscar catalogo ou responder.'
  };
}

async function planCustomerRequestShadow(message, conversationState, config, provider, apiKey) {
  const contextualPlan = buildDeterministicContextualPlannerPlan(message, conversationState);
  if (contextualPlan) return contextualPlan;

  if (!isUsableProviderApiKey(provider, apiKey)) {
    console.log('[PLANNER SHADOW] skipped reason=no_api_key');
    return buildDeterministicStorePolicyPlannerPlan(message);
  }

  try {
    const compactState = buildCompactPlannerState(conversationState);
    const storeDisplayName = getStoreDisplayName(config || {});
    const plannerPrompt = `Planeje atendimento WhatsApp de ${storeDisplayName}. Nao responda ao cliente. Retorne somente JSON valido.
Schema: {"understanding":"","answer_type":"product_search|product_info|stock|variation|store_policy|order|tracking|pending_confirmation|selection|general|clarification","confidence":"high|medium|low","needs_clarification":false,"clarification_question":"","tools":[{"name":"get_selected_product","args":{},"reason":""}],"expected_answer_strategy":""}
Ferramentas: get_recent_products,get_selected_product,get_pending_product_selection,use_pending_action,search_vector_knowledge,search_config_knowledge,search_vector_products,search_product_api,hydrate_products_from_api,filter_products_by_size,search_products,semantic_search_products,inspect_product,inspect_product_variations,get_product_stock,get_order_status,get_tracking,search_knowledge_base,search_site_sources,search_files,get_store_policy,ask_clarification.
Regras: o planner semantico e a entrada principal. Nao dependa de palavra exata: frases como "manda pra Bahia?", "chega em outro estado?", "entregam no Brasil todo?", "posso comprar com CPF?", "como pago?" e "tem troca?" sao store_policy e devem usar search_vector_knowledge + search_config_knowledge + get_store_policy + search_knowledge_base/search_site_sources. "outras cores" => get_selected_product + inspect_product_variations; "tamanho informado" => get_selected_product/get_recent_products + get_product_stock; "numero de opcao" => get_pending_product_selection; confirmacao curta com acao pendente => use_pending_action; produto com tema/personagem/tamanho => search_vector_products + hydrate_products_from_api + filter_products_by_size, ou semantic_search_products se vetor de produto nao estiver ativo; preco/estoque/url/imagem de produto sempre precisam de search_product_api/hydrate_products_from_api ou memoria estruturada, nunca apenas vetor; pergunta sobre pedido com numero => get_order_status + get_tracking; confirmacao curta sem estado pendente => clarification + ask_clarification; se faltar contexto => ask_clarification.
Estado compacto: ${JSON.stringify(compactState)}`;

    const timeoutMs = Number(config?.planner_shadow_timeout_ms || 9000);
    const plannerModel = String(config?.planner_shadow_model || '').trim();
    let responseText = '';
    if (provider === 'claude') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: plannerModel || 'claude-3-haiku-20240307',
          max_tokens: 450,
          temperature: 0,
          messages: [{ role: 'user', content: plannerPrompt }]
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) throw new Error('planner_http_' + res.status);
      const data = await res.json().catch(() => null);
      responseText = data?.content?.[0]?.text || '';
    } else {
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: plannerModel || 'gpt-4o-mini',
          temperature: 0,
          max_output_tokens: 450,
          input: [{ role: 'user', content: [{ type: 'input_text', text: plannerPrompt }] }]
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) throw new Error('planner_http_' + res.status);
      const data = await res.json().catch(() => null);
      responseText = getOpenAIText(data) || '';
    }

    const parsed = JSON.parse(String(responseText || '').replace(/```json|```/g, '').trim());
    const plan = sanitizePlannerPlan(parsed);
    console.log('[PLANNER SEMANTIC] answer_type=' + plan.answer_type + ' confidence=' + plan.confidence + ' tools=' + plan.tools.map(tool => tool.name).join(','));
    return plan;
  } catch (error) {
    console.warn('[PLANNER SEMANTIC FALLBACK] reason=' + String(error?.message || error).slice(0, 180));
    return buildDeterministicStorePolicyPlannerPlan(message);
  }
}

function addPlannerToolStatus(evidenceBundle, name, status, reason) {
  const key = status === 'executed' ? 'tools_executed' : 'tools_skipped';
  evidenceBundle[key].push({ name, reason });
  console.log('[PLANNER TOOL] name=' + name + ' status=' + status + ' reason="' + escapeLogValue(reason || '') + '"');
}

function findPlannerProductForTool(tool = {}, conversationState = {}, context = {}) {
  const key = getConversationMemoryKey(context.conversation || {});
  const selectedEntry = getPlannerMemoryEntry(selectedProductByConversation, key);
  if (tool.args?.product_ref === 'selected' && selectedEntry?.product) return selectedEntry.product;
  if (selectedEntry?.product) return selectedEntry.product;
  const recentEntry = getPlannerMemoryEntry(recentProductsByConversation, key);
  const recentProducts = dedupeRecentProductContext(recentEntry?.products || []);
  const requestedIndex = Number(tool.args?.index || tool.args?.displayIndex || extractProductIndexReference(conversationState.message));
  if (requestedIndex) {
    return recentProducts.find(product => Number(product.displayIndex) === requestedIndex) || recentProducts[requestedIndex - 1] || null;
  }
  return recentProducts[0] || null;
}

function executePlannerToolsShadow(plan = {}, conversationState = {}, context = {}) {
  const evidenceBundle = {
    facts: [],
    products: [],
    product_cards_preview: [],
    missing_data: [],
    warnings: [],
    tools_executed: [],
    tools_skipped: []
  };
  const tools = Array.isArray(plan.tools) ? plan.tools : [];
  const key = getConversationMemoryKey(context.conversation || {});

  for (const tool of tools) {
    const name = tool.name;
    if (name === 'get_recent_products') {
      if (conversationState.hasRecentProducts) {
        evidenceBundle.products.push(...conversationState.recentProducts);
        evidenceBundle.facts.push('recent_products_count=' + conversationState.recentProducts.length);
        addPlannerToolStatus(evidenceBundle, name, 'executed', 'read_recent_products_memory');
      } else {
        evidenceBundle.missing_data.push('recent_products');
        addPlannerToolStatus(evidenceBundle, name, 'skipped', 'no_recent_products');
      }
      continue;
    }

    if (name === 'get_selected_product') {
      if (conversationState.hasSelectedProduct) {
        evidenceBundle.products.push(conversationState.selectedProduct);
        evidenceBundle.facts.push('selected_product=' + conversationState.selectedProduct.title);
        addPlannerToolStatus(evidenceBundle, name, 'executed', 'read_selected_product_memory');
      } else {
        evidenceBundle.missing_data.push('selected_product');
        addPlannerToolStatus(evidenceBundle, name, 'skipped', 'no_selected_product');
      }
      continue;
    }

    if (name === 'get_pending_product_selection') {
      if (conversationState.hasPendingSelection) {
        evidenceBundle.products.push(...conversationState.pendingSelectionOptions);
        evidenceBundle.facts.push('pending_selection_count=' + conversationState.pendingSelectionCount);
        addPlannerToolStatus(evidenceBundle, name, 'executed', 'read_pending_selection_memory');
      } else {
        evidenceBundle.missing_data.push('pending_product_selection');
        addPlannerToolStatus(evidenceBundle, name, 'skipped', 'no_pending_selection');
      }
      continue;
    }

    if (name === 'use_pending_action') {
      if (conversationState.hasPendingAction) {
        evidenceBundle.facts.push('pending_action_type=' + conversationState.pendingActionType);
        addPlannerToolStatus(evidenceBundle, name, 'executed', 'reported_pending_action_only');
      } else {
        evidenceBundle.missing_data.push('pending_action');
        addPlannerToolStatus(evidenceBundle, name, 'skipped', 'no_pending_action');
      }
      continue;
    }

    if (name === 'inspect_product' || name === 'inspect_product_variations') {
      const product = findPlannerProductForTool(tool, conversationState, context);
      if (product) {
        const snapshot = buildPlannerProductSnapshot(product, Number(product.displayIndex || 1));
        evidenceBundle.products.push(snapshot);
        evidenceBundle.facts.push(name + '_title=' + snapshot.title);
        evidenceBundle.facts.push('colors=' + snapshot.colors.join(', '));
        evidenceBundle.facts.push('available_sizes=' + snapshot.availableSizes.join(', '));
        addPlannerToolStatus(evidenceBundle, name, 'executed', 'read_product_variation_data');
      } else {
        evidenceBundle.missing_data.push('product');
        addPlannerToolStatus(evidenceBundle, name, 'skipped', 'no_product_context');
      }
      continue;
    }

    if (name === 'get_product_stock') {
      const product = findPlannerProductForTool(tool, conversationState, context);
      if (product) {
        const filters = {
          ...(conversationState.pendingFilters || {}),
          size: tool.args?.size || conversationState.pendingFilters?.size || extractRequestedSizes(conversationState.message)[0] || '',
          color: tool.args?.color || conversationState.pendingFilters?.color || getColorTokens(getSearchTokens(conversationState.message))[0] || '',
          variation: tool.args?.variation || conversationState.pendingFilters?.variation || ''
        };
        const stockResult = getStockForFilters(getPlannerProductSource(product), filters);
        evidenceBundle.facts.push('stock_confidence=' + stockResult.confidence);
        evidenceBundle.facts.push('stock_quantity=' + (stockResult.quantity === null || stockResult.quantity === undefined ? '' : stockResult.quantity));
        addPlannerToolStatus(evidenceBundle, name, 'executed', 'calculated_stock_from_memory');
      } else {
        evidenceBundle.missing_data.push('product_stock');
        addPlannerToolStatus(evidenceBundle, name, 'skipped', 'no_product_context');
      }
      continue;
    }

    if (['get_store_policy', 'search_knowledge_base', 'search_site_sources', 'search_files'].includes(name)) {
      evidenceBundle.warnings.push(name + '_not_executed_in_phase_a');
      addPlannerToolStatus(evidenceBundle, name, 'skipped', 'phase_a_source_lookup_not_executed');
      continue;
    }

    if (['search_vector_knowledge', 'search_config_knowledge', 'search_vector_products', 'search_product_api', 'hydrate_products_from_api', 'filter_products_by_size'].includes(name)) {
      evidenceBundle.warnings.push(name + '_not_executed_in_shadow_mode');
      addPlannerToolStatus(evidenceBundle, name, 'skipped', 'agentic_rag_shadow_only');
      continue;
    }

    if (['search_products', 'semantic_search_products', 'get_order_status', 'get_tracking'].includes(name)) {
      evidenceBundle.warnings.push(name + '_not_executed_in_shadow_mode');
      addPlannerToolStatus(evidenceBundle, name, 'skipped', 'side_effect_or_heavy_lookup_skipped');
      continue;
    }

    if (name === 'ask_clarification') {
      evidenceBundle.missing_data.push(tool.args?.topic || 'clarification_needed');
      addPlannerToolStatus(evidenceBundle, name, 'executed', 'planned_clarification_only');
      continue;
    }

    addPlannerToolStatus(evidenceBundle, name, 'skipped', 'unsupported_tool');
  }

  if (!key) evidenceBundle.warnings.push('no_conversation_id');
  return evidenceBundle;
}

function logPlannerShadowResult(plan = {}, evidenceBundle = {}, meta = {}) {
  const tools = (Array.isArray(plan.tools) ? plan.tools : []).map(tool => tool.name).filter(Boolean).join(',');
  console.log('[PLANNER PLAN] answer_type=' + (plan.answer_type || '') + ' confidence=' + (plan.confidence || '') + ' tools=' + tools);
  console.log('[PLANNER EVIDENCE] facts=' + (evidenceBundle.facts || []).length
    + ' products=' + (evidenceBundle.products || []).length
    + ' missing=' + (evidenceBundle.missing_data || []).length
    + ' warnings=' + (evidenceBundle.warnings || []).length);
  console.log('[PLANNER SHADOW DONE] ms=' + Number(meta.ms || 0));
}

async function answerPlannerShadowMode(context = {}) {
  const startedAt = Date.now();
  const conversationState = buildConversationStateForPlanner(context);
  console.log('[PLANNER SHADOW] enabled=true conv=' + (conversationState.conversationId || '') + ' message="' + escapeLogValue(String(context.message || '').slice(0, 160)) + '"');
  const plan = await planCustomerRequestShadow(
    context.message,
    conversationState,
    context.effectiveConfig || context.config || {},
    context.provider,
    context.apiKey
  );
  if (!plan) return null;
  const evidenceBundle = executePlannerToolsShadow(plan, conversationState, context);
  const config = context.effectiveConfig || context.config || {};
  if (getRagFlag(config, 'rag_agent_shadow_enabled', 'RAG_AGENT_SHADOW_ENABLED', false) && shouldUseAgenticRag(plan, config)) {
    try {
      await executeAgenticRagTools(plan, conversationState, context);
    } catch (error) {
      console.warn('[AGENT TOOL] status=shadow_error message=' + String(error?.message || error).slice(0, 180));
    }
  }
  logPlannerShadowResult(plan, evidenceBundle, { ms: Date.now() - startedAt });
  return { plan, evidenceBundle, conversationState };
}

function shouldUsePlannerForStorePolicy(plan = {}) {
  if (!plan || plan.answer_type !== 'store_policy') return false;
  if (!['high', 'medium'].includes(plan.confidence)) return false;
  if (plan.needs_clarification === true) return false;
  const toolNames = Array.isArray(plan.tools) ? plan.tools.map(tool => tool.name).filter(Boolean) : [];
  return toolNames.some(name => ['get_store_policy', 'search_vector_knowledge', 'search_config_knowledge', 'search_knowledge_base', 'search_site_sources'].includes(name));
}

async function resolveStorePolicyWithPlanner(plan = {}, conversationState = {}, context = {}) {
  const conv = conversationState.conversationId || getConversationMemoryKey(context.conversation || {});
  console.log('[PLANNER ACTIVE] type=store_policy conv=' + conv);
  const config = context.effectiveConfig || context.config || {};
  const evidenceBundle = {
    facts: [],
    policyFacts: [],
    configFacts: [],
    sourceFacts: [],
    contextFacts: [],
    noiseFacts: [],
    products: [],
    product_cards_preview: [],
    missing_data: [],
    warnings: [],
    tools_executed: [],
    tools_skipped: [],
    contextText: ''
  };
  const tools = Array.isArray(plan.tools) ? plan.tools : [];
  const query = String(
    tools.map(tool => tool?.args?.query || tool?.args?.topic).find(Boolean)
    || plan.understanding
    || conversationState.message
    || ''
  ).trim();
  const ragClientId = getRagClientId(context, config);
  const configPolicy = extractStorePolicyFactsFromConfig(config, plan, conversationState.message || context.message || query);
  evidenceBundle.policyTopic = configPolicy.topic;
  evidenceBundle.policyQueries = configPolicy.queries;

  if (shouldUseRagForStorePolicy(plan, config)) {
    const ragSearch = await searchRagKnowledge(ragClientId, query || conversationState.message || context.message, {
      topK: config.rag_top_k || 5,
      topic: configPolicy.topic
    }, context);
    if (Array.isArray(ragSearch.results) && ragSearch.results.length > 0) {
      const ragEvidence = buildRagEvidenceBundle(ragSearch.results, { topic: configPolicy.topic });
      addPlannerEvidenceFacts(evidenceBundle, ragEvidence.facts, 'source');
    } else {
      console.log('[RAG FALLBACK] using=current_evidence_pipeline reason=' + (ragSearch.reason || 'empty_results'));
    }
  }

  if (configPolicy.facts.length > 0) {
    addPlannerEvidenceFacts(evidenceBundle, configPolicy.facts, 'config');
    evidenceBundle.contextText += formatEvidenceFactsForPrompt('Fatos diretos extraidos da configuracao do cliente', evidenceBundle.configFacts);
  }

  for (const tool of tools) {
    const name = tool.name;
    if (name === 'get_store_policy') {
      const topic = String(tool.args?.topic || query || conversationState.message || '').trim();
      if (topic) {
        evidenceBundle.policyFacts.push({
          type: configPolicy.topic,
          text: 'Topico de politica identificado: ' + topic,
          sourceType: 'planner_tool',
          sourceName: 'get_store_policy',
          confidence: 'low'
        });
        evidenceBundle.tools_executed.push({ name, reason: 'topic_identified' });
        console.log('[PLANNER ACTIVE TOOL] name=' + name + ' status=executed');
      } else {
        evidenceBundle.missing_data.push('store_policy_topic');
        evidenceBundle.tools_skipped.push({ name, reason: 'missing_topic' });
        console.log('[PLANNER ACTIVE TOOL] name=' + name + ' status=skipped');
      }
      continue;
    }

    if (name === 'search_knowledge_base' || name === 'search_files') {
      const knowledgeContext = buildKnowledgeContextForConfig(config);
      if (knowledgeContext) {
        evidenceBundle.contextText += (evidenceBundle.contextText ? '\n\n' : '') + knowledgeContext.slice(0, 12000);
        addPlannerEvidenceFacts(evidenceBundle, extractStorePolicyFactsFromText(
          knowledgeContext,
          name === 'search_files' ? 'files' : 'knowledge_base',
          name === 'search_files' ? 'Arquivos do cliente' : 'Base de conhecimento do cliente',
          configPolicy.topic,
          configPolicy.queries
        ), 'source');
        evidenceBundle.tools_executed.push({ name, reason: 'knowledge_context_loaded' });
        console.log('[PLANNER ACTIVE TOOL] name=' + name + ' status=executed');
      } else {
        const sources = buildKnowledgeSourcesForConfig(config);
        if (sources.length > 0) {
          const siteContext = await fetchSiteInfoContext(query || conversationState.message, sources);
          if (siteContext.contextText) {
            const siteEvidenceText = buildSiteContextText(siteContext).slice(0, 12000);
            evidenceBundle.contextText += (evidenceBundle.contextText ? '\n\n' : '') + siteEvidenceText;
            addPlannerEvidenceFacts(evidenceBundle, extractStorePolicyFactsFromText(
              siteContext.contextText,
              'site_urls',
              'URLs configuradas do cliente',
              configPolicy.topic,
              configPolicy.queries
            ), 'source');
            evidenceBundle.tools_executed.push({ name, reason: 'site_context_loaded_for_knowledge_search' });
            console.log('[PLANNER ACTIVE TOOL] name=' + name + ' status=executed');
          } else {
            evidenceBundle.missing_data.push('knowledge_base');
            evidenceBundle.tools_skipped.push({ name, reason: 'no_knowledge_or_site_context' });
            console.log('[PLANNER ACTIVE TOOL] name=' + name + ' status=skipped');
          }
        } else {
          evidenceBundle.missing_data.push('knowledge_base');
          evidenceBundle.tools_skipped.push({ name, reason: 'no_knowledge_context' });
          console.log('[PLANNER ACTIVE TOOL] name=' + name + ' status=skipped');
        }
      }
      continue;
    }

    if (name === 'search_site_sources') {
      const sources = buildKnowledgeSourcesForConfig(config);
      if (sources.length > 0) {
        const siteContext = await fetchSiteInfoContext(query || conversationState.message, sources);
        if (siteContext.contextText) {
          const siteEvidenceText = buildSiteContextText(siteContext).slice(0, 12000);
          evidenceBundle.contextText += (evidenceBundle.contextText ? '\n\n' : '') + siteEvidenceText;
          addPlannerEvidenceFacts(evidenceBundle, extractStorePolicyFactsFromText(
            siteContext.contextText,
            'site_urls',
            'URLs configuradas do cliente',
            configPolicy.topic,
            configPolicy.queries
          ), 'source');
          evidenceBundle.tools_executed.push({ name, reason: 'site_context_loaded' });
          console.log('[PLANNER ACTIVE TOOL] name=' + name + ' status=executed');
        } else {
          evidenceBundle.missing_data.push('site_sources');
          evidenceBundle.tools_skipped.push({ name, reason: 'empty_site_context' });
          console.log('[PLANNER ACTIVE TOOL] name=' + name + ' status=skipped');
        }
      } else {
        evidenceBundle.missing_data.push('site_sources');
        evidenceBundle.tools_skipped.push({ name, reason: 'no_site_sources' });
        console.log('[PLANNER ACTIVE TOOL] name=' + name + ' status=skipped');
      }
      continue;
    }

    evidenceBundle.tools_skipped.push({ name, reason: 'not_allowed_for_store_policy_active' });
    console.log('[PLANNER ACTIVE TOOL] name=' + name + ' status=skipped');
  }

  evidenceBundle.facts = [
    ...evidenceBundle.policyFacts,
    ...evidenceBundle.configFacts,
    ...evidenceBundle.sourceFacts,
    ...evidenceBundle.contextFacts,
    ...evidenceBundle.noiseFacts
  ];
  const directFactsCount = evidenceBundle.configFacts.length + evidenceBundle.sourceFacts.length;
  console.log('[PLANNER ACTIVE EVIDENCE] policyFacts=' + evidenceBundle.policyFacts.length
    + ' configFacts=' + evidenceBundle.configFacts.length
    + ' sourceFacts=' + evidenceBundle.sourceFacts.length
    + ' directFacts=' + directFactsCount
    + ' contextFacts=' + evidenceBundle.contextFacts.length
    + ' noise=' + evidenceBundle.noiseFacts.length
    + ' missing=' + evidenceBundle.missing_data.length
    + ' warnings=' + evidenceBundle.warnings.length);
  if (!hasDirectStorePolicyEvidence(evidenceBundle) && !evidenceBundle.contextText) {
    console.log('[PLANNER ACTIVE FALLBACK] reason=no_relevant_evidence');
    return null;
  }

  const answer = await generateFinalAnswerFromEvidence(
    conversationState.message || context.message,
    plan,
    evidenceBundle,
    {
      ...(context.effectiveConfig || context.config || {}),
      _plannerProvider: context.provider,
      _plannerApiKey: context.apiKey
    }
  );
  if (!answer || !answer.response) {
    console.log('[PLANNER ACTIVE FALLBACK] reason=empty_answer');
    return null;
  }
  const directFacts = [...evidenceBundle.configFacts, ...evidenceBundle.sourceFacts];
  const activeConfidence = directFacts.some(fact => fact.confidence === 'high')
    ? 'high'
    : (directFacts.length > 0 ? 'medium' : 'low');
  answer.model = directFacts.length > 0 ? 'planner_store_policy' : 'planner_store_policy_fallback';
  answer.confidence = activeConfidence;
  console.log('[PLANNER ACTIVE ANSWER] confidence=' + activeConfidence + ' model=' + answer.model);
  return answer;
}

async function generateFinalAnswerFromEvidence(message, plan = {}, evidenceBundle = {}, config = {}) {
  const evidenceText = String(evidenceBundle.contextText || '').trim();
  const directEvidence = hasDirectStorePolicyEvidence(evidenceBundle);
  const buildSummaryAnswer = (model = 'planner_store_policy_summary', processingTimeMs = 0) => ({
    skipped: false,
    response: buildStorePolicyFactsSummaryResponse(message, evidenceBundle),
    provider: 'planner',
    model,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    processing_time_ms: processingTimeMs,
    product_images: [],
    product_cards: [],
    product_lookup_attempted: false,
    product_search_text: ''
  });
  if (!directEvidence) {
    return {
      skipped: false,
      response: 'Nao encontrei essa informacao com seguranca aqui. Posso chamar um atendente para confirmar?',
      provider: 'planner',
      model: 'planner_store_policy_fallback',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      processing_time_ms: 0,
      product_images: [],
      product_cards: [],
      product_lookup_attempted: false,
      product_search_text: ''
    };
  }

  const provider = config._plannerProvider || getProviderForModel(config.model);
  const apiKey = config._plannerApiKey;
  const storeDisplayName = getStoreDisplayName(config || {});
  const configFactsText = formatEvidenceFactsForPrompt('Fatos diretos da configuracao do cliente', evidenceBundle.configFacts || []);
  const sourceFactsText = formatEvidenceFactsForPrompt('Fatos diretos de fontes do cliente', evidenceBundle.sourceFacts || []);
  const policyFactsText = formatEvidenceFactsForPrompt('Topicos planejados, sem valor de politica', evidenceBundle.policyFacts || []);
  const prompt = `Voce e atendente de ${storeDisplayName}.
Responda a pergunta do cliente usando somente as evidencias abaixo.
Priorize os fatos diretos da configuracao e das fontes do cliente.
Os topicos planejados ajudam a entender a intencao, mas nao sao valor de politica.
Se existir fato direto relacionado, responda com ele; nao diga que nao encontrou.
Se a evidencia nao responder claramente, diga: "Nao encontrei essa informacao com seguranca aqui. Posso chamar um atendente para confirmar?"
Para pergunta sobre CNPJ/CPF, se nao houver evidencia explicita sobre documento obrigatorio, nao afirme certeza; diga que nao encontrou exigencia nas informacoes consultadas e ofereca confirmacao com atendente.
Para frete gratis, responda somente se houver evidencia direta; se nao houver, use a frase segura acima.
Nao invente regras, prazos, valores, endereco, excecoes ou politicas.
Seja curto e humano.

Pergunta do cliente: "${String(message || '').replace(/"/g, '\\"')}"
Entendimento do planner: "${String(plan.understanding || '').replace(/"/g, '\\"')}"

Evidencias:
${configFactsText}

${sourceFactsText}

${policyFactsText}

${evidenceText.slice(0, 16000)}`;

  if (!isUsableProviderApiKey(provider, apiKey)) {
    return buildSummaryAnswer('planner_store_policy_summary', 0);
  }

  const startedAt = Date.now();
  try {
    if (provider === 'claude') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: config.planner_final_model || config.planner_shadow_model || 'claude-3-haiku-20240307',
          max_tokens: 450,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: AbortSignal.timeout(Number(config.planner_active_timeout_ms || 7000))
      });
      if (!res.ok) throw new Error('planner_final_http_' + res.status);
      const data = await res.json().catch(() => null);
      const text = String(data?.content?.[0]?.text || '').trim();
      if (!text) return null;
      if (directEvidence && normalizeSearchText(text).includes('nao encontrei')) {
        return {
          skipped: false,
          response: buildStorePolicyFactsSummaryResponse(message, evidenceBundle),
          provider: 'planner',
          model: 'planner_store_policy',
          prompt_tokens: data?.usage?.input_tokens || 0,
          completion_tokens: data?.usage?.output_tokens || 0,
          total_tokens: (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0),
          processing_time_ms: Date.now() - startedAt,
          product_images: [],
          product_cards: [],
          product_lookup_attempted: false,
          product_search_text: ''
        };
      }
      return {
        skipped: false,
        response: text,
        provider: 'planner',
        model: data?.model || config.planner_final_model || config.planner_shadow_model || 'claude-3-haiku-20240307',
        prompt_tokens: data?.usage?.input_tokens || 0,
        completion_tokens: data?.usage?.output_tokens || 0,
        total_tokens: (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0),
        processing_time_ms: Date.now() - startedAt,
        product_images: [],
        product_cards: [],
        product_lookup_attempted: false,
        product_search_text: ''
      };
    }

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.planner_final_model || config.planner_shadow_model || 'gpt-4o-mini',
        temperature: 0,
        max_output_tokens: 450,
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }]
      }),
      signal: AbortSignal.timeout(Number(config.planner_active_timeout_ms || 7000))
    });
    if (!res.ok) throw new Error('planner_final_http_' + res.status);
    const data = await res.json().catch(() => null);
    const text = String(getOpenAIText(data) || '').trim();
    if (!text) return null;
    if (directEvidence && normalizeSearchText(text).includes('nao encontrei')) {
      return {
        skipped: false,
        response: buildStorePolicyFactsSummaryResponse(message, evidenceBundle),
        provider: 'planner',
        model: 'planner_store_policy',
        prompt_tokens: data?.usage?.input_tokens || data?.usage?.prompt_tokens || 0,
        completion_tokens: data?.usage?.output_tokens || data?.usage?.completion_tokens || 0,
        total_tokens: data?.usage?.total_tokens || 0,
        processing_time_ms: Date.now() - startedAt,
        product_images: [],
        product_cards: [],
        product_lookup_attempted: false,
        product_search_text: ''
      };
    }
    return {
      skipped: false,
      response: text,
      provider: 'planner',
      model: data?.model || config.planner_final_model || config.planner_shadow_model || 'gpt-4o-mini',
      prompt_tokens: data?.usage?.input_tokens || data?.usage?.prompt_tokens || 0,
      completion_tokens: data?.usage?.output_tokens || data?.usage?.completion_tokens || 0,
      total_tokens: data?.usage?.total_tokens || 0,
      processing_time_ms: Date.now() - startedAt,
      product_images: [],
      product_cards: [],
      product_lookup_attempted: false,
      product_search_text: ''
    };
  } catch (error) {
    console.warn('[PLANNER ACTIVE ANSWER FALLBACK] reason=provider_error_with_direct_evidence message=' + String(error?.message || error || '').slice(0, 160));
    return buildSummaryAnswer('planner_store_policy_summary', Date.now() - startedAt);
  }
}

function savePendingActionMemory(conversation = {}, action = {}) {
  const key = getConversationMemoryKey(conversation);
  if (!key || !action.type) return;
  pendingActionByConversation.set(key, {
    ...action,
    createdAt: Date.now(),
    ttlMs: action.ttlMs || PENDING_ACTION_TTL_MS
  });
  console.log('[PENDING ACTION SAVE] type=' + action.type + ' originalQuery="' + String(action.originalQuery || '').replace(/"/g, '\\"') + '"');
}

function getPendingActionMemory(conversation = {}) {
  const key = getConversationMemoryKey(conversation);
  if (!key) return null;
  const entry = pendingActionByConversation.get(key);
  if (!entry) return null;
  if (Date.now() - Number(entry.createdAt || 0) > Number(entry.ttlMs || PENDING_ACTION_TTL_MS)) {
    pendingActionByConversation.delete(key);
    console.log('[PENDING ACTION MISS] reason=expired');
    return null;
  }
  return entry;
}

function clearPendingActionMemory(conversation = {}, reason = 'clear') {
  const key = getConversationMemoryKey(conversation);
  if (key) {
    pendingActionByConversation.delete(key);
    console.log('[PENDING ACTION CLEAR] reason=' + reason);
  }
}

function saveLastProductSearchRequestMemory(conversation = {}, requestText = '', searchQuery = '') {
  const key = getConversationMemoryKey(conversation);
  const request = String(requestText || '').trim();
  if (!key || !request || isCatalogFollowUpRequest(request)) return;
  const query = String(searchQuery || getProductSearchPhrase(request) || '').trim();
  if (!query) return;
  lastProductSearchRequestByConversation.set(key, {
    request,
    query,
    createdAt: Date.now(),
    ttlMs: RECENT_PRODUCTS_MEMORY_TTL_MS
  });
  console.log('[LAST PRODUCT REQUEST SAVE] conv=' + key + ' query="' + query.replace(/"/g, '\\"') + '"');
}

function getLastProductSearchRequestMemory(conversation = {}) {
  const key = getConversationMemoryKey(conversation);
  if (!key) return '';
  const entry = lastProductSearchRequestByConversation.get(key);
  if (!entry) return '';
  if (Date.now() - Number(entry.createdAt || 0) > Number(entry.ttlMs || RECENT_PRODUCTS_MEMORY_TTL_MS)) {
    lastProductSearchRequestByConversation.delete(key);
    return '';
  }
  return String(entry.request || '').trim();
}

function saveRecentProductsMemory(conversation = {}, products = []) {
  const key = getConversationMemoryKey(conversation);
  if (!key) return;
  const safeProducts = dedupeRecentProductContext(normalizeRecentProductDataList(products));
  if (safeProducts.length === 0) return;
  recentProductsByConversation.set(key, {
    products: safeProducts,
    createdAt: Date.now(),
    ttlMs: RECENT_PRODUCTS_MEMORY_TTL_MS
  });
  console.log('[RECENT PRODUCTS MEMORY SAVE] conv=' + key + ' count=' + safeProducts.length);
}

function clearRecentProductsMemory(conversation = {}, reason = 'manual') {
  const key = getConversationMemoryKey(conversation);
  if (!key) return;
  if (recentProductsByConversation.delete(key)) {
    console.log('[RECENT PRODUCTS MEMORY CLEAR] conv=' + key + ' reason=' + reason);
  }
}

function getRecentProductsMemory(conversation = {}) {
  const key = getConversationMemoryKey(conversation);
  if (!key) {
    console.log('[RECENT PRODUCTS MEMORY MISS] reason=no_conversation_id');
    return [];
  }
  const entry = recentProductsByConversation.get(key);
  if (!entry) {
    console.log('[RECENT PRODUCTS MEMORY MISS] reason=empty conv=' + key);
    return [];
  }
  if (Date.now() - Number(entry.createdAt || 0) > Number(entry.ttlMs || RECENT_PRODUCTS_MEMORY_TTL_MS)) {
    recentProductsByConversation.delete(key);
    console.log('[RECENT PRODUCTS MEMORY MISS] reason=expired conv=' + key);
    return [];
  }
  const products = dedupeRecentProductContext(entry.products || []);
  console.log('[RECENT PRODUCTS SOURCE] source=memory_cache count=' + products.length);
  logRecentProductOptions(products);
  return products;
}

function withRecentProductsMemory(result = {}, conversation = {}) {
  const products = result.product_context_products || result.recent_products_data || [];
  if (Array.isArray(products) && products.length > 0) saveRecentProductsMemory(conversation, products);
  return result;
}

function getRecentProductStockContext(conversationHistory = []) {
  if (!Array.isArray(conversationHistory)) return [];
  const results = [];
  const recentAi = conversationHistory
    .filter(item => item && (item.direction === 'out' || item.is_from_ai))
    .slice(-6);

  for (const msg of recentAi) {
    const structuredProducts = normalizeRecentProductDataList(
      msg.product_context_products
      || msg.recent_products_data
      || msg.metadata?.product_context_products
      || msg.metadata?.recent_products_data
      || []
    );
    for (const product of structuredProducts) {
      if (product.title && !isOrderLikeRecentProductLine(product.title)) {
        results.push(product);
      }
    }

    const content = String(msg.content || '');
    // Detectar bloco de card: título + dados
    const blocks = content.split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) continue;
      // Primeira linha com produto
      const titleLine = lines[0]
        .replace(/^🛍️?\s*/u, '').replace(/^•\s*/, '').replace(/^\d+\.\s*/, '').trim();
      const hasProductWord = /\b(saia|short|vestido|conjunto|blusa|body|calca|macacao|camiseta|camisa|cropped|moletom|moleton|pijama|jaqueta|casaco)\b/i.test(normalizeSearchText(titleLine));
      if (!hasProductWord && !/[A-ZÀ-Ú]/.test(titleLine)) continue;

      let sizes = [];
      let stock = null;
      for (const line of lines.slice(1)) {
        const norm = line.toLowerCase();
        // Tamanhos com estoque: 4, 6, 8
        const sizesMatch = norm.match(/tamanhos?\s*(?:com\s*estoque)?:\s*([\d, pgmGXx]+)/i);
        if (sizesMatch) sizes = sizesMatch[1].split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
        // Estoque: 2
        const stockMatch = norm.match(/estoque(?:\s*total)?:\s*(\d+)/i);
        if (stockMatch) stock = Number(stockMatch[1]);
      }
      if (sizes.length > 0 || stock !== null) {
        const displayIndex = results.length + 1;
        results.push({
          displayIndex,
          id: '',
          title: titleLine,
          price: '',
          url: '',
          stock,
          sizes,
          availableSizes: sizes,
          colors: [],
          variations: sizes,
          variationStocks: [],
          rawProduct: null
        });
      }
    }
  }
  const seen = new Set();
  const uniqueResults = results.filter(product => {
    const key = normalizeSearchText(`${product.displayIndex}|${product.id}|${product.title}`);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (uniqueResults.length > 0) return uniqueResults;

  return getRecentlySentProductTitles(conversationHistory).map((title, index) => ({
    displayIndex: index + 1,
    id: '',
    title,
    price: '',
    url: '',
    stock: null,
    sizes: [],
    availableSizes: [],
    colors: [],
    variations: [],
    variationStocks: [],
    rawProduct: null
  }));
}

function dedupeRecentProductContext(products = []) {
  const seen = new Set();
  return products
    .filter(isReliableProductMemoryItem)
    .filter(product => {
      const key = normalizeSearchText(`${product.id || ''}|${product.title || ''}`);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((product, index) => ({ ...product, displayIndex: index + 1 }));
}

function getReliableRecentProductStockContext(conversationHistory = [], conversation = {}) {
  const conversationKey = getConversationMemoryKey(conversation);
  const memoryProducts = getRecentProductsMemory(conversation);
  if (memoryProducts.length > 0) return memoryProducts;

  if (!conversationKey) {
    console.log('[RECENT PRODUCTS SOURCE] source=none count=0 reason=no_conversation_id');
    return [];
  }

  if (!Array.isArray(conversationHistory)) return [];
  const recentAi = conversationHistory
    .filter(item => item && (item.direction === 'out' || item.is_from_ai))
    .slice(-6);
  let rejectedOrderLike = 0;
  const structured = [];

  for (const msg of recentAi) {
    const products = normalizeRecentProductDataList(
      msg.product_context_products
      || msg.recent_products_data
      || msg.metadata?.product_context_products
      || msg.metadata?.recent_products_data
      || []
    );
    for (const product of products) {
      if (!product.title || isOrderLikeRecentProductLine(product.title)) {
        rejectedOrderLike += 1;
        continue;
      }
      structured.push(product);
    }
  }

  const structuredProducts = dedupeRecentProductContext(structured);
  if (structuredProducts.length > 0) {
    console.log('[RECENT PRODUCTS SOURCE] source=message_metadata count=' + structuredProducts.length);
    console.log('[RECENT PRODUCTS FILTERED] rejected_order_like=' + rejectedOrderLike + ' accepted_products=' + structuredProducts.length);
    logRecentProductOptions(structuredProducts);
    return structuredProducts;
  }

  const textProducts = [];
  let rejectedBotResponse = 0;
  for (const msg of recentAi) {
    const blocks = String(msg.content || '').split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (lines.length === 0) continue;
      const blockText = [lines[0], ...lines.slice(1, 5)].join('\n');
      const title = cleanRecentProductTitleLine(lines[0]);
      if (isBotStockResponseLine(blockText) || isBotStockResponseLine(title)) {
        rejectedBotResponse += 1;
        continue;
      }
      if (isOrderLikeRecentProductLine(blockText) || isOrderLikeRecentProductLine(title)) {
        rejectedOrderLike += 1;
        continue;
      }
      if (!hasProductLineSignal(blockText)) continue;
      let sizes = [];
      let stock = null;
      for (const line of lines.slice(1)) {
        const norm = line.toLowerCase();
        const sizesMatch = norm.match(/tamanhos?\s*(?:com\s*estoque)?:\s*([\d, pgmGXx]+)/i);
        if (sizesMatch) sizes = sizesMatch[1].split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
        const stockMatch = norm.match(/estoque(?:\s*total)?:\s*(\d+)/i);
        if (stockMatch) stock = Number(stockMatch[1]);
      }
      textProducts.push({
        displayIndex: textProducts.length + 1,
        id: '',
        title,
        price: '',
        url: '',
        stock,
        sizes,
        availableSizes: sizes,
        colors: [],
        variations: sizes,
        variationStocks: [],
        rawProduct: null
      });
    }
  }

  const titleFallback = textProducts.length > 0
    ? []
    : getRecentlySentProductTitles(conversationHistory).map((title, index) => ({
        displayIndex: index + 1,
        id: '',
        title,
        price: '',
        url: '',
        stock: null,
        sizes: [],
        availableSizes: [],
        colors: [],
        variations: [],
        variationStocks: [],
        rawProduct: null
      }));
  const fallbackProducts = dedupeRecentProductContext(textProducts.length > 0 ? textProducts : titleFallback);
  console.log('[RECENT PRODUCTS SOURCE] source=text_fallback count=' + fallbackProducts.length);
  console.log('[RECENT PRODUCTS FILTERED] rejected_order_like=' + rejectedOrderLike + ' rejected_bot_response=' + rejectedBotResponse + ' accepted_products=' + fallbackProducts.length);
  logRecentProductOptions(fallbackProducts);
  return fallbackProducts;
}

function getRecentlySentProductTitles(conversationHistory = []) {
  if (!Array.isArray(conversationHistory)) return [];

  const recentAiMessages = conversationHistory
    .filter(item => item && (item.direction === 'out' || item.is_from_ai))
    .slice(-6);

  const seen = new Set();
  const titles = [];

  for (const msg of recentAiMessages) {
    const content = String(msg.content || '');
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      // Pula linhas genéricas
      if (/as fotos foram enviadas|se quiser|posso verificar/i.test(line)) continue;
      if (/^encontrei\s/i.test(line) && /\d+\s*opcoes/i.test(line)) continue;
      if (isBotStockResponseLine(line) || isOrderLikeRecentProductLine(line)) continue;

      let cleaned = line
        .replace(/^🛍️?\s*/u, '')           // Remove emoji 🛍️
        .replace(/^\u2022\s*/, '')          // Remove marcador •
        .replace(/^\d+\.\s*/, '')           // Remove numeração "1. "
        .replace(/\s*-\s*foto\s*\d+$/i, '') // Remove sufixo "- foto 1"
        .replace(/\s*—\s*R\$\s*[\d.,]+$/i, '') // Remove preço "— R$ XX"
        .trim();

      if (!cleaned || cleaned.length < 4 || cleaned.length > 90) continue;
      if (isBotStockResponseLine(cleaned) || isOrderLikeRecentProductLine(cleaned)) continue;

      const hasProductWord = /\b(saia|short|vestido|conjunto|blusa|body|calca|macacao|jardineira|camiseta|cropped|tshirt|moletom|moleton|camisa|bermuda|jaqueta|casaco|manga|bone)\b/i.test(normalizeSearchText(cleaned));
      const looksLikeTitle = /[A-ZÀ-Ú][a-zà-ú]/.test(cleaned) && cleaned.split(' ').length >= 2;

      if ((hasProductWord || looksLikeTitle) && cleaned.length >= 4) {
        const key = normalizeSearchText(cleaned);
        if (!seen.has(key)) {
          seen.add(key);
          titles.push(cleaned);
        }
      }
    }
  }

  return titles.slice(0, 5);
}

/**
 * Monta resposta de seleção de produto.
 * 1 produto → pergunta de confirmação
 * 2+ produtos → lista numerada
 */
function buildProductSelectionList(titles) {
  if (!Array.isArray(titles) || titles.length === 0) {
    return 'Claro! De qual produto voce quer consultar esse tamanho?';
  }

  if (titles.length === 1) {
    return `Voce quer consultar o tamanho desse produto: ${titles[0]}?`;
  }

  const numbered = titles
    .slice(0, 5)
    .map((title, i) => `${i + 1}. ${title}`)
    .join('\n');

  return `Voce quer saber de qual opcao?\n\n${numbered}`;
}

// ─── FIM DAS NOVAS FUNÇÕES ───────────────────────────────────────────────────

// ─── BUSCA SEMÂNTICA DE PRODUTOS ─────────────────────────────────────────────

/**
 * Ranking semântico de produtos usando IA.
 * Só chamado quando a busca literal não encontrou nenhum card
 * mas o catálogo coletou produtos (allProductsCollected.length > 0).
 *
 * NÃO recebe message bruta — recebe semanticQuery já resolvido e validado pelo caller.
 * NÃO inventa produtos — só seleciona IDs da lista candidateProducts recebida.
 *
 * @param {Array}  candidateProducts - Produtos coletados pela busca (sem match por score)
 * @param {Object} customerIntent    - Resultado de classifyCustomerIntent
 * @param {string} semanticQuery     - Query já resolvida (semantic_query || search_query || getProductSearchPhrase)
 * @param {string} apiKey            - API key do provedor
 * @param {string} provider          - 'claude' | 'openai'
 * @returns {Promise<{productCards: Array, customerNote: string}>}
 */
function getSemanticProductHaystack(product = {}) {
  return normalizeSearchText([
    product.title,
    product.description,
    product.category,
    product.categoryName,
    product.categoria_nome,
    Array.isArray(product.variations) ? product.variations.join(' ') : '',
    Array.isArray(product.variacoes) ? product.variacoes.map(v => JSON.stringify(v)).join(' ') : ''
  ].join(' '));
}

function hasAnySemanticTerm(haystack = '', terms = []) {
  return terms.some(term => {
    const normalized = normalizeSearchText(term);
    return normalized && haystack.includes(normalized);
  });
}

function getSemanticRequestProfile(customerIntent = {}, semanticQuery = '') {
  const requestText = normalizeSearchText([
    semanticQuery,
    customerIntent.search_query || '',
    customerIntent.semantic_query || '',
    customerIntent.product_type || '',
    customerIntent.theme || ''
  ].join(' '));
  const productTypeTokens = getSpecificProductTokens(getSearchTokens(customerIntent.product_type || ''));
  const explicitThemeTokens = getSpecificProductTokens(getSearchTokens(customerIntent.theme || customerIntent.entities?.theme || ''));
  const queryThemeTokens = getSpecificProductTokens(getSearchTokens([
    customerIntent.theme || '',
    customerIntent.entities?.theme || '',
    customerIntent.semantic_query || '',
    customerIntent.search_query || '',
    semanticQuery || ''
  ].join(' '))).filter(token => !productTypeTokens.includes(token));
  const requestedThemeTokens = [...new Set((explicitThemeTokens.length ? explicitThemeTokens : queryThemeTokens).filter(token => token.length >= 3))].slice(0, 8);
  return {
    requestText,
    wantsUpperPiece: hasAnySemanticTerm(requestText, ['camiseta', 'camisa', 'blusa', 't shirt', 'tshirt', 'cropped', 'body', 'moletom']),
    hasRequestedTheme: requestedThemeTokens.length > 0,
    requestedThemeTokens,
    upperPieceTerms: ['camiseta', 'camisa', 'blusa', 't shirt', 'tshirt', 'cropped', 'body', 'moletom', 'regata', 'top'],
    setTerms: ['conjunto', 'kit'],
    pajamaTerms: ['pijama', 'camisola'],
    isolatedBottomTerms: ['calca', 'saia', 'short', 'shorts', 'bermuda', 'legging', 'wide leg']
  };
}

function evaluateSemanticProductFit(product = {}, requestProfile = {}) {
  const haystack = getSemanticProductHaystack(product);
  const hasRequestedTheme = hasAnySemanticTerm(haystack, requestProfile.requestedThemeTokens || []);
  const isUpperPiece = hasAnySemanticTerm(haystack, requestProfile.upperPieceTerms || []);
  const isSet = hasAnySemanticTerm(haystack, requestProfile.setTerms || []);
  const isPajama = hasAnySemanticTerm(haystack, requestProfile.pajamaTerms || []);
  const isIsolatedBottom = hasAnySemanticTerm(haystack, requestProfile.isolatedBottomTerms || []);

  if (requestProfile.hasRequestedTheme && !hasRequestedTheme) {
    return { rejectReason: 'weak_theme_match', scoreAdjustment: -20 };
  }

  let scoreAdjustment = 0;
  if (requestProfile.wantsUpperPiece) {
    if (isUpperPiece) scoreAdjustment += 12;
    if (isSet && hasRequestedTheme) scoreAdjustment += 7;
    if (isPajama && hasRequestedTheme) scoreAdjustment += 4;
    if (isIsolatedBottom && !hasRequestedTheme) scoreAdjustment -= 12;
    if (!isUpperPiece && !isSet && !isPajama && !hasRequestedTheme) scoreAdjustment -= 6;
  }
  if (requestProfile.hasRequestedTheme && hasRequestedTheme) scoreAdjustment += 10;
  return { rejectReason: '', scoreAdjustment };
}

function escapeLogValue(value = '') {
  return String(value || '').replace(/"/g, '\\"');
}

function selectSemanticCandidateProducts(allProducts = [], customerIntent = {}, semanticQuery = '', limit = 60) {
  const requestedSizes = extractRequestedSizes([
    semanticQuery,
    customerIntent.entities?.size || '',
    customerIntent.size || ''
  ].join(' '));
  const rawProducts = Array.isArray(allProducts) ? allProducts : [];
  const products = rawProducts.filter(product => productIsRecommendableForRequest(product, requestedSizes));
  if (rawProducts.length !== products.length) {
    console.log('[SEMANTIC STOCK FILTER] before=' + rawProducts.length + ' after=' + products.length + ' removed=' + (rawProducts.length - products.length));
  }
  const requestProfile = getSemanticRequestProfile(customerIntent, semanticQuery);
  const queryTokens = getSpecificProductTokens(getSearchTokens([
    semanticQuery,
    customerIntent.search_query || '',
    customerIntent.semantic_query || '',
    customerIntent.product_type || '',
    customerIntent.theme || ''
  ].join(' ')));
  const themeTokens = getSpecificProductTokens(getSearchTokens(customerIntent.theme || ''));
  const productTypeTokens = getSpecificProductTokens(getSearchTokens(customerIntent.product_type || ''));
  const scored = products.map((product, index) => {
    const haystack = getSemanticProductHaystack(product);
    const semanticFit = evaluateSemanticProductFit(product, requestProfile);
    if (semanticFit.rejectReason) {
      console.log('[SEMANTIC FILTER REJECT] title="' + escapeLogValue(product.title || '') + '" reason="' + semanticFit.rejectReason + '"');
    }
    let score = 0;
    for (const token of queryTokens) if (token.length >= 3 && haystack.includes(token)) score += 3;
    for (const token of themeTokens) if (token.length >= 3 && haystack.includes(token)) score += 5;
    for (const token of productTypeTokens) if (token.length >= 3 && haystack.includes(token)) score += 4;
    score += semanticFit.scoreAdjustment || 0;
    if (getProductAvailableStock(product) > 0) score += 1;
    if ((product.images || []).length > 0) score += 1;
    return { product, score, index, rejectReason: semanticFit.rejectReason };
  });
  const positives = scored
    .filter(item => item.score > 0 && !item.rejectReason)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(item => item.product);
  const selected = positives.length > 0
    ? positives
    : scored
      .filter(item => !item.rejectReason)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, limit)
      .map(item => item.product);
  console.log('[SEMANTIC PREFILTER] before=' + products.length + ' after=' + selected.length + ' reason=' + (positives.length > 0 ? 'local_token_score' : 'fallback_sample'));
  return selected;
}

async function semanticRankProducts(candidateProducts, customerIntent, semanticQuery, apiKey, provider) {
  const SEMANTIC_MAX_CANDIDATES = 60;
  const SEMANTIC_MAX_RESULTS = 6;
  const SEMANTIC_TIMEOUT_MS = 9000;

  if (!candidateProducts || candidateProducts.length === 0 || !semanticQuery) {
    return { productCards: [], customerNote: '' };
  }

  const requestedSizes = extractRequestedSizes([
    semanticQuery,
    customerIntent?.entities?.size || '',
    customerIntent?.size || ''
  ].join(' '));
  const stockCandidates = candidateProducts.filter(product => productIsRecommendableForRequest(product, requestedSizes));
  if (candidateProducts.length !== stockCandidates.length) {
    console.log('[SEMANTIC STOCK FILTER] before=' + candidateProducts.length + ' after=' + stockCandidates.length + ' removed=' + (candidateProducts.length - stockCandidates.length));
  }
  if (stockCandidates.length === 0) {
    return { productCards: [], customerNote: '' };
  }

  const requestProfile = getSemanticRequestProfile(customerIntent, semanticQuery);
  const rankedCandidates = stockCandidates.length > SEMANTIC_MAX_CANDIDATES
    ? selectSemanticCandidateProducts(stockCandidates, customerIntent, semanticQuery, SEMANTIC_MAX_CANDIDATES)
    : stockCandidates.slice(0, SEMANTIC_MAX_CANDIDATES);
  console.log('[SEMANTIC BATCH] batch=1 size=' + rankedCandidates.length);

  // Lista compacta para a IA — sem URLs longas, sem base64, sem HTML
  const candidateSample = rankedCandidates
    .map(p => ({
      id: String(p.id || p.url || ''),
      title: String(p.title || ''),
      category: String(p.category || p.categoryName || p.categoria_nome || ''),
      description: String(p.description || '').slice(0, 120),
      price: String(p.price || ''),
      stock: getProductAvailableStock(p),
      variations: Array.isArray(p.variations) ? p.variations.slice(0, 5) : [],
      image_count: (p.images || []).length
    }));

  const rankPrompt = `Voce e um assistente de busca semantica para uma loja virtual.

O cliente pediu: "${semanticQuery}"
Tipo de produto: "${customerIntent && customerIntent.product_type ? customerIntent.product_type : ''}"
Tema/personagem: "${customerIntent && customerIntent.theme ? customerIntent.theme : ''}"

INSTRUCAO PRINCIPAL:
Avalie o SIGNIFICADO do pedido, nao a literalidade.
Exemplos de equivalencia semantica:
- "produto com tema/personagem" = qualquer item da categoria solicitada com o tema, personagem, marca ou estampa informada pelo cliente.
- "produto relacionado ao pedido" = item com tipo, categoria, variacao, cor, tamanho, modelo ou tema compativel com a mensagem do cliente.
- "blusa de frio" = moletom, casaco, jaqueta, blusao.
Se o pedido menciona tema/personagem, priorize produtos com esse tema, mesmo que o tipo de peca seja diferente.
Se nao houver correspondencia exata de peca mas houver correspondencia de tema, inclua como relacionado com score menor.
Se absolutamente nenhum produto tiver relacao semantica com o pedido, retorne matches vazio.

Regras de selecao:
- Use apenas o campo "id" exato dos produtos listados abaixo
- Nao invente produtos nem altere dados
- Prefira produtos com stock maior que zero (campo stock)
- Se o cliente pediu camiseta, camisa, blusa ou t-shirt, priorize camiseta, camisa, blusa, t-shirt, cropped, body e moletom
- Conjunto pode entrar se tiver tema/personagem forte; pijama pode entrar com score menor se tiver tema/personagem forte
- Nao trate termos decorativos soltos como tema/personagem forte sem outros sinais do pedido
- Quando houver tema/personagem/marca/estampa no pedido, use apenas produtos com sinais claros desse mesmo tema/personagem/marca/estampa
- Se nenhum for compativel semanticamente, retorne matches: []
- Maximo de ${SEMANTIC_MAX_RESULTS} produtos
- Ordene por score decrescente (mais compativel primeiro)
- score 1.0 = correspondencia perfeita de tipo + tema
- score 0.7-0.9 = mesmo tema, tipo de peca diferente
- score 0.4-0.6 = relacionado indiretamente

Produtos disponíveis:
${JSON.stringify(candidateSample)}

Retorne APENAS JSON valido, sem markdown, sem comentarios:
{"matches":[{"id":"id_exato","score":0.85,"reason":"motivo em portugues"}],"customer_note":"Mensagem curta em portugues: explique que nao encontrou exatamente o pedido mas encontrou opcoes relacionadas ao tema/personagem"}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEMANTIC_TIMEOUT_MS);

    let rankResult = null;

    if (provider === 'claude' && isUsableProviderApiKey('claude', apiKey)) {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          temperature: 0,
          messages: [{ role: 'user', content: rankPrompt }]
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (resp.ok) {
        const data = await resp.json().catch(() => null);
        const text = data && data.content && data.content[0] ? (data.content[0].text || '') : '';
        rankResult = JSON.parse(text.replace(/```json|```/g, '').trim());
      }
    } else if (provider === 'openai' && isUsableProviderApiKey('openai', apiKey)) {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 600,
          temperature: 0,
          messages: [{ role: 'user', content: rankPrompt }]
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (resp.ok) {
        const data = await resp.json().catch(() => null);
        const text = data && data.choices && data.choices[0] ? (data.choices[0].message && data.choices[0].message.content || '') : '';
        rankResult = JSON.parse(text.replace(/```json|```/g, '').trim());
      }
    }

    if (!rankResult || !Array.isArray(rankResult.matches) || rankResult.matches.length === 0) {
      console.log('[SEMANTIC] Nenhum produto compativel encontrado pelo ranking semantico');
      return { productCards: [], customerNote: '' };
    }

    // Mapa id → produto original (preserva imagens, urls e preços reais da API)
    const productById = new Map();
    for (const p of rankedCandidates) {
      const key = String(p.id || p.url || '');
      if (key) productById.set(key, p);
    }

    // Filtrar apenas IDs que existem na lista original — descartar qualquer invenção da IA
    const validMatches = rankResult.matches
      .filter(m => {
        if (!m || !productById.has(String(m.id || ''))) return false;
        const product = productById.get(String(m.id || ''));
        const semanticFit = evaluateSemanticProductFit(product, requestProfile);
        if (semanticFit.rejectReason) {
          console.log('[SEMANTIC FILTER REJECT] title="' + escapeLogValue(product.title || '') + '" reason="' + semanticFit.rejectReason + '"');
          return false;
        }
        m.score = Number(m.score || 0) + ((semanticFit.scoreAdjustment || 0) / 100);
        return true;
      })
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, SEMANTIC_MAX_RESULTS);

    if (validMatches.length === 0) {
      console.log('[SEMANTIC] IDs retornados pela IA nao correspondem a produtos existentes');
      return { productCards: [], customerNote: '' };
    }

    // Montar productCards usando 100% os dados reais do produto original
    const productCards = [];
    const matchedProducts = [];
    for (const match of validMatches) {
      const product = productById.get(String(match.id));
      if (!product) continue;
      matchedProducts.push(product);
      const images = (product.images || []).slice(0, 2);
      if (images.length === 0) {
        // Produto sem imagem: card textual, SEM imageUrl, sem prometer foto
        productCards.push({
          title: buildCarouselCardTitle(product, ''),
          description: buildCarouselCardDescription(product),
          url: product.url,
          imageUrl: null
        });
      } else {
        for (let i = 0; i < images.length; i++) {
          const suffix = images.length > 1 ? ` - foto ${i + 1}` : '';
          productCards.push({
            title: buildCarouselCardTitle(product, suffix),
            description: buildCarouselCardDescription(product),
            url: product.url,
            imageUrl: images[i]
          });
        }
      }
    }

    const customerNote = (rankResult.customer_note && String(rankResult.customer_note).trim())
      || 'Nao encontrei exatamente o que voce pediu, mas encontrei opcoes relacionadas:';

    console.log('[SEMANTIC RANK] ranking interno concluido | candidatos: ' + candidateSample.length + ' | matches validos: ' + validMatches.length + ' | cards montados: ' + productCards.length);
    return { productCards: productCards.slice(0, 10), customerNote, products: matchedProducts };

  } catch (err) {
    if (/aborted|abort/i.test(String((err && err.message) || err))) {
      console.warn('[SEMANTIC TIMEOUT] query=' + String(semanticQuery || '').slice(0, 120));
    }
    console.warn('[SEMANTIC] Falha no ranking semantico, usando resposta padrao | erro: ' + String((err && err.message) || err));
    return { productCards: [], customerNote: '' };
  }
}

async function executePendingActionForConversation(action = {}, confirmation = '', context = {}) {
  if (!action || action.type !== 'search_related_products') {
    console.log('[PENDING ACTION MISS] reason=invalid');
    return null;
  }
  const {
    effectiveConfig,
    conversationHistory,
    conversation,
    apiKey,
    provider
  } = context;
  const originalQuery = String(action.originalQuery || action.semanticQuery || '').trim();
  const semanticQuery = String(action.semanticQuery || buildRelatedSemanticQuery(originalQuery, action.customerIntent || {})).trim();
  if (!semanticQuery && !originalQuery) {
    console.log('[PENDING ACTION MISS] reason=invalid');
    return null;
  }
  console.log('[PENDING ACTION EXECUTE] type=' + action.type + ' confirmation="' + normalizeSearchText(confirmation).slice(0, 40) + '"');
  const productContext = await buildProductContextForConfig(originalQuery || semanticQuery, effectiveConfig, conversationHistory);
  saveRecentProductsMemory(conversation, productContext.product_context_products || productContext.recent_products_data || []);
  const directCards = productContext.productCards || [];
  if (directCards.length > 0) {
    console.log('[PENDING ACTION RESULT] cards=' + directCards.length + ' products=' + ((productContext.product_context_products || productContext.recent_products_data || []).length));
    return {
      skipped: false,
      response: buildRelatedProductsNote(originalQuery || semanticQuery, action.customerIntent || {}) + '\n\n' + buildProductCardsResponse(directCards),
      provider: 'catalog',
      model: 'pending_related_product_search',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      processing_time_ms: 0,
      product_images: directCards.map(card => card.imageUrl).filter(Boolean),
      product_cards: directCards,
      product_lookup_attempted: true,
      product_search_text: originalQuery || semanticQuery,
      products_found: true,
      semantic_rank_used: false
    };
  }

  const candidates = selectSemanticCandidateProducts(productContext.allProductsCollected || [], action.customerIntent || {}, semanticQuery, 60);
  const semanticResult = isUsableProviderApiKey(provider, apiKey)
    ? await semanticRankProducts(candidates, action.customerIntent || {}, semanticQuery, apiKey, provider)
    : { productCards: [], customerNote: '' };
  const cards = semanticResult.productCards || [];
  if (cards.length > 0) {
    const cardsWithImage = cards.filter(card => card.imageUrl);
    const responseCards = cardsWithImage.length > 0 ? cardsWithImage : cards;
    saveRecentProductsMemory(conversation, semanticResult.products || []);
    console.log('[PENDING ACTION RESULT] cards=' + responseCards.length + ' products=' + ((semanticResult.products || []).length));
    return {
      skipped: false,
      response: buildRelatedProductsNote(originalQuery || semanticQuery, action.customerIntent || {}) + '\n\n' + buildProductCardsResponse(responseCards),
      provider: 'catalog',
      model: 'pending_related_product_search',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      processing_time_ms: 0,
      product_images: responseCards.map(card => card.imageUrl).filter(Boolean),
      product_cards: responseCards,
      product_lookup_attempted: true,
      product_search_text: semanticQuery,
      products_found: true,
      semantic_rank_used: true
    };
  }
  console.log('[PENDING ACTION RESULT] cards=0 products=0');
  return {
    skipped: false,
    response: 'Nao encontrei opcoes parecidas no momento. Pode me passar outro detalhe, como tamanho, cor ou personagem?',
    provider: 'catalog',
    model: 'pending_related_product_empty',
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    processing_time_ms: 0,
    product_images: [],
    product_cards: [],
    product_lookup_attempted: true,
    product_search_text: originalQuery || semanticQuery,
    products_found: false
  };
}

// ─── FIM BUSCA SEMÂNTICA ──────────────────────────────────────────────────────

async function buildProductContextForConfig(message, config, conversationHistory = [], options = {}) {
  const searchText = buildProductSearchText(message, conversationHistory, options);
  const configuredSources = buildProductSourcesForConfig(config);
  if (config?.product_search_enabled === false && configuredSources.length === 0) return { contextText: '', imageUrls: [], productCards: [], lookupAttempted: false };
  const shouldSearch = shouldUseConfiguredProductSources(searchText);
  const excludeTitles = isCatalogFollowUpRequest(message)
    ? extractPreviouslyMentionedProductTitles(conversationHistory)
    : [];
  const ragObservationQuery = String(options.ragObservationQuery || (isCatalogFollowUpRequest(message) ? searchText : message) || searchText || '').trim();
  const productPrefilterEnabled = shouldSearch && getRagFlag(config, 'rag_product_prefilter_enabled', 'RAG_PRODUCT_PREFILTER_ENABLED', false);
  const vectorProductHints = productPrefilterEnabled
    ? await getRagProductPrefilterHints(ragObservationQuery || searchText, config)
    : [];
  const productContext = await fetchProductContext(searchText, shouldSearch ? configuredSources : [], { excludeTitles, vectorProductHints });
  if (shouldSearch) {
    queueRagProductIndexFromContext(productContext, config);
    if (productPrefilterEnabled) {
      console.log('[RAG PRODUCT OBSERVE] skipped reason=prefilter_already_executed');
    } else {
      observeRagProductSearchFromContext(ragObservationQuery, { ...productContext, searchText: ragObservationQuery || searchText }, config);
    }
  }
  return { ...productContext, lookupAttempted: shouldSearch, searchText };
}

async function buildSiteContextForConfig(message, config) {
  const configuredSources = buildKnowledgeSourcesForConfig(config);
  const shouldSearch = shouldUseConfiguredSiteSources(message);
  if (!shouldSearch) return { contextText: '', lookupAttempted: false };
  const siteContext = await fetchSiteInfoContext(message, configuredSources);
  return { ...siteContext, lookupAttempted: shouldSearch };
}

async function buildOperationalContextForConfig(message, config, contact, conversation) {
  const sources = buildOperationalSourcesForConfig(config, message, contact, conversation);
  if (sources.length === 0) return { contextText: '', lookupAttempted: false };
  const context = await fetchSiteInfoContext(message, sources);
  return {
    ...context,
    contextText: context.contextText ? context.contextText.replace('Informacoes gerais coletadas do site/configuracoes:', 'Informacoes operacionais coletadas das integracoes:') : '',
    lookupAttempted: true
  };
}

function buildProductContextText(productContext) {
  if (!productContext?.contextText) return '';
  return `${productContext.contextText}\n\nEstas informacoes foram buscadas antes da resposta nas APIs de integracoes ativas e/ou no link de catalogo configurado. Use primeiro os dados coletados das integracoes e do catalogo. Use somente os produtos que batem com o pedido do cliente. Se o cliente pediu idade/tamanho, por exemplo crianca de 6 anos, tamanho 6 ou tam 6, responda e envie somente produtos com esse tamanho explicitamente encontrado. Se o cliente pediu um produto especifico, nao inclua produtos parecidos, personagens, outras estampas, outras cores ou outras categorias. Se nao houver correspondencia clara com o pedido do cliente, diga que nao encontrou esse produto no momento e oferea opcoes relacionadas se existirem. Use nomes, precos, fotos, variacoes, tamanhos e disponibilidade quando existirem. Nao pergunte se pode enviar fotos: quando houver imagens, responda considerando que o sistema enviara as fotos antes do texto. Nao escreva URLs de imagens na resposta. As imagens serao enviadas pelo sistema como carrossel interativo fora do texto. Nao responda apenas com o link da loja se houver dados de produtos acima. Nao invente preco, estoque, tamanho ou variacao que nao esteja no conteudo coletado.`;
}

function buildProductInputResult(extra, productContext) {
  return {
    ...extra,
    productImages: productContext.imageUrls || [],
    productCards: productContext.productCards || [],
    productContextProducts: productContext.product_context_products || productContext.recent_products_data || [],
    productLookupAttempted: productContext.lookupAttempted === true,
    productSearchText: productContext.searchText || '',
    productsFound: productContext.productsFound === true || Boolean(productContext.contextText)
  };
}

function buildSiteContextText(siteContext) {
  if (!siteContext?.contextText) return '';
  return `${siteContext.contextText}\n\nEstas informacoes foram buscadas antes da resposta no site, links adicionais, arquivos e/ou APIs configuradas. Use esses dados para responder perguntas sobre endereco, contato, como comprar, pagamento, entrega, retirada, troca, devolucao, horario, politicas e informacoes institucionais. Nao invente informacoes que nao estejam no conteudo coletado. Se a informacao solicitada nao apareceu no site/fontes, diga que nao encontrou essa informacao nas fontes configuradas e peca confirmacao.`;
}

function buildOperationalContextText(operationalContext) {
  if (!operationalContext?.contextText) return '';
  return `${operationalContext.contextText}\n\nEstas informacoes foram consultadas em integracoes ativas antes da resposta. Use esses dados para responder sobre pedido, status, envio, rastreio, estoque, cliente, pagamento ou entrega. Nao invente status, rastreio, estoque ou prazo. Se uma fonte retornou erro HTTP ou falha de acesso, diga que nao foi possivel consultar a integracao naquele momento, sem afirmar que o pedido nao existe. Se a integracao respondeu com dados mas o pedido/cliente solicitado nao apareceu, diga que nao encontrou essa informacao na integracao configurada.`;
}

function buildSiteContextSummaryResponse(siteContext) {
  const text = String(siteContext?.contextText || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !/^Fonte \d+:|^Nome da fonte:|^Titulo da pagina:/i.test(line))
    .slice(0, 8)
    .join('\n')
    .replace(/^Informacoes gerais coletadas do site\/configuracoes:\s*/i, '')
    .trim();
  return text
    ? `Encontrei estas informacoes nas fontes configuradas:\n${text}`
    : 'Nao encontrei essa informacao nas fontes configuradas.';
}

async function buildOpenAIInputContent({ apiKey, message, media, config, conversationHistory, contact, conversation }) {
  const productContext = await buildProductContextForConfig(message, config, conversationHistory);
  saveRecentProductsMemory(conversation, productContext.product_context_products || productContext.recent_products_data || []);
  const siteContext = await buildSiteContextForConfig(message, config);
  const operationalContext = await buildOperationalContextForConfig(message, config, contact, conversation);
  const knowledgeContext = buildKnowledgeContextForConfig(config);
  const content = [{
    type: 'input_text',
    text: message && String(message).trim()
      ? String(message)
      : 'O cliente enviou uma midia sem texto. Analise a midia e responda de forma util no atendimento.'
  }];

  const historyText = formatConversationHistory(conversationHistory);
  if (historyText) {
    content.push({
      type: 'input_text',
      text: `Historico da conversa desde a primeira mensagem disponivel:\n${historyText}\n\nUse esse historico para nao repetir perguntas, nao pedir de novo dados ja informados e manter o contexto do atendimento desde o inicio.`
    });
  }

  if (knowledgeContext) {
    content.push({ type: 'input_text', text: knowledgeContext });
  }
  if (siteContext.contextText) {
    content.push({ type: 'input_text', text: buildSiteContextText(siteContext) });
  }
  if (operationalContext.contextText) {
    content.push({ type: 'input_text', text: buildOperationalContextText(operationalContext) });
  }
  content.push(...buildOpenAIKnowledgeFileParts(config));

  if (productContext.contextText) {
    content.push({
      type: 'input_text',
      text: buildProductContextText(productContext)
    });
  } else if (productContext.lookupAttempted) {
    content.push({
      type: 'input_text',
      text: 'O cliente pediu fotos ou produtos, mas nenhum produto com imagem foi encontrado agora. Nao diga que vai enviar fotos e nao prometa encaminhar para atendente. Responda de forma natural que nao encontrou esse produto no momento e pergunte se o cliente quer buscar por outro nome, cor ou categoria.'
    });
  }

  if (!media || (!media.path && !media.url)) return buildProductInputResult({ content }, productContext);

  const kind = getMediaKind(media);
  const mimeType = media.mimeType || media.mimetype || getMimeTypeFromPath(media.path || '', 'application/octet-stream');
  content.push({ type: 'input_text', text: `Dados da midia recebida:\n${getMediaDescription(media)}` });

  if (kind === 'image' && media.path && fs.existsSync(media.path)) {
    content.push({ type: 'input_image', image_url: fileToDataUrl(media.path, mimeType), detail: 'auto' });
    return buildProductInputResult({ content }, productContext);
  }

  if (kind === 'image' && media.url && /^https?:\/\//i.test(media.url)) {
    content.push({ type: 'input_image', image_url: media.url, detail: 'auto' });
    return buildProductInputResult({ content }, productContext);
  }

  if ((kind === 'audio' || kind === 'video') && media.path && fs.existsSync(media.path)) {
    const transcript = await transcribeOpenAIMedia({ apiKey, filePath: media.path, mimeType });
    content.push({
      type: 'input_text',
      text: transcript
        ? `Transcricao do ${kind === 'video' ? 'audio do video' : 'audio'}:\n${transcript}`
        : `Nao foi possivel transcrever o ${kind}.`
    });

    if (kind === 'video') {
      let framePath = '';
      try {
        framePath = await extractVideoFrame(media.path);
        content.push({ type: 'input_image', image_url: fileToDataUrl(framePath, 'image/jpeg'), detail: 'low' });
      } catch (frameError) {
        content.push({ type: 'input_text', text: `Nao foi possivel extrair frame do video: ${frameError.message}` });
      } finally {
        if (framePath) fs.promises.unlink(framePath).catch(() => {});
      }
    }
    return buildProductInputResult({ content }, productContext);
  }

  if (kind === 'document' && media.path && fs.existsSync(media.path)) {
    const stat = fs.statSync(media.path);
    if (mimeType === 'application/pdf' && stat.size <= 50 * 1024 * 1024) {
      content.push({
        type: 'input_file',
        filename: media.fileName || path.basename(media.path),
        ...(media.url && /^https?:\/\//i.test(media.url)
          ? { file_url: media.url }
          : { file_data: fileToBase64(media.path) })
      });
      return buildProductInputResult({ content }, productContext);
    }

    if (canReadTextFile(media.path, mimeType) && stat.size <= 1024 * 1024) {
      content.push({
        type: 'input_text',
        text: `Conteudo do arquivo ${media.fileName || path.basename(media.path)}:\n${fs.readFileSync(media.path, 'utf8').slice(0, 20000)}`
      });
      return buildProductInputResult({ content }, productContext);
    }
  }

  content.push({ type: 'input_text', text: 'A midia foi recebida, mas esse tipo de arquivo nao pode ser analisado diretamente. Responda considerando o nome, tipo e legenda informados.' });
  return buildProductInputResult({ content }, productContext);
}

async function callOpenAI({ apiKey, config, input, systemPrompt, media, conversationHistory, contact, conversation }) {
  const startedAt = Date.now();
  const builtInput = Array.isArray(input)
    ? { content: input, productImages: [] }
    : await buildOpenAIInputContent({ apiKey, message: input, media, config, conversationHistory, contact, conversation });
  const body = {
    model: normalizeConfiguredModel(config.model, 'openai'),
    instructions: systemPrompt,
    input: [{ role: 'user', content: builtInput.content }],
    max_output_tokens: config.max_tokens || 500
  };

  if (!String(body.model).startsWith('gpt-5')) {
    body.temperature = typeof config.temperature === 'number' ? config.temperature : 0.7;
  }

  let response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const fallbackModel = getFallbackModel('openai', body.model);
    const canFallback = fallbackModel && /model|not found|does not exist|unsupported|invalid|access/i.test(String(data?.error?.message || ''));
    if (canFallback) {
      const fallbackBody = { ...body, model: fallbackModel };
      response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(fallbackBody)
      });
      const fallbackData = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(fallbackData?.error?.message || `OpenAI respondeu HTTP ${response.status}`);
      }
      const fallbackText = getOpenAIText(fallbackData).trim();
      if (!fallbackText) throw new Error('OpenAI nao retornou texto na resposta');
      return {
        response: fallbackText,
        provider: 'openai',
        model: fallbackData.model || fallbackBody.model,
        requested_model: body.model,
        processing_time_ms: Date.now() - startedAt,
        product_images: builtInput.productImages || [],
        product_cards: builtInput.productCards || [],
        product_context_products: builtInput.productContextProducts || [],
        recent_products_data: builtInput.productContextProducts || [],
        product_lookup_attempted: builtInput.productLookupAttempted === true,
        product_search_text: builtInput.productSearchText || '',
        products_found: builtInput.productsFound === true,
        ...getTokenUsageFromOpenAI(fallbackData)
      };
    }
    throw new Error(data?.error?.message || `OpenAI respondeu HTTP ${response.status}`);
  }

  const text = getOpenAIText(data).trim();
  if (!text) throw new Error('OpenAI nao retornou texto na resposta');

  return {
    response: text,
    provider: 'openai',
    model: data.model || body.model,
    processing_time_ms: Date.now() - startedAt,
    product_images: builtInput.productImages || [],
    product_cards: builtInput.productCards || [],
    product_context_products: builtInput.productContextProducts || [],
    recent_products_data: builtInput.productContextProducts || [],
    product_lookup_attempted: builtInput.productLookupAttempted === true,
    product_search_text: builtInput.productSearchText || '',
    products_found: builtInput.productsFound === true,
    ...getTokenUsageFromOpenAI(data)
  };
}

async function buildClaudeInputContent({ input, media, config, conversationHistory, contact, conversation }) {
  const productContext = await buildProductContextForConfig(input, config, conversationHistory);
  saveRecentProductsMemory(conversation, productContext.product_context_products || productContext.recent_products_data || []);
  const siteContext = await buildSiteContextForConfig(input, config);
  const operationalContext = await buildOperationalContextForConfig(input, config, contact, conversation);
  const knowledgeContext = buildKnowledgeContextForConfig(config);
  const parts = [];
  const historyText = formatConversationHistory(conversationHistory);
  if (historyText) parts.push(`Historico da conversa desde a primeira mensagem disponivel:\n${historyText}`);
  if (input) parts.push(String(input));
  if (knowledgeContext) parts.push(knowledgeContext);
  if (siteContext.contextText) parts.push(buildSiteContextText(siteContext));
  if (operationalContext.contextText) parts.push(buildOperationalContextText(operationalContext));
  if (productContext.contextText) parts.push(buildProductContextText(productContext));
  else if (productContext.lookupAttempted) parts.push('O cliente pediu fotos ou produtos, mas nenhum produto com imagem foi encontrado agora. Nao diga que vai enviar fotos e nao prometa encaminhar para atendente. Responda de forma natural que nao encontrou esse produto no momento e pergunte se o cliente quer buscar por outro nome, cor ou categoria.');
  if (media) parts.push(`Midia recebida:\n${getMediaDescription(media)}`);
  return {
    inputText: parts.filter(Boolean).join('\n\n'),
    productImages: productContext.imageUrls || [],
    productCards: productContext.productCards || [],
    productContextProducts: productContext.product_context_products || productContext.recent_products_data || [],
    productLookupAttempted: productContext.lookupAttempted === true,
    productSearchText: productContext.searchText || '',
    productsFound: productContext.productsFound === true || Boolean(productContext.contextText)
  };
}

async function callClaude({ apiKey, config, input, systemPrompt, media, conversationHistory, contact, conversation }) {
  const startedAt = Date.now();
  const builtInput = await buildClaudeInputContent({ input, media, config, conversationHistory, contact, conversation });
  const body = {
    model: normalizeConfiguredModel(config.model, 'claude'),
    max_tokens: config.max_tokens || 500,
    temperature: typeof config.temperature === 'number' ? config.temperature : 0.7,
    system: systemPrompt,
    messages: [{ role: 'user', content: builtInput.inputText || 'Responda ao cliente de forma util no atendimento.' }]
  };
  let response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  let data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const fallbackModel = getFallbackModel('claude', body.model);
    const canFallback = fallbackModel && /model|not found|does not exist|unsupported|invalid|access/i.test(String(data?.error?.message || ''));
    if (canFallback) {
      const fallbackBody = { ...body, model: fallbackModel };
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(fallbackBody)
      });
      data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error?.message || `Claude respondeu HTTP ${response.status}`);
      }
      body.model = fallbackModel;
    } else {
      throw new Error(data?.error?.message || `Claude respondeu HTTP ${response.status}`);
    }
  }

  const text = (data.content || [])
    .map(part => part?.text || '')
    .join('\n')
    .trim();

  if (!text) throw new Error('Claude nao retornou texto na resposta');

  const inputTokens = data?.usage?.input_tokens || 0;
  const outputTokens = data?.usage?.output_tokens || 0;

  return {
    response: text,
    provider: 'claude',
    model: data.model || config.model,
    requested_model: body.model === normalizeConfiguredModel(config.model, 'claude') ? undefined : normalizeConfiguredModel(config.model, 'claude'),
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    processing_time_ms: Date.now() - startedAt,
    product_images: builtInput.productImages || [],
    product_cards: builtInput.productCards || [],
    product_context_products: builtInput.productContextProducts || [],
    recent_products_data: builtInput.productContextProducts || [],
    product_lookup_attempted: builtInput.productLookupAttempted === true,
    product_search_text: builtInput.productSearchText || '',
    products_found: builtInput.productsFound === true
  };
}

async function getAISetup(supabase, clientId) {
  const [{ data: config }, { data: client }, { data: integrations }] = await Promise.all([
    supabase
      .from('evolution_ai_config')
      .select('*')
      .eq('client_id', clientId)
      .single(),
    supabase
      .from('evolution_clients')
      .select('id, openai_api_key, claude_api_key, ai_model, auto_reply_enabled')
      .eq('id', clientId)
      .single(),
    supabase
      .from('evolution_integrations')
      .select('integration_type, integration_name, api_endpoint, api_key, api_secret, config, enabled, is_active, status')
      .eq('client_id', clientId)
      .in('integration_type', ['facilzap', 'ecommerce', 'crm'])
      .or('enabled.eq.true,is_active.eq.true')
  ]);

  return { config, client, integrations: Array.isArray(integrations) ? integrations : (integrations ? [integrations] : []) };
}

async function countTodayUsage(supabase, clientId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { count } = await supabase
    .from('evolution_ai_log')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('status', 'success')
    .gte('created_at', today.toISOString());

  return count || 0;
}

async function logAIResult(supabase, payload) {
  const baseLog = {
    id: uuidv4(),
    client_id: payload.client_id,
    conversation_id: payload.conversation_id || null,
    input_message: payload.input_message || null,
    provider: payload.provider || null,
    model: payload.model || null,
    tokens_used: payload.total_tokens || 0,
    response_time_ms: payload.processing_time_ms || 0,
    success: payload.status === 'success',
    model_used: payload.model,
    prompt_tokens: payload.prompt_tokens || 0,
    completion_tokens: payload.completion_tokens || 0,
    total_tokens: payload.total_tokens || 0,
    cost_usd: null,
    ai_response: payload.response || null,
    confidence_score: null,
    processing_time_ms: payload.processing_time_ms || 0,
    status: payload.status,
    error_message: payload.error_message || null,
    created_at: new Date().toISOString()
  };

  const { error } = await supabase.from('evolution_ai_log').insert([baseLog]);
  if (!error) return;

  console.warn('[AI] Falha ao gravar log no schema atual:', error.message);
}

async function getConversationMessagesFromStart(supabase, clientId, conversationId) {
  if (!conversationId) return [];
  const { data, error } = await supabase
    .from('evolution_messages')
    .select('content, direction, is_from_ai, created_at')
    .eq('client_id', clientId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(1000);

  if (error || !Array.isArray(data)) return [];
  return data.filter(item => String(item.content || '').trim());
}

async function generateAIResponse({ supabase, clientId, message, conversation, contact, media }) {
  const { config, client, integrations } = await getAISetup(supabase, clientId);

  if (!config || !config.enabled) {
    return { skipped: true, reason: 'IA desabilitada' };
  }

  if (client?.auto_reply_enabled === false) {
    return { skipped: true, reason: 'Resposta automatica desabilitada' };
  }

  if (!message || !String(message).trim()) {
    return { skipped: true, reason: 'Mensagem sem texto' };
  }

  const provider = getProviderForModel(config.model || client?.ai_model);
  const effectiveConfig = {
    ...config,
    product_integrations: (integrations || [])
      .filter(integration => integration?.api_endpoint)
      .map(integration => ({
        integration_type: integration.integration_type,
        integration_name: integration.integration_name,
        api_endpoint: integration.api_endpoint,
        api_key: integration.api_key,
        api_secret: integration.api_secret,
        config: {
          ...(DEFAULT_INTEGRATION_CONFIG[integration.integration_type] || {}),
          ...(integration.config || {})
        },
        headers: buildIntegrationHeaders(integration)
      })),
    model: config.model || client?.ai_model || (provider === 'claude' ? 'claude-3-haiku' : 'gpt-4o-mini')
  };
  const systemPrompt = buildSystemPrompt(effectiveConfig, contact, conversation);
  const conversationHistory = await getConversationMessagesFromStart(supabase, clientId, conversation?.id);
  const apiKeyForClassify = provider === 'claude' ? client?.claude_api_key : client?.openai_api_key;
  effectiveConfig._ragRuntimeContext = {
    clientId,
    client_id: clientId,
    supabase,
    conversation,
    contact,
    openaiApiKey: client?.openai_api_key,
    apiKey: client?.openai_api_key
  };

  let plannerShadowResult = null;
  try {
    plannerShadowResult = await answerPlannerShadowMode({
      message,
      conversation,
      contact,
      conversationHistory,
      effectiveConfig,
      config,
      provider,
      apiKey: apiKeyForClassify
    });
  } catch (error) {
    console.warn('[PLANNER SHADOW ERROR] message=' + String(error?.message || error).slice(0, 180));
  }

  if (shouldUsePlannerForStorePolicy(plannerShadowResult?.plan)) {
    try {
      const plannerActiveResult = await resolveStorePolicyWithPlanner(
        plannerShadowResult.plan,
        plannerShadowResult.conversationState || buildConversationStateForPlanner({ message, conversation, contact, conversationHistory }),
        {
          message,
          conversation,
          contact,
          conversationHistory,
          clientId,
          supabase,
          effectiveConfig,
          config,
          provider,
          apiKey: apiKeyForClassify,
          openaiApiKey: client?.openai_api_key
        }
      );
      if (plannerActiveResult) return plannerActiveResult;
    } catch (error) {
      console.warn('[PLANNER ACTIVE FALLBACK] reason=' + String(error?.message || error).slice(0, 180));
    }
  }

  if (isSimpleGreeting(message)) {
    const response = suppressRepeatedGreeting(buildGreetingResponse(message, effectiveConfig), effectiveConfig.greeting_message, conversation);
    return {
      skipped: false,
      response,
      provider: 'system',
      model: 'simple_greeting',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      processing_time_ms: 0,
      product_images: [],
      product_cards: []
    };
  }

  const selectedProductMemory = getSelectedProductMemory(conversation);
  const pendingProductSelectionMemory = getPendingProductSelectionMemory(conversation);
  const pendingActionMemory = getPendingActionMemory(conversation);
  const hasSelectedProductMemory = Boolean(selectedProductMemory);
  const hasPendingProductSelection = Boolean(pendingProductSelectionMemory);
  const hasPendingActionMemory = Boolean(pendingActionMemory);
  const explicitNewProductRequest = isExplicitNewProductRequest(message);
  if (explicitNewProductRequest) {
    console.log('[STOCK FOLLOWUP SKIP] reason=explicit_new_product_request');
  }
  const earlyStockFollowupIntent = (!explicitNewProductRequest && (isStockAvailabilityFollowUp(message) || (hasSelectedProductMemory && isSelectedProductFollowUp(message)) || (extractProductIndexReference(message) && (getRecentProductsMemory(conversation).length > 0 || hasPendingProductSelection))))
    ? buildStockFollowupIntentFromMessage(message, conversationHistory, 'early_before_product_lookup', conversation)
    : null;
  if (earlyStockFollowupIntent) {
    const earlyStockAnswer = buildRecentProductStockAnswer(earlyStockFollowupIntent, message, conversationHistory, conversation);
    if (earlyStockAnswer) {
      console.log('[FOLLOWUP DECISION] structured_recent_stock=true model=' + earlyStockAnswer.model);
      return {
        skipped: false,
        response: earlyStockAnswer.response,
        provider: 'system',
        model: earlyStockAnswer.model,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        processing_time_ms: 0,
        product_images: [],
        product_cards: [],
        product_lookup_attempted: false,
        product_search_text: ''
      };
    }
  }

  if (!explicitNewProductRequest && hasSelectedProductMemory && isSelectedProductPurchaseIntent(message)) {
    const selectedMemory = getSelectedProductMemory(conversation);
    if (selectedMemory?.product) {
      console.log('[PURCHASE FOLLOWUP] selected_product="' + String(selectedMemory.product.title || '').replace(/"/g, '\\"') + '"');
      return {
        skipped: false,
        response: buildSelectedProductPurchaseResponse(selectedMemory.product, selectedMemory.lastFilters || {}),
        provider: 'system',
        model: 'selected_product_purchase',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        processing_time_ms: 0,
        product_images: [],
        product_cards: [],
        product_lookup_attempted: false,
        product_search_text: ''
      };
    }
  }

  if (isPendingActionConfirmation(message)) {
    const pendingAction = pendingActionMemory || getPendingActionMemory(conversation);
    if (pendingAction) {
      const pendingResult = await executePendingActionForConversation(pendingAction, message, {
        effectiveConfig,
        conversationHistory,
        conversation,
        apiKey: apiKeyForClassify,
        provider
      });
      clearPendingActionMemory(conversation, 'executed');
      if (pendingResult) return pendingResult;
    } else {
      console.log('[PENDING ACTION MISS] reason=no_pending_action');
    }
  }

  if (isShortContextualReply(message) && !hasPendingActionMemory && !hasPendingProductSelection && !hasSelectedProductMemory) {
    console.log('[CONTEXTUAL SHORT MESSAGE] action=clarify reason=no_pending_state');
    return {
      skipped: false,
      response: 'Certo. Me diga o que voce quer consultar.',
      provider: 'system',
      model: 'contextual_short_reply_without_context',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      processing_time_ms: 0,
      product_images: [],
      product_cards: [],
      product_lookup_attempted: false,
      product_search_text: ''
    };
  }

  if (!isWithinWorkingHours(config, config.timezone || 'America/Sao_Paulo')) {
    const productContext = await buildProductContextForConfig(message, effectiveConfig, conversationHistory);
    saveRecentProductsMemory(conversation, productContext.product_context_products || productContext.recent_products_data || []);
    if (productContext.lookupAttempted) {
      const productCards = productContext.productCards || [];
      const cleanProductQuery = getProductSearchPhrase(message) || productContext.searchText || message;
      saveLastProductSearchRequestMemory(conversation, message, cleanProductQuery);
      if (productCards.length === 0) {
        clearRecentProductsMemory(conversation, 'outside_hours_product_lookup_empty');
        return {
          skipped: false,
          response: buildProductLookupEmptyResponse(cleanProductQuery),
          provider: 'catalog',
          model: 'product_lookup_empty',
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          processing_time_ms: 0,
          product_images: [],
          product_cards: [],
          product_lookup_attempted: true,
          product_search_text: cleanProductQuery,
          products_found: false
        };
      }
      return {
        skipped: false,
        response: buildProductCardsResponse(productCards),
        provider: 'catalog',
        model: 'catalog_lookup',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        processing_time_ms: 0,
        product_images: productContext.imageUrls || [],
        product_cards: productCards,
        product_lookup_attempted: true,
        product_search_text: productContext.searchText || cleanProductQuery
      };
    }
    return {
      skipped: false,
      response: buildOutsideWorkingHoursResponse(effectiveConfig),
      provider: 'system',
      model: 'outside_working_hours',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      processing_time_ms: 0,
      product_images: [],
      product_cards: []
    };
  }

  if (includesAnyKeyword(message, config.blacklist_keywords)) {
    return { skipped: true, reason: 'Palavra bloqueada detectada' };
  }

  const todayUsage = await countTodayUsage(supabase, clientId);
  const dailyLimit = config.daily_limit === null || config.daily_limit === undefined ? 50 : Number(config.daily_limit);
  if (dailyLimit > 0 && todayUsage >= dailyLimit) {
    const productContext = await buildProductContextForConfig(message, effectiveConfig, conversationHistory);
    saveRecentProductsMemory(conversation, productContext.product_context_products || productContext.recent_products_data || []);
    if (productContext.lookupAttempted) {
      const productCards = productContext.productCards || [];
      console.log('[AI] Limite diario atingido, usando busca deterministica do catalogo | cards: ' + productCards.length);
      return {
        skipped: false,
        response: productCards.length > 0
          ? buildProductCardsResponse(productCards)
          : productContext.productsFound
            ? buildProductContextSummaryResponse(productContext, productContext.searchText || message)
            : buildProductLookupEmptyResponse(productContext.searchText || message),
        provider: 'catalog',
        model: 'catalog_lookup',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        processing_time_ms: 0,
        product_images: productContext.imageUrls || [],
        product_cards: productCards,
        product_lookup_attempted: true,
        product_search_text: productContext.searchText || message
      };
    }
    return {
      skipped: false,
      response: buildDailyLimitResponse(effectiveConfig),
      provider: 'system',
      model: 'daily_limit_reached',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      processing_time_ms: 0,
      product_images: [],
      product_cards: []
    };
  }

  // ─── NOVO: Classificação de intenção ────────────────────────────────────────
  let customerIntent = await classifyCustomerIntent({
    apiKey: apiKeyForClassify,
    provider,
    message,
    conversationHistory,
    config: effectiveConfig
  });
  customerIntent = coerceStockFollowupIntent(customerIntent, message, conversationHistory, conversation);
  if ((customerIntent.intent === 'knowledge_question' || customerIntent.intent === 'general_message' || customerIntent.intent === 'clarification')
    && isCatalogFollowUpRequest(message)
    && getRecentCustomerProductRequest(conversationHistory, conversation)) {
    const followUpQuery = getProductSearchPhrase(getRecentCustomerProductRequest(conversationHistory, conversation));
    console.log('[CLASSIFY COERCE PRODUCT FOLLOWUP] from=' + customerIntent.intent + ' query="' + followUpQuery + '"');
    customerIntent = {
      ...customerIntent,
      intent: 'product_followup',
      source: 'recent_context',
      search_query: followUpQuery,
      question_type: 'product_search',
      sources_needed: ['recent_products', 'product_api'],
      operation: 'search',
      reference: 'recent_products',
      needs_clarification: false,
      clarification_question: '',
      entities: {
        ...(customerIntent.entities || {}),
        product: followUpQuery
      }
    };
  }

  // Log seguro da intenção completa (sem token)
  console.log('[INTENT FULL] intent=' + customerIntent.intent
    + ' qtype=' + (customerIntent.question_type || 'n/a')
    + ' op=' + (customerIntent.operation || 'n/a')
    + ' sources=' + JSON.stringify(customerIntent.sources_needed || [])
    + ' query="' + (customerIntent.search_query || '') + '"'
    + ' semantic="' + (customerIntent.semantic_query || '') + '"'
    + ' theme="' + (customerIntent.theme || '') + '"'
    + ' product_type="' + (customerIntent.product_type || '') + '"'
    + ' allow_related=' + (customerIntent.allow_related_products === true ? 'true' : 'false')
    + ' entities=' + JSON.stringify(customerIntent.entities || {}));

  // ─── 1. Pedido/Rastreio ────────────────────────────────────────────────────
  if (customerIntent.intent === 'order_lookup' || customerIntent.intent === 'tracking_lookup') {
    const operationalContext = await buildOperationalContextForConfig(message, effectiveConfig, contact, conversation);
    const operationalResponse = buildOperationalSummaryResponse(operationalContext, message);
    if (operationalResponse) {
      return {
        skipped: false,
        response: operationalResponse,
        provider: 'integration',
        model: 'facilzap_operational_lookup',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        processing_time_ms: 0,
        product_images: [],
        product_cards: [],
        product_lookup_attempted: false,
        product_search_text: ''
      };
    }
    // Se integração não retornou dados, cai para LLM com contexto operacional
  }

  // ─── 2. Follow-up de estoque/tamanho contextual ──────────────────────────
  if (customerIntent.question_type === 'stock_by_size_color' || customerIntent.intent === 'product_stock_followup') {
    const recentStockAnswer = buildRecentProductStockAnswer(customerIntent, message, conversationHistory, conversation);
    if (recentStockAnswer) {
      console.log('[FOLLOWUP DECISION] structured_recent_stock=true model=' + recentStockAnswer.model);
      return {
        skipped: false,
        response: recentStockAnswer.response,
        provider: 'system',
        model: recentStockAnswer.model,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        processing_time_ms: 0,
        product_images: [],
        product_cards: [],
        product_lookup_attempted: false,
        product_search_text: ''
      };
    }
  }

  if (customerIntent.intent === 'product_stock_followup') {
    // Guard: se a mensagem contém produto explícito, o LLM classificou errado.
    // Redirecionar para product_search com a query extraída.
    const _stockFollowupOverrideQuery = getProductSearchPhrase(message);
    // Tentar responder com dados dos cards recentes antes de buscar
    const _recentStockCtx = getReliableRecentProductStockContext(conversationHistory, conversation);
    if (!_stockFollowupOverrideQuery && _recentStockCtx.length > 0) {
      const requestedSizes = customerIntent.filters && customerIntent.filters.size
        ? String(customerIntent.filters.size).split(',').map(s => s.trim()).filter(Boolean)
        : extractRequestedSizes(message);
      // Verificar se algum produto recente tem o tamanho pedido
      const matchingProduct = requestedSizes.length > 0
        ? _recentStockCtx.find(p => requestedSizes.some(s => p.sizes.includes(s)))
        : _recentStockCtx[0];
      if (matchingProduct) {
        const sizeInfo = requestedSizes.length > 0
          ? requestedSizes.join(', ')
          : (matchingProduct.sizes.length > 0 ? matchingProduct.sizes.join(', ') : 'informado');
        const stockInfo = matchingProduct.stock !== null ? String(matchingProduct.stock) : 'disponível';
        const hasSizeInCard = requestedSizes.length === 0 || matchingProduct.sizes.some(s => requestedSizes.includes(s));
        let stockResponse;
        if (hasSizeInCard && matchingProduct.sizes.length > 0) {
          stockResponse = `Pelo catalogo, esse modelo aparece com tamanho ${sizeInfo} e estoque ${stockInfo}.`
            + (matchingProduct.sizes.length > 1
              ? ''
              : ' Nao tenho a separacao exata por tamanho, mas o estoque total e ' + stockInfo + '.');
        } else {
          stockResponse = `Esse produto aparece com tamanho ${sizeInfo} e estoque total ${stockInfo}.`;
        }
        console.log('[FOLLOWUP DECISION] stock_from_recent_card=true product="' + matchingProduct.title + '" sizes=' + JSON.stringify(matchingProduct.sizes) + ' stock=' + matchingProduct.stock);
        return {
          skipped: false,
          response: stockResponse,
          provider: 'system',
          model: 'recent_card_stock',
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          processing_time_ms: 0,
          product_images: [],
          product_cards: [],
          product_lookup_attempted: false,
          product_search_text: ''
        };
      }
    }
    if (_stockFollowupOverrideQuery) {
      console.log('[FOLLOWUP DECISION] explicit_product=true reason=override_stock_followup query="' + _stockFollowupOverrideQuery + '"');
      const _overrideQuery = customerIntent.search_query || _stockFollowupOverrideQuery;
      console.log('[PRODUCT CLEAN QUERY] "' + _overrideQuery + '" (override from product_stock_followup)');
      const _overrideContext = await buildProductContextForConfig(_overrideQuery, effectiveConfig, conversationHistory);
      saveRecentProductsMemory(conversation, _overrideContext.product_context_products || _overrideContext.recent_products_data || []);
      if (_overrideContext.lookupAttempted) {
        const _overrideCards = _overrideContext.productCards || [];
        if (_overrideCards.length > 0 || _overrideContext.productsFound) {
          return {
            skipped: false,
            response: _overrideCards.length > 0
              ? buildProductCardsResponse(_overrideCards)
              : buildProductContextSummaryResponse(_overrideContext, _overrideContext.searchText || _overrideQuery),
            provider: 'catalog',
            model: 'catalog_lookup',
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            processing_time_ms: 0,
            product_images: _overrideContext.imageUrls || [],
            product_cards: _overrideCards,
            product_lookup_attempted: true,
            product_search_text: _overrideContext.searchText || _overrideQuery
          };
        }
      }
      // Busca não encontrou nada: sai do bloco e cai para product_search/semântico abaixo
    }
    if (customerIntent.needs_clarification && !_stockFollowupOverrideQuery) {
      const recentProductTitles = getRecentlySentProductTitles(conversationHistory);
      const responseText = buildProductSelectionList(recentProductTitles);
      return {
        skipped: false,
        response: responseText,
        provider: 'system',
        model: 'contextual_size_stock_question',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        processing_time_ms: 0,
        product_images: [],
        product_cards: [],
        product_lookup_attempted: false,
        product_search_text: ''
      };
    }
    // Se tem produto específico e não precisa de clarificação, busca normal
    if (customerIntent.reference === 'specific_product' && customerIntent.selected_product_index !== null) {
      // Fase 2: responder com estoque exato. Por enquanto, cai para general_message.
    }
    // Sem produto específico: cai para LLM com contexto do histórico
  }

  // ─── 3. Follow-up de produto (mais opções, fotos) ───────────────────────
  if (customerIntent.intent === 'product_followup') {
    const lastProductRequest = getRecentCustomerProductRequest(conversationHistory, conversation);
    // Tokens da mensagem atual — pode ser refinamento de tema, cor, tamanho ou modelo
    const _followupCurrentTokens = getProductSearchPhrase(message);
    const _followupHasOwnTokens = _followupCurrentTokens.length > 0;
    if (lastProductRequest) {
      const _followupBaseQuery = getProductSearchPhrase(lastProductRequest);
      // Se a mensagem atual tem tokens próprios (refinamento/complemento),
      // combinar com a busca anterior para formar query completa.
      // Ex: combina o pedido anterior com o novo refinamento e deduplica tokens.
      let cleanQuery = _followupBaseQuery;
      if (_followupHasOwnTokens && _followupBaseQuery) {
        // Verificar se a mensagem atual é busca ampla por tema (sem produto específico do contexto)
        // Exemplos: perguntas amplas por tema/personagem sem categoria nova.
        // Nesses casos NÃO herdar o produto anterior — usar só o tema
        const _broadThemeOnly = /\b(tema|personagem|personagens|marca|estampa|licenciado|licenciada)\b/i.test(normalizeSearchText(message))
          && !/\b(camisa|camiseta|blusa|vestido|saia|conjunto|moletom|body|roupa|pijama|jaqueta|casaco|bermuda|short|calca|cropped)\b/i.test(normalizeSearchText(message));
        if (_broadThemeOnly) {
          cleanQuery = _followupCurrentTokens;
          console.log('[CONTEXT MERGE] broad_theme=true, ignorando produto anterior. query="' + cleanQuery + '"');
        } else {
          const baseTokens = _followupBaseQuery.split(' ').filter(Boolean);
          const currentTokens = _followupCurrentTokens.split(' ').filter(Boolean);
          // Merge sem duplicatas (por inclusão de substring)
          const merged = [...baseTokens];
          for (const t of currentTokens) {
            if (!merged.some(b => b.includes(t) || t.includes(b))) {
              merged.push(t);
            }
          }
          cleanQuery = merged.slice(0, 6).join(' ');
          console.log('[CONTEXT MERGE] previous="' + _followupBaseQuery + '" current="' + _followupCurrentTokens + '" merged="' + cleanQuery + '"');
        } // fim else merge
      } else if (_followupHasOwnTokens && !_followupBaseQuery) {
        // Sem histórico de produto, usar só os tokens atuais
        cleanQuery = _followupCurrentTokens;
      }
      console.log('[FOLLOWUP DECISION] explicit_product=' + _followupHasOwnTokens + ' reason=product_followup query="' + cleanQuery + '"');
      if (cleanQuery) {
        console.log('[PRODUCT CLEAN QUERY] "' + cleanQuery + '" (product_followup)');
        const followupLookupMessage = _followupHasOwnTokens ? cleanQuery : message;
        const productContext = await buildProductContextForConfig(followupLookupMessage, effectiveConfig, conversationHistory, { baseProductRequest: lastProductRequest, conversation });
        saveRecentProductsMemory(conversation, productContext.product_context_products || productContext.recent_products_data || []);
        if (productContext.lookupAttempted) {
          const productCards = productContext.productCards || [];
          if (productCards.length > 0 || productContext.productsFound) {
            return {
              skipped: false,
              response: productCards.length > 0
                ? buildProductCardsResponse(productCards)
                : buildProductContextSummaryResponse(productContext, productContext.searchText || cleanQuery),
              provider: 'catalog',
              model: 'catalog_lookup',
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
              processing_time_ms: 0,
              product_images: productContext.imageUrls || [],
              product_cards: productCards,
              product_lookup_attempted: true,
              product_search_text: productContext.searchText || cleanQuery
            };
          }
          // Não encontrou nada na busca literal — tentar semântico se há tema
          // (cai para product_search abaixo com a mesma query combinada)
          if (_followupHasOwnTokens) {
            console.log('[FOLLOWUP DECISION] explicit_product=true reason=followup_no_cards_try_semantic');
            // Reprocessar como product_search para acionar semântico
            const _semCards = productContext.productCards || [];
            const _semAllCollected = productContext.allProductsCollected || [];
            const _semQuery =
              (customerIntent.semantic_query && String(customerIntent.semantic_query).trim()) ||
              cleanQuery;
            const _semThemeToken = customerIntent.theme ? normalizeSearchText(String(customerIntent.theme)) : '';
            const _semCardsAtendeTema = _semThemeToken
              ? _semCards.some(card => {
                  const h = normalizeSearchText([card.title, card.description].join(' '));
                  return h.includes(_semThemeToken) || _semThemeToken.split(' ').some(t => t.length >= 4 && h.includes(t));
                })
              : true;
            const _semDecisionReason = _semCards.length === 0
              ? 'cards_zero'
              : (!_semCardsAtendeTema && _semThemeToken ? 'cards_sem_tema' : 'nao_necessario');
            const _canSem = (
              _semDecisionReason !== 'nao_necessario' &&
              _semAllCollected.length > 0 &&
              _semQuery.length > 0 &&
              isUsableProviderApiKey(provider, apiKeyForClassify)
            );
            console.log('[SEMANTIC DECISION] reason=' + _semDecisionReason + ' | canRun=' + _canSem + ' | candidatos=' + _semAllCollected.length);
            if (_canSem) {
              console.log('[SEMANTIC RANK] candidatos: ' + _semAllCollected.length + ' | query: "' + _semQuery + '"');
              const _semResult = await semanticRankProducts(_semAllCollected, customerIntent, _semQuery, apiKeyForClassify, provider);
              console.log('[SEMANTIC RANK] matches: ' + ((_semResult.productCards || []).length));
              if (_semResult.productCards && _semResult.productCards.length > 0) {
                const _semCardsImg = _semResult.productCards.filter(c => c.imageUrl);
                const _semCardsTxt = _semResult.productCards.filter(c => !c.imageUrl);
                const _semNoteText = buildRelatedProductsNote(cleanQuery || _semQuery, customerIntent);
                saveRecentProductsMemory(conversation, _semResult.products || []);
                console.log('[SEMANTIC CARDS] cards com imagem: ' + _semCardsImg.length + ' | sem imagem: ' + _semCardsTxt.length);
                if (_semCardsImg.length > 0) {
                  return {
                    skipped: false,
                    response: _semNoteText + '\n\n' + buildProductCardsResponse(_semCardsImg),
                    provider: 'catalog',
                    model: 'semantic_catalog_lookup',
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0,
                    processing_time_ms: 0,
                    product_images: _semCardsImg.map(c => c.imageUrl).filter(Boolean),
                    product_cards: _semCardsImg,
                    product_lookup_attempted: true,
                    product_search_text: _semQuery,
                    products_found: true,
                    semantic_rank_used: true
                  };
                }
                const _semListaTxt = _semCardsTxt.map(c => '• ' + c.title + (c.description ? ' — ' + c.description : '')).join('\n');
                return {
                  skipped: false,
                  response: _semNoteText + '\n\n' + _semListaTxt,
                  provider: 'catalog',
                  model: 'semantic_catalog_lookup_text',
                  prompt_tokens: 0,
                  completion_tokens: 0,
                  total_tokens: 0,
                  processing_time_ms: 0,
                  product_images: [],
                  product_cards: [],
                  product_lookup_attempted: true,
                  product_search_text: _semQuery,
                  products_found: true,
                  semantic_rank_used: true
                };
              }
            }
          }
          console.log('[FOLLOWUP LOOKUP EMPTY] query="' + cleanQuery.replace(/"/g, '\\"') + '"');
          clearRecentProductsMemory(conversation, 'product_followup_lookup_empty');
          clearPendingActionMemory(conversation, 'product_followup_lookup_empty');
          return {
            skipped: false,
            response: buildProductLookupEmptyResponse(cleanQuery),
            provider: 'catalog',
            model: 'product_followup_lookup_empty',
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            processing_time_ms: 0,
            product_images: [],
            product_cards: [],
            product_lookup_attempted: true,
            product_search_text: productContext.searchText || cleanQuery
          };
        }
      }
    }
    // Sem query clara: cai para LLM com histórico
  }

  // ─── 4. Busca de produto novo ────────────────────────────────────────────
  if (customerIntent.intent === 'product_search') {
    const cleanQuery = customerIntent.search_query || getProductSearchPhrase(message);
    console.log('[PRODUCT CLEAN QUERY] "' + cleanQuery + '"');
    if (cleanQuery) {
      const ragObservationQuery = [message, cleanQuery].filter(Boolean).join(' ');
      saveLastProductSearchRequestMemory(conversation, message, cleanQuery);
      const productContext = await buildProductContextForConfig(cleanQuery, effectiveConfig, conversationHistory, { ragObservationQuery, conversation });
      saveRecentProductsMemory(conversation, productContext.product_context_products || productContext.recent_products_data || []);
      if (productContext.lookupAttempted) {
        const productCards = productContext.productCards || [];
        if (productCards.length > 0 || productContext.productsFound) {
          return {
            skipped: false,
            response: productCards.length > 0
              ? buildProductCardsResponse(productCards)
              : buildProductContextSummaryResponse(productContext, productContext.searchText || cleanQuery),
            provider: 'catalog',
            model: 'catalog_lookup',
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            processing_time_ms: 0,
            product_images: productContext.imageUrls || [],
            product_cards: productCards,
            product_lookup_attempted: true,
            product_search_text: productContext.searchText || cleanQuery
          };
        }

        // ── FALLBACK SEMÂNTICO ────────────────────────────────────────────────
        // Ativa se:
        //   1. intent === 'product_search' (garantido pelo if externo)
        //   2. allProductsCollected.length > 0 (catálogo coletou produtos)
        //   3. semanticQuery não vazio (sem usar message bruta/normalizada)
        //   4. allow_related_products !== false
        //   5. API key válida
        //   E uma das condições:
        //   A) productCards.length === 0 (busca normal não achou nada), OU
        //   B) customerIntent.theme existe e nenhum card encontrado tem relação com o tema
        let allProductsCollected = (productContext.allProductsCollected || []);
        // Se a API não retornou nenhum candidato mas há um product_type definido,
        // tentar busca ampliada com apenas o tipo (ex: "roupa" ou "camiseta")
        // para ter candidatos para o semântico avaliar semanticamente.
        if (allProductsCollected.length === 0 && customerIntent.product_type && isUsableProviderApiKey(provider, apiKeyForClassify)) {
          const broadQuery = normalizeSearchText(String(customerIntent.product_type)).split(' ').slice(0, 2).join(' ');
          if (broadQuery && broadQuery !== cleanQuery) {
            console.log('[SEMANTIC DECISION] allProductsCollected=0 tentando busca ampliada com product_type="' + broadQuery + '"');
            const broadContext = await buildProductContextForConfig(broadQuery, effectiveConfig, conversationHistory);
            saveRecentProductsMemory(conversation, broadContext.product_context_products || broadContext.recent_products_data || []);
            if (broadContext.allProductsCollected && broadContext.allProductsCollected.length > 0) {
              allProductsCollected = broadContext.allProductsCollected;
              console.log('[SEMANTIC DECISION] busca ampliada retornou ' + allProductsCollected.length + ' candidatos');
            } else if (broadContext.productCards && broadContext.productCards.length > 0) {
              // Usar os products dos cards como candidatos
              allProductsCollected = broadContext.allProductsCollected || [];
              console.log('[SEMANTIC DECISION] busca ampliada retornou cards diretos: ' + (broadContext.productCards || []).length);
            }
          }
        }
        const semanticQuery =
          (customerIntent.semantic_query && String(customerIntent.semantic_query).trim()) ||
          (customerIntent.search_query && String(customerIntent.search_query).trim()) ||
          getProductSearchPhrase(cleanQuery) ||
          '';
        // Verificar se os cards encontrados atendem o tema pedido
        const themeToken = customerIntent.theme ? normalizeSearchText(String(customerIntent.theme)) : '';
        const cardsAtendeTema = themeToken
          ? productCards.some(card => {
              const haystack = normalizeSearchText([card.title, card.description].join(' '));
              return haystack.includes(themeToken) || themeToken.split(' ').some(t => t.length >= 4 && haystack.includes(t));
            })
          : true; // sem tema definido: considera atendido
        const semDecisionReason = productCards.length === 0
          ? 'cards_zero'
          : (!cardsAtendeTema && themeToken ? 'cards_sem_tema' : 'nao_necessario');
        const canTrySemanticRank = (
          semDecisionReason !== 'nao_necessario' &&
          allProductsCollected.length > 0 &&
          semanticQuery.length > 0 &&
          customerIntent.allow_related_products !== false &&
          isUsableProviderApiKey(provider, apiKeyForClassify)
        );
        console.log('[SEMANTIC DECISION] reason=' + semDecisionReason
          + ' | theme="' + themeToken + '"'
          + ' | cards=' + productCards.length
          + ' | candidatos=' + allProductsCollected.length
          + ' | canRun=' + canTrySemanticRank);
        if (canTrySemanticRank) {
          console.log('[SEMANTIC RANK] candidatos: ' + allProductsCollected.length + ' | query: "' + semanticQuery + '"');
          const semanticResult = await semanticRankProducts(
            allProductsCollected,
            customerIntent,
            semanticQuery,
            apiKeyForClassify,
            provider
          );
          console.log('[SEMANTIC RANK] matches: ' + ((semanticResult.productCards || []).length));
          if (semanticResult.productCards && semanticResult.productCards.length > 0) {
            // Separar cards com e sem imageUrl para não prometer foto quando não há imagem
            const cardsComImagem = semanticResult.productCards.filter(c => c.imageUrl);
            const cardsSemImagem = semanticResult.productCards.filter(c => !c.imageUrl);
            const noteText = buildRelatedProductsNote(cleanQuery || semanticQuery, customerIntent);
            saveRecentProductsMemory(conversation, semanticResult.products || []);
            console.log('[SEMANTIC CARDS] cards com imagem: ' + cardsComImagem.length + ' | sem imagem: ' + cardsSemImagem.length);
            if (cardsComImagem.length > 0) {
              // Retorna product_cards + response com buildProductCardsResponse
              // para que o sistema envie o carrossel direto, sem passar pelo LLM
              return {
                skipped: false,
                response: noteText + '\n\n' + buildProductCardsResponse(cardsComImagem),
                provider: 'catalog',
                model: 'semantic_catalog_lookup',
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
                processing_time_ms: 0,
                product_images: cardsComImagem.map(c => c.imageUrl).filter(Boolean),
                product_cards: cardsComImagem,
                product_lookup_attempted: true,
                product_search_text: semanticQuery,
                products_found: true,
                semantic_rank_used: true
              };
            }
            // Só cards sem imagem: resumo textual, sem prometer foto
            const listaTexto = cardsSemImagem.map(c => '• ' + c.title + (c.description ? ' — ' + c.description : '')).join('\n');
            return {
              skipped: false,
              response: noteText + '\n\n' + listaTexto,
              provider: 'catalog',
              model: 'semantic_catalog_lookup_text',
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
              processing_time_ms: 0,
              product_images: [],
              product_cards: [],
              product_lookup_attempted: true,
              product_search_text: semanticQuery,
              products_found: true,
              semantic_rank_used: true
            };
          }
        }
        // ── FIM FALLBACK SEMÂNTICO ────────────────────────────────────────────

        // Se chegou aqui: busca literal falhou E semântico falhou/não pôde rodar.
        // Resposta humana sem termos técnicos, sem passar pelo LLM.
        if (productContext.lookupAttempted) {
          const _humanFallbackQuery = cleanQuery || semanticQuery || '';
          console.log('[PRODUCT FALLBACK HUMAN] reason=semantic_failed query="' + _humanFallbackQuery + '"');
          clearRecentProductsMemory(conversation, 'product_lookup_empty');
          savePendingActionMemory(conversation, {
            type: 'search_related_products',
            originalQuery: _humanFallbackQuery,
            semanticQuery: buildRelatedSemanticQuery(_humanFallbackQuery, customerIntent),
            allow_related_products: true,
            customerIntent: {
              ...customerIntent,
              allow_related_products: true
            }
          });
          return {
            skipped: false,
            response: buildProductLookupEmptyResponse(_humanFallbackQuery),
            provider: 'catalog',
            model: 'product_lookup_empty',
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            processing_time_ms: 0,
            product_images: [],
            product_cards: [],
            product_lookup_attempted: true,
            product_search_text: _humanFallbackQuery,
            products_found: false
          };
        }
      }
    }
    // Se cleanQuery estiver vazio: cai para LLM normal
  }

  // ─── 5. Base de conhecimento ─────────────────────────────────────────────
  if (customerIntent.intent === 'knowledge_question') {
    const searchQuery = customerIntent.search_query || message;
    const siteContext = await buildSiteContextForConfig(searchQuery, effectiveConfig);
    if (siteContext.contextText) {
      // Se tem API key válida, deixa o LLM responder com contexto do site
      // Se não, responde deterministicamente com o resumo
      if (!isUsableProviderApiKey(provider, apiKeyForClassify)) {
        return {
          skipped: false,
          response: buildSiteContextSummaryResponse(siteContext),
          provider: 'site',
          model: 'site_lookup',
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          processing_time_ms: 0,
          product_images: [],
          product_cards: []
        };
      }
      // Com API key, o contexto será injetado no callOpenAI/callClaude
    }
  }

  // ─── 6. Mensagem geral ou clarificação ──────────────────────────────────
  if (customerIntent.intent === 'clarification') {
    return {
      skipped: false,
      response: customerIntent.clarification_question || 'Pode me dar mais detalhes?',
      provider: 'system',
      model: 'clarification',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      processing_time_ms: 0,
      product_images: [],
      product_cards: []
    };
  }

  // ─── Fallback: fluxo existente de LLM ────────────────────────────────────
  const apiKey = provider === 'claude' ? client?.claude_api_key : client?.openai_api_key;
  if (!isUsableProviderApiKey(provider, apiKey)) {
    const productContext = await buildProductContextForConfig(message, effectiveConfig, conversationHistory);
    saveRecentProductsMemory(conversation, productContext.product_context_products || productContext.recent_products_data || []);
    if (productContext.lookupAttempted) {
      const productCards = productContext.productCards || [];
      console.log('[AI] API key invalida ou ausente, usando busca deterministica do catalogo | provider: ' + provider + ' | cards: ' + productCards.length);
      return {
        skipped: false,
        response: productCards.length > 0
          ? buildProductCardsResponse(productCards)
          : productContext.productsFound
            ? buildProductContextSummaryResponse(productContext, productContext.searchText || message)
            : buildProductLookupEmptyResponse(productContext.searchText || message),
        provider: 'catalog',
        model: 'catalog_lookup',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        processing_time_ms: 0,
        product_images: productContext.imageUrls || [],
        product_cards: productCards,
        product_lookup_attempted: true,
        product_search_text: productContext.searchText || message
      };
    }
    const siteContext = await buildSiteContextForConfig(message, effectiveConfig);
    if (siteContext.contextText) {
      return {
        skipped: false,
        response: buildSiteContextSummaryResponse(siteContext),
        provider: 'site',
        model: 'site_lookup',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        processing_time_ms: 0,
        product_images: [],
        product_cards: []
      };
    }
    return {
      skipped: false,
      response: buildAIUnavailableResponse(effectiveConfig),
      provider,
      model: 'api_key_unavailable',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      processing_time_ms: 0,
      product_images: [],
      product_cards: []
    };
  }

  try {
    const result = provider === 'claude'
      ? await callClaude({
          apiKey,
          config: effectiveConfig,
          input: message,
          systemPrompt,
          media,
          conversationHistory,
          contact,
          conversation
        })
      : await callOpenAI({ apiKey, config: effectiveConfig, input: message, systemPrompt, media, conversationHistory, contact, conversation });

    // Nunca sobrescrever a resposta do LLM com texto técnico.
    // Se o LLM respondeu e não há product_cards, aceitar a resposta normalizada.
    result.response = normalizeProductMediaResponse(
      suppressRepeatedGreeting(result.response, effectiveConfig.greeting_message, conversation),
      result.product_cards
    );

    await logAIResult(supabase, {
      client_id: clientId,
      conversation_id: conversation?.id,
      input_message: message,
      status: 'success',
      ...result
    });

    return { skipped: false, ...result };
  } catch (error) {
    await logAIResult(supabase, {
      client_id: clientId,
      conversation_id: conversation?.id,
      input_message: message,
      model: effectiveConfig.model,
      status: 'error',
      error_message: error.message
    });

    const apiKeyError = /incorrect api key|invalid api key|api key.*invalid|401/i.test(String(error.message || ''));
    if (apiKeyError) {
      const productContext = await buildProductContextForConfig(message, effectiveConfig, conversationHistory);
      saveRecentProductsMemory(conversation, productContext.product_context_products || productContext.recent_products_data || []);
      const productCards = productContext.productCards || [];
      if (productContext.lookupAttempted) {
        console.log('[AI] API key rejeitada pelo provedor, usando busca deterministica do catalogo | cards: ' + productCards.length);
        return {
          skipped: false,
          response: productCards.length > 0
            ? buildProductCardsResponse(productCards)
            : productContext.productsFound
              ? buildProductContextSummaryResponse(productContext, productContext.searchText || message)
              : buildProductLookupEmptyResponse(productContext.searchText || message),
          provider: 'catalog',
          model: 'catalog_lookup',
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          processing_time_ms: 0,
          product_images: productContext.imageUrls || [],
          product_cards: productCards,
          product_lookup_attempted: true,
          product_search_text: productContext.searchText || message
        };
      }
      const siteContext = await buildSiteContextForConfig(message, effectiveConfig);
      if (siteContext.contextText) {
        return {
          skipped: false,
          response: buildSiteContextSummaryResponse(siteContext),
          provider: 'site',
          model: 'site_lookup',
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          processing_time_ms: 0,
          product_images: [],
          product_cards: []
        };
      }
      return {
        skipped: false,
        response: buildAIUnavailableResponse(effectiveConfig),
        provider,
        model: 'api_key_unavailable',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        processing_time_ms: 0,
        product_images: [],
        product_cards: []
      };
    }

    const productContext = await buildProductContextForConfig(message, effectiveConfig, conversationHistory);
    saveRecentProductsMemory(conversation, productContext.product_context_products || productContext.recent_products_data || []);
    const productCards = productContext.productCards || [];
    if (productContext.lookupAttempted) {
      console.log('[AI] Erro no provedor, usando busca deterministica do catalogo | erro: ' + error.message + ' | cards: ' + productCards.length);
      return {
        skipped: false,
        response: productCards.length > 0
          ? buildProductCardsResponse(productCards)
          : productContext.productsFound
            ? buildProductContextSummaryResponse(productContext, productContext.searchText || message)
            : buildAIProviderErrorResponse(effectiveConfig),
        provider: 'catalog',
        model: productCards.length > 0 ? 'catalog_lookup' : 'provider_error_fallback',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        processing_time_ms: 0,
        product_images: productContext.imageUrls || [],
        product_cards: productCards,
        product_lookup_attempted: true,
        product_search_text: productContext.searchText || message
      };
    }

    return {
      skipped: false,
      response: buildAIProviderErrorResponse(effectiveConfig),
      provider,
      model: 'provider_error_fallback',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      processing_time_ms: 0,
      product_images: [],
      product_cards: []
    };
  }
}
module.exports = {
  generateAIResponse
};
