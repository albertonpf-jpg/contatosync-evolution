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

function getDifyToolApiKey() {
  return String(process.env.DIFY_TOOL_API_KEY || process.env.DIFY_TOOLS_API_KEY || process.env.DIFY_API_KEY || '').trim();
}

function getPublicToolBaseUrl() {
  const explicit = process.env.PUBLIC_API_URL || process.env.API_PUBLIC_URL || process.env.NEXT_PUBLIC_API_URL;
  if (explicit) return cleanBaseUrl(explicit.replace(/\/api\/?$/i, ''));
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${String(process.env.RAILWAY_PUBLIC_DOMAIN).replace(/\/+$/, '')}`;
  if (process.env.RAILWAY_STATIC_URL) return `https://${String(process.env.RAILWAY_STATIC_URL).replace(/\/+$/, '')}`;
  return '';
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

function buildDifyContext({ contact, conversation, systemPrompt, conversationHistory, productContext, siteContext, operationalContext, knowledgeContext, toolResults }) {
  const productCardsCount = Array.isArray(productContext?.productCards) ? productContext.productCards.length : 0;
  const toolBaseUrl = getPublicToolBaseUrl();
  const toolSearchUrl = toolBaseUrl ? `${toolBaseUrl}/api/dify-tools/search` : '/api/dify-tools/search';
  const toolActionUrl = toolBaseUrl ? `${toolBaseUrl}/api/dify-tools/action` : '/api/dify-tools/action';
  const blocks = [
    'Contexto de atendimento. Nao trate este contexto como pergunta do cliente. A pergunta atual chega separada no campo query.',
    systemPrompt ? `Instrucao do atendimento:\n${truncate(systemPrompt, 2500)}` : '',
    `Cliente: ${contact?.name || conversation?.contact_name || 'Contato sem nome'}`,
    `Telefone: ${contact?.phone || conversation?.phone || 'nao informado'}`,
    formatHistory(conversationHistory) ? `Historico recente:\n${truncate(formatHistory(conversationHistory), 5000)}` : '',
    knowledgeContext ? `Conhecimento configurado no ContatoSync (prompt, configuracoes, arquivos e base do cliente):\n${truncate(knowledgeContext, 7000)}` : '',
    productContext?.contextText ? `Produtos reais encontrados nas APIs/catalogo do ContatoSync:\n${truncate(productContext.contextText, 9000)}` : '',
    siteContext?.contextText ? `Informacoes oficiais da loja/site:\n${truncate(siteContext.contextText, 5000)}` : '',
    operationalContext?.contextText ? `Informacoes transacionais consultadas:\n${truncate(operationalContext.contextText, 5000)}` : '',
    Array.isArray(toolResults) && toolResults.length > 0 ? `Resultados das ferramentas solicitadas por voce:\n${truncate(JSON.stringify(toolResults, null, 2), 12000)}` : '',
    `Capacidade tecnica do WhatsApp: product_cards_count=${productCardsCount}. O ContatoSync so pode montar/enviar os cards tecnicos se voce decidir send_cards=true. Se send_cards=false, o ContatoSync enviara apenas o texto de answer.`,
    `Ferramentas HTTP disponiveis para o Dify quando configuradas no Chatflow:\nGET ${toolSearchUrl}?client_id=<client_id>&type=all|catalog|site|files|operational&query=<consulta>&conversation_id=<conversation_id>&phone=<phone>\nPOST ${toolActionUrl} com JSON {"client_id":"<client_id>","action":"create_activity|update_contact_tags","payload":{...}}.\nUse header Authorization: Bearer <DIFY_TOOL_API_KEY>. Se essa variavel dedicada nao existir, o backend aceita a propria chave DIFY_API_KEY do app como token de ferramenta. Essas ferramentas permitem consultar APIs/catalogo, URLs/site, arquivos/base do cliente e executar POSTs controlados no ContatoSync.`,
    'Regras criticas: voce, Dify, e o cerebro do atendimento. O ContatoSync nao deve decidir a resposta, apenas fornece contexto/ferramentas e executa o envio tecnico de cards quando voce pedir. Responda somente a pergunta atual do cliente. Priorize a mensagem atual sobre o historico. Avalie em conjunto todas as fontes recebidas: prompt/configuracoes, arquivos/base do cliente, site/URLs, APIs/catalogo e integracoes operacionais. Nao fique preso a uma fonte so. Ordem de tentativa: para produtos/cards, primeiro APIs/catalogo; se nao houver produto seguro, use site/URLs; por ultimo use prompt, configuracoes e arquivos para orientar a resposta e pedir um detalhe. Nunca encerre com negativa antes de considerar todas as fontes disponiveis no contexto. Nunca invente preco, estoque, prazo, link, pedido, frete, rastreio ou politica. Para produtos e cards, os produtos reais das APIs/catalogo sao a fonte autoritativa do que pode ser enviado. Use arquivos, site e prompt para interpretar familias, politicas, nomes e regras. Para pedidos, frete, entrega, pagamento e rastreio, use primeiro as informacoes transacionais/integracoes quando existirem. Se houver conflito entre fontes, nao negue de imediato: explique o que foi encontrado e peca um detalhe seguro. Nao escreva URL de imagem. Se product_cards_count for 0, nunca diga que enviou, esta enviando ou vai reenviar fotos/cards; diga apenas que ainda nao encontrou fotos/cards seguros automaticamente e peca um detalhe ou ofereca nova busca. Se product_cards_count for maior que 0, use send_cards=true apenas quando a melhor resposta exigir fotos/cards/opcoes visuais; para duvidas pontuais de quantidade, cor, tamanho, pedido, frete, pagamento ou politica, geralmente use send_cards=false e responda em texto.'
  ].filter(Boolean);

  return blocks.join('\n\n---\n\n');
}

function buildDifyQuery(message = '', contextText = '') {
  return [
    'Responda somente esta mensagem atual do cliente no WhatsApp. Use portugues do Brasil, texto curto e natural.',
    'Voce deve decidir a operacao. O ContatoSync nao vai decidir por voce.',
    'Retorne SOMENTE um JSON valido, sem markdown, sem texto fora do JSON.',
    'Schema obrigatorio:',
    '{"answer":"texto curto para enviar ao cliente","send_cards":false,"card_policy":"none","cards":[],"tool_calls":[],"handoff":false,"confidence":"high","reason":"motivo interno curto"}',
    'Regras do JSON:',
    '- answer: mensagem final ao cliente.',
    '- send_cards: true somente se os cards encontrados devem ser enviados agora.',
    '- card_policy: "send_found_cards" quando send_cards=true; caso contrario "none".',
    '- cards: opcional. Se voce montar cards, use objetos com title, description, url e imageUrl. Se nao montar, deixe [] e o ContatoSync pode usar os cards tecnicos encontrados no contexto quando send_cards=true.',
    '- tool_calls: quando precisar consultar antes de responder, devolva uma lista de ferramentas e deixe answer curto como "Vou verificar isso para voce.". O ContatoSync executara as ferramentas e chamara voce de novo com os resultados.',
    '- Ferramentas permitidas em tool_calls: {"tool":"search","type":"catalog|site|files|operational|all","query":"consulta"} e {"tool":"action","action":"create_activity|update_contact_tags","payload":{}}.',
    '- Na chamada final, depois de receber resultados de ferramentas, use tool_calls: [] e responda com answer/send_cards/cards.',
    '- Se a pergunta for sobre quantidade, cor, tamanho, preco especifico, frete, pedido, pagamento ou politica, responda em texto e use send_cards=false, salvo se o cliente pedir explicitamente fotos/opcoes.',
    '- Se o cliente pedir opcoes, modelos, fotos, catalogo, mais produtos ou alternativas visuais e product_cards_count for maior que 0, use send_cards=true.',
    '- Se product_cards_count for 0, use send_cards=false e nao prometa envio de fotos/cards.',
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

function extractJsonObject(text = '') {
  const value = String(text || '').trim();
  if (!value) return '';
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : value;
  if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) return candidate.slice(start, end + 1);
  return '';
}

function parseDifyDecision(answer = '') {
  const raw = String(answer || '').trim();
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    return {
      response: raw,
      sendCards: null,
      cardPolicy: 'legacy_text',
      decision: null,
      rawResponse: raw
    };
  }

  try {
    const parsed = JSON.parse(jsonText);
    const response = String(parsed.answer || parsed.message || parsed.response || '').trim() || raw;
    const sendCards = parsed.send_cards === true || parsed.sendCards === true || parsed.card_policy === 'send_found_cards' || parsed.cardPolicy === 'send_found_cards';
    const cards = Array.isArray(parsed.cards)
      ? parsed.cards
      : Array.isArray(parsed.product_cards)
        ? parsed.product_cards
        : Array.isArray(parsed.productCards)
          ? parsed.productCards
          : [];
    const toolCalls = Array.isArray(parsed.tool_calls)
      ? parsed.tool_calls
      : Array.isArray(parsed.toolCalls)
        ? parsed.toolCalls
        : [];
    return {
      response,
      sendCards,
      cardPolicy: sendCards ? 'send_found_cards' : 'none',
      cards,
      toolCalls,
      decision: parsed,
      rawResponse: raw
    };
  } catch (error) {
    return {
      response: raw,
      sendCards: null,
      cardPolicy: 'invalid_json',
      decision: null,
      rawResponse: raw
    };
  }
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
  operationalContext,
  knowledgeContext,
  toolResults
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
    operationalContext,
    knowledgeContext,
    toolResults
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
          knowledge_context_present: Boolean(String(knowledgeContext || '').trim()),
          site_context_present: Boolean(siteContext?.contextText),
          operational_context_present: Boolean(operationalContext?.contextText),
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
    const decision = parseDifyDecision(answer);

    const usage = data?.metadata?.usage || {};
    return {
      skipped: false,
      response: decision.response,
      provider: 'dify',
      model: data?.metadata?.model || config?.dify_model || 'dify_chatflow',
      prompt_tokens: usage.prompt_tokens || usage.promptTokens || 0,
      completion_tokens: usage.completion_tokens || usage.completionTokens || 0,
      total_tokens: usage.total_tokens || usage.totalTokens || usage.total || 0,
      processing_time_ms: Date.now() - startedAt,
      dify_conversation_id: data?.conversation_id || '',
      dify_send_cards: decision.sendCards,
      dify_card_policy: decision.cardPolicy,
      dify_product_cards: decision.cards || [],
      dify_tool_calls: decision.toolCalls || [],
      dify_tool_search_url: toolSearchUrlForResponse(),
      dify_decision: decision.decision,
      dify_raw_response: truncate(decision.rawResponse, 2000)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function toolSearchUrlForResponse() {
  const toolBaseUrl = getPublicToolBaseUrl();
  return toolBaseUrl ? `${toolBaseUrl}/api/dify-tools/search` : '/api/dify-tools/search';
}

module.exports = {
  callDifyChatMessage,
  getDifyConfig,
  getDifyToolApiKey,
  hasDifyConfig,
  parseDifyDecision
};
