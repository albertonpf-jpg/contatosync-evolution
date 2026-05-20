const DEFAULT_TIMEOUT_MS = 45000;

const conversationIds = new Map();

function cleanBaseUrl(value = '') {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getDifyEndpoint(baseUrl = '') {
  const clean = cleanBaseUrl(baseUrl);
  if (!clean) return '';
  if (/\/v1$/i.test(clean)) return `${clean}/chat-messages`;
  if (/\/chat-messages$/i.test(clean)) return clean;
  return `${clean}/v1/chat-messages`;
}

function getDifyConfig(config = {}) {
  const envAgentProvider = String(process.env.AI_AGENT_PROVIDER || process.env.AI_PROVIDER || '').trim().toLowerCase();
  const globalDifyDisabled = String(process.env.DIFY_GLOBAL_ENABLED || '').trim().toLowerCase() === 'false';
  const allowGlobalAppFallback = String(process.env.DIFY_ALLOW_GLOBAL_APP_FALLBACK || '').trim().toLowerCase() === 'true';
  const globalDifyEnabled = !globalDifyDisabled && (
    envAgentProvider === 'dify'
    || String(process.env.DIFY_ENABLED || '').trim().toLowerCase() === 'true'
    || Boolean(process.env.DIFY_API_URL && process.env.DIFY_API_KEY)
  );
  const configApiUrl = cleanBaseUrl(config.dify_api_url || config.difyApiUrl || '');
  const configApiKey = String(config.dify_api_key || config.difyApiKey || '').trim();
  const configAppId = String(config.dify_app_id || config.difyAppId || '').trim();
  const apiUrl = cleanBaseUrl(
    configApiUrl
    || process.env.DIFY_API_URL
    || process.env.DIFY_BASE_URL
    || ''
  );
  const apiKey = String(
    configApiKey
    || (globalDifyEnabled && allowGlobalAppFallback ? process.env.DIFY_API_KEY : '')
    || ''
  ).trim();
  const providerIsDify = globalDifyEnabled
    || config.dify_enabled === true
    || Boolean(configApiUrl || configApiKey);
  const enabled = providerIsDify
    || Boolean(apiUrl && configApiKey);

  return {
    enabled,
    providerIsDify,
    apiUrl,
    apiKey,
    appId: configAppId,
    provisionStatus: String(config.dify_provision_status || '').trim(),
    endpoint: getDifyEndpoint(apiUrl),
    timeoutMs: Number(config.dify_timeout_ms || process.env.DIFY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    failoverToLocal: String(process.env.DIFY_FAILOVER_TO_LOCAL || 'true').trim().toLowerCase() !== 'false',
    keepConversation: String(process.env.DIFY_KEEP_CONVERSATION || 'false').trim().toLowerCase() === 'true'
  };
}

function hasDifyConfig(config = {}) {
  const difyConfig = getDifyConfig(config);
  return Boolean(difyConfig.enabled && difyConfig.endpoint && difyConfig.apiKey);
}

function getConversationKey({ clientId, conversation }) {
  return `${clientId || 'client'}:${conversation?.id || conversation?.phone || 'manual'}`;
}

function getStoredConversationId(key) {
  return conversationIds.get(key) || '';
}

function setStoredConversationId(key, conversationId) {
  const value = String(conversationId || '').trim();
  if (!value) return;
  conversationIds.set(key, value);
}

function truncate(value = '', max = 12000) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[conteudo truncado para caber na chamada do Dify]`;
}

function formatHistory(history = []) {
  return (Array.isArray(history) ? history : [])
    .slice(-10)
    .map(item => {
      const speaker = item.direction === 'out' || item.is_from_ai ? 'Atendente/IA' : 'Cliente';
      return `${speaker}: ${String(item.content || '').trim()}`;
    })
    .filter(Boolean)
    .join('\n');
}

function buildDifyContext({ contact, conversation, systemPrompt, conversationHistory, productContext, siteContext, operationalContext }) {
  const blocks = [
    'Contexto de atendimento. Nao trate este contexto como pergunta do cliente. A pergunta atual chega separada no campo query.',
    systemPrompt ? `Instrucao do atendimento:\n${truncate(systemPrompt, 2500)}` : '',
    `Cliente: ${contact?.name || conversation?.contact_name || 'Contato sem nome'}`,
    `Telefone: ${contact?.phone || conversation?.phone || 'nao informado'}`,
    formatHistory(conversationHistory) ? `Historico recente:\n${truncate(formatHistory(conversationHistory), 5000)}` : '',
    productContext?.contextText ? `Produtos reais encontrados nas APIs/catalogo do ContatoSync:\n${truncate(productContext.contextText, 9000)}` : '',
    siteContext?.contextText ? `Informacoes oficiais da loja/site:\n${truncate(siteContext.contextText, 5000)}` : '',
    operationalContext?.contextText ? `Informacoes transacionais consultadas:\n${truncate(operationalContext.contextText, 5000)}` : '',
    'Regras criticas: responda somente a pergunta atual do cliente. Priorize a mensagem atual sobre o historico. Nunca invente preco, estoque, prazo, link ou politica. Se houver produtos reais acima, use somente esses produtos. Nao escreva URL de imagem. Se product_cards_count for 0, nunca diga que enviou, esta enviando ou vai reenviar fotos/cards; diga apenas que nao encontrou fotos seguras para enviar automaticamente e peca um detalhe ou ofereca nova busca. Se product_cards_count for maior que 0, os cards/carrossel serao enviados pelo sistema fora do texto.'
  ].filter(Boolean);

  return blocks.join('\n\n---\n\n');
}

function buildDifyQuery(message = '', contextText = '') {
  return [
    'Responda somente esta mensagem atual do cliente no WhatsApp. Use portugues do Brasil, texto curto e natural.',
    'Use o contexto abaixo como fonte oficial. Nao trate o contexto como pergunta do cliente.',
    '',
    'Contexto oficial do ContatoSync:',
    truncate(contextText, 14000) || 'Nenhum contexto adicional informado.',
    '',
    'Mensagem atual do cliente:',
    '',
    String(message || '').trim()
  ].join('\n');
}

async function callDifyChatMessage({
  clientId,
  message,
  contact,
  conversation,
  config,
  systemPrompt,
  conversationHistory,
  productContext,
  siteContext,
  operationalContext
}) {
  const difyConfig = getDifyConfig(config);
  if (!difyConfig.enabled) return { skipped: true, reason: 'Dify desabilitado' };
  if (!difyConfig.endpoint || !difyConfig.apiKey) {
    throw new Error('Dify habilitado, mas DIFY_API_URL ou DIFY_API_KEY nao foi configurado');
  }

  const startedAt = Date.now();
  const key = getConversationKey({ clientId, conversation });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), difyConfig.timeoutMs);
  const contextText = buildDifyContext({
    contact,
    conversation,
    systemPrompt,
    conversationHistory,
    productContext,
    siteContext,
    operationalContext
  });
  const currentQuery = buildDifyQuery(message, contextText);

  try {
    const response = await fetch(difyConfig.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${difyConfig.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs: {
          client_id: clientId || '',
          contact_name: contact?.name || conversation?.contact_name || '',
          phone: contact?.phone || conversation?.phone || '',
          conversation_id: conversation?.id || '',
          products_found: productContext?.productsFound === true,
          product_cards_count: Array.isArray(productContext?.productCards) ? productContext.productCards.length : 0,
          contexto_atendimento: contextText,
          mensagem_atual: String(message || '').trim()
        },
        query: currentQuery,
        response_mode: 'blocking',
        conversation_id: difyConfig.keepConversation ? getStoredConversationId(key) : '',
        user: String(contact?.phone || conversation?.phone || conversation?.id || clientId || 'whatsapp-user')
      }),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.message || data?.error || `Dify respondeu HTTP ${response.status}`);
    }

    if (difyConfig.keepConversation) setStoredConversationId(key, data?.conversation_id);
    const answer = String(data?.answer || '').trim();
    if (!answer) throw new Error('Dify nao retornou answer na resposta');

    const usage = data?.metadata?.usage || {};
    return {
      skipped: false,
      response: answer,
      provider: 'dify',
      model: data?.metadata?.model || config?.dify_model || 'dify_chatflow',
      prompt_tokens: usage.prompt_tokens || usage.promptTokens || 0,
      completion_tokens: usage.completion_tokens || usage.completionTokens || 0,
      total_tokens: usage.total_tokens || usage.totalTokens || usage.total || 0,
      processing_time_ms: Date.now() - startedAt,
      dify_conversation_id: data?.conversation_id || ''
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  callDifyChatMessage,
  getDifyConfig,
  hasDifyConfig
};
