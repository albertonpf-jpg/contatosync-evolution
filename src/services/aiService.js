const { v4: uuidv4 } = require('uuid');
const { isWithinWorkingHours } = require('../utils/helpers');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');

const execFileAsync = promisify(execFile);
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
  const requested = tokens.length > 0 ? tokens.join(' ') : 'esse pedido';
  return `Nao encontrei fotos seguras de ${requested} no catalogo configurado. Pode me mandar outro nome, cor ou categoria para eu buscar de novo?`;
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

  const productSources = [];
  for (const source of sources) {
    if (source.endpointKey !== 'products_path' && source.endpointKey !== 'stock_path') continue;
    for (let page = 1; page <= 10; page += 1) {
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
    .filter(token => !['tem', 'vende', 'vender', 'quero', 'queria', 'procuro', 'preciso', 'fotos', 'foto', 'opcoes', 'opcao'].includes(token));
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
  if (!hasStrongProductIntent(message)) return true;
  return [
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
      'modelos'
    ].includes(token))
    .filter(token => !/^\d+$/.test(token));
}

function getSpecificProductTokens(tokens) {
  const generic = new Set([
    'roupa',
    'roupas',
    'infantil',
    'infantis',
    'crianca',
    'criancas',
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
    /\b(?:crianca|criancas|infantil|menino|menina|beb[eê])\s*(?:de|com|para)?\s*(\d{1,2})\b/gi
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
        _hasRequestedSizeInStock: hasRequestedSizeInStock,
        _wasPreviouslyShown: isPreviouslyShownProduct(product, excludedTitleKeys),
        _titleMatches: countTokenMatches(title, messageTokens),
        _specificMatches: countTokenMatches(haystack, specificTokens),
        _colorMatches: countTokenMatches(titleAndVariations, colorTokens),
        _hasConflictingTitleColor: colorTokens.length > 0 && titleColors.some(color => !colorTokens.includes(color))
      };
    })
    .sort((a, b) => b.score - a.score);

  if (requestedSizes.length > 0) {
    const sizeMatched = uniqueProducts
      .filter(product => productMatchesRequestedSize(product, requestedSizes))
      .map(product => ({ ...product, score: product.score + 8 }));
    if (sizeMatched.length === 0) return [];
    const sizeMatchedInStock = sizeMatched
      .filter(product => product._hasRequestedSizeInStock || product._hasStock)
      .sort((a, b) => Number(b._hasRequestedSizeInStock) - Number(a._hasRequestedSizeInStock) || b.score - a.score);
    if (sizeMatchedInStock.length > 0 && (messageTokens.length === 0 || specificTokens.length === 0)) {
      return preferNotPreviouslyShown(sizeMatchedInStock, excludedTitleKeys).slice(0, 6);
    }
    if (messageTokens.length === 0 || specificTokens.length === 0) {
      return preferNotPreviouslyShown(sizeMatched, excludedTitleKeys).slice(0, 6);
    }
  }

  if (messageTokens.length === 0) {
    const inStockProducts = uniqueProducts.filter(product => product._hasStock);
    return preferNotPreviouslyShown(inStockProducts.length > 0 ? inStockProducts : uniqueProducts, excludedTitleKeys).slice(0, 6);
  }

  const minSpecificMatches = specificTokens.length >= 2 ? specificTokens.length : specificTokens.length;
  const bestScore = uniqueProducts[0]?.score || 0;
  const matched = uniqueProducts.filter(product => {
    if (product.score <= 0) return false;
    if (specificTokens.length > 0 && hasNegativeProductMatch(product, specificTokens)) return false;
    if (requestedSizes.length > 0 && !productMatchesRequestedSize(product, requestedSizes)) return false;
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
      const inStockTitleOrCategoryMatched = titleOrCategoryMatched.filter(product => product._hasStock);
      return preferNotPreviouslyShown(inStockTitleOrCategoryMatched.length > 0 ? inStockTitleOrCategoryMatched : titleOrCategoryMatched, excludedTitleKeys).slice(0, 6);
    }
    const inStockMatched = matched.filter(product => product._hasStock);
    return preferNotPreviouslyShown(inStockMatched.length > 0 ? inStockMatched : matched, excludedTitleKeys).slice(0, 6);
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
  if (sources.length === 0) return { contextText: '', imageUrls: [], productCards: [] };

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

  const relevantProducts = getRelevantProducts(products, message, options);
  console.log('[AI PRODUCT] Resultado catalogo | produtos_coletados: ' + products.length + ' | produtos_relevantes: ' + relevantProducts.length);

  if (relevantProducts.length === 0) {
    return {
      contextText: '',
      imageUrls: [],
      productCards: [],
      productsFound: false,
      allProductsCollected: products.length > 0 ? products : []
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

  const productCards = [];
  for (const product of relevantProducts.slice(0, 6)) {
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
    productsFound: relevantProducts.length > 0,
    lookupAttempted: true,
    allProductsCollected: products  // todos os coletados, para fallback semântico de tema
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

function getRecentCustomerProductRequest(conversationHistory = []) {
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

function buildProductSearchText(message, conversationHistory = []) {
  const current = String(message || '').trim();
  const normalizedCurrent = normalizeSearchText(current);
  const currentIsFollowUp = isCatalogFollowUpRequest(normalizedCurrent) || isMoreProductOptionsRequest(current);
  const lastProductRequest = getRecentCustomerProductRequest(conversationHistory);
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
- Se a mensagem NÃO contém nome de produto (moletom, blusa, vestido, etc) e pergunta sobre tamanho/estoque, é product_stock_followup, NÃO product_search.
- "quantas" NUNCA é nome de produto.
- Se há produtos no contexto recente e o cliente pergunta sobre tamanho/estoque sem especificar qual produto, needs_clarification=true.
- search_query deve conter o substantivo de produto E os modificadores importantes: tema, personagem, marca, estampa. NUNCA remova tema/personagem/marca do search_query. Exemplos corretos: "camiseta princesas", "camisa princesa Disney", "camisa personagens", "moletom frozen". Exemplos ERRADOS (perdem o modificador): "camiseta", "camisa", "moletom".
- semantic_query: descrição semântica do que o cliente quer (tipo de produto + tema/característica). Preencher APENAS para product_search. Ex: "peca de roupa superior infantil com tema de princesa/personagem". Deixar "" para outras intencoes.
- product_type: tipo/categoria do produto mencionado. Preencher APENAS para product_search. Ex: "camiseta", "vestido", "roupa infantil". Deixar "" se nao aplicavel.
- theme: tema, estampa ou personagem mencionado. Preencher APENAS para product_search. Ex: "princesa", "frozen", "personagem". Deixar "" se nao aplicavel.
- allow_related_products: true se o cliente parece aberto a sugestoes relacionadas (pedido com tema/personagem/conceito amplo), false se o pedido e muito especifico (cor + tamanho + modelo exato).

### CONTEXTO:
Histórico recente:
${recentHistory || '(sem histórico)'}

Produtos enviados recentemente: ${recentProductsText}

Mensagem atual: "${message}"

Responda SOMENTE com JSON:
{"intent":"...","source":"...","search_query":"...","semantic_query":"","product_type":"","theme":"","allow_related_products":false,"filters":{"size":"","color":"","category":""},"order_id":"","tracking_id":"","reference":"none","selected_product_index":null,"needs_clarification":false,"clarification_question":""}`;

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
          max_tokens: 300,
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
          max_output_tokens: 300,
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

    // Validação mínima
    const validIntents = ['product_search', 'product_stock_followup', 'product_followup', 'order_lookup', 'tracking_lookup', 'knowledge_question', 'general_message', 'clarification'];
    if (!validIntents.includes(parsed.intent)) return null;

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

  // 1. Se tem número de pedido → order_lookup ou tracking_lookup
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
        clarification_question: ''
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
      clarification_question: ''
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
      clarification_question: ''
    };
  }

  // 3. Se a mensagem tem tamanho + NÃO tem nome de produto + tem produtos recentes → stock_followup
  const hasSize = extractRequestedSizes(message).length > 0;
  const productSearchPhrase = getProductSearchPhrase(message);
  const hasProductName = productSearchPhrase.length > 0;
  const recentProducts = getRecentlySentProductTitles(conversationHistory);

  if (hasSize && !hasProductName && recentProducts.length > 0) {
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
      clarification_question: recentProducts.length > 1 ? 'Você quer saber o tamanho de qual opção?' : ''
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
      clarification_question: ''
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
          clarification_question: ''
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
      clarification_question: ''
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
    clarification_question: ''
  };
}

/**
 * Extrai títulos de produtos enviados recentemente pela IA no histórico.
 * Limpa emoji 🛍️, marcador •, sufixo "- foto N", preço depois de "— R$",
 * e linhas genéricas como "As fotos foram enviadas acima".
 * Retorna array com no máximo 5 títulos únicos.
 */
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

      let cleaned = line
        .replace(/^🛍️?\s*/u, '')           // Remove emoji 🛍️
        .replace(/^\u2022\s*/, '')          // Remove marcador •
        .replace(/^\d+\.\s*/, '')           // Remove numeração "1. "
        .replace(/\s*-\s*foto\s*\d+$/i, '') // Remove sufixo "- foto 1"
        .replace(/\s*—\s*R\$\s*[\d.,]+$/i, '') // Remove preço "— R$ XX"
        .trim();

      if (!cleaned || cleaned.length < 4 || cleaned.length > 90) continue;

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
async function semanticRankProducts(candidateProducts, customerIntent, semanticQuery, apiKey, provider) {
  const SEMANTIC_MAX_CANDIDATES = 50;
  const SEMANTIC_MAX_RESULTS = 6;
  const SEMANTIC_TIMEOUT_MS = 6000;

  if (!candidateProducts || candidateProducts.length === 0 || !semanticQuery) {
    return { productCards: [], customerNote: '' };
  }

  // Lista compacta para a IA — sem URLs longas, sem base64, sem HTML
  const candidateSample = candidateProducts
    .slice(0, SEMANTIC_MAX_CANDIDATES)
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
- "camisa de princesa da Disney" = qualquer peca de roupa (blusa, camiseta, conjunto, body, moletom, pijama, cropped, vestido) com tema de princesa ou personagem Disney.
- "camisa de personagens" = qualquer roupa infantil com estampa de personagem, independente do tipo de peca.
- "blusa de frio" = moletom, casaco, jaqueta, blusao.
Se o pedido menciona tema/personagem, priorize produtos com esse tema, mesmo que o tipo de peca seja diferente.
Se nao houver correspondencia exata de peca mas houver correspondencia de tema, inclua como relacionado com score menor.
Se absolutamente nenhum produto tiver relacao semantica com o pedido, retorne matches vazio.

Regras de selecao:
- Use apenas o campo "id" exato dos produtos listados abaixo
- Nao invente produtos nem altere dados
- Prefira produtos com stock maior que zero (campo stock)
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
    for (const p of candidateProducts) {
      const key = String(p.id || p.url || '');
      if (key) productById.set(key, p);
    }

    // Filtrar apenas IDs que existem na lista original — descartar qualquer invenção da IA
    const validMatches = rankResult.matches
      .filter(m => m && productById.has(String(m.id || '')))
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, SEMANTIC_MAX_RESULTS);

    if (validMatches.length === 0) {
      console.log('[SEMANTIC] IDs retornados pela IA nao correspondem a produtos existentes');
      return { productCards: [], customerNote: '' };
    }

    // Montar productCards usando 100% os dados reais do produto original
    const productCards = [];
    for (const match of validMatches) {
      const product = productById.get(String(match.id));
      if (!product) continue;
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
    return { productCards: productCards.slice(0, 10), customerNote };

  } catch (err) {
    console.warn('[SEMANTIC] Falha no ranking semantico, usando resposta padrao | erro: ' + String((err && err.message) || err));
    return { productCards: [], customerNote: '' };
  }
}

// ─── FIM BUSCA SEMÂNTICA ──────────────────────────────────────────────────────

async function buildProductContextForConfig(message, config, conversationHistory = []) {
  const searchText = buildProductSearchText(message, conversationHistory);
  const configuredSources = buildConfiguredProductSources(config);
  if (config?.product_search_enabled === false && configuredSources.length === 0) return { contextText: '', imageUrls: [], productCards: [], lookupAttempted: false };
  const shouldSearch = shouldUseConfiguredProductSources(searchText);
  const excludeTitles = isCatalogFollowUpRequest(message)
    ? extractPreviouslyMentionedProductTitles(conversationHistory)
    : [];
  const productContext = await fetchProductContext(searchText, shouldSearch ? configuredSources : [], { excludeTitles });
  return { ...productContext, lookupAttempted: shouldSearch, searchText };
}

async function buildSiteContextForConfig(message, config) {
  const configuredSources = buildConfiguredProductSources(config);
  const shouldSearch = shouldUseConfiguredSiteSources(message);
  if (!shouldSearch) return { contextText: '', lookupAttempted: false };
  const siteContext = await fetchSiteInfoContext(message, configuredSources);
  return { ...siteContext, lookupAttempted: shouldSearch };
}

async function buildOperationalContextForConfig(message, config, contact, conversation) {
  const sources = buildOperationalIntegrationSources(config, message, contact, conversation);
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
  return `${productContext.contextText}\n\nEstas informacoes foram buscadas antes da resposta nas APIs de integracoes ativas e/ou no link de catalogo configurado. Use primeiro os dados coletados das integracoes e do catalogo. Use somente os produtos que batem com o pedido do cliente. Se o cliente pediu idade/tamanho, por exemplo crianca de 6 anos, tamanho 6 ou tam 6, responda e envie somente produtos com esse tamanho explicitamente encontrado. Se o cliente pediu um produto especifico, nao inclua produtos parecidos, personagens, outras estampas, outras cores ou outras categorias. Se nao houver correspondencia clara, diga que nao encontrou fotos seguras para enviar. Use nomes, precos, fotos, variacoes, tamanhos e disponibilidade quando existirem. Nao pergunte se pode enviar fotos: quando houver imagens, responda considerando que o sistema enviara as fotos antes do texto. Nao escreva URLs de imagens na resposta. As imagens serao enviadas pelo sistema como carrossel interativo fora do texto. Nao responda apenas com o link da loja se houver dados de produtos acima. Nao invente preco, estoque, tamanho ou variacao que nao esteja no conteudo coletado.`;
}

function buildProductInputResult(extra, productContext) {
  return {
    ...extra,
    productImages: productContext.imageUrls || [],
    productCards: productContext.productCards || [],
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
      text: 'O cliente pediu fotos ou produtos, mas nenhum produto com imagem foi encontrado no catalogo configurado. Nao diga que vai enviar fotos e nao prometa encaminhar para atendente apenas por falta de imagem. Responda de forma transparente que nao encontrei fotos seguras desse pedido no catalogo e peca para o cliente confirmar o nome do produto, cor ou categoria.'
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
    product_lookup_attempted: builtInput.productLookupAttempted === true,
    product_search_text: builtInput.productSearchText || '',
    products_found: builtInput.productsFound === true,
    ...getTokenUsageFromOpenAI(data)
  };
}

async function buildClaudeInputContent({ input, media, config, conversationHistory, contact, conversation }) {
  const productContext = await buildProductContextForConfig(input, config, conversationHistory);
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
  else if (productContext.lookupAttempted) parts.push('O cliente pediu fotos ou produtos, mas nenhum produto com imagem foi encontrado no catalogo configurado. Nao diga que vai enviar fotos e nao prometa encaminhar para atendente apenas por falta de imagem. Responda de forma transparente que nao encontrei fotos seguras desse pedido no catalogo e peca para o cliente confirmar o nome do produto, cor ou categoria.');
  if (media) parts.push(`Midia recebida:\n${getMediaDescription(media)}`);
  return {
    inputText: parts.filter(Boolean).join('\n\n'),
    productImages: productContext.imageUrls || [],
    productCards: productContext.productCards || [],
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

  if (!isWithinWorkingHours(config, config.timezone || 'America/Sao_Paulo')) {
    const productContext = await buildProductContextForConfig(message, effectiveConfig, conversationHistory);
    if (productContext.lookupAttempted) {
      const productCards = productContext.productCards || [];
      return {
        skipped: false,
        response: productCards.length > 0
          ? buildProductCardsResponse(productCards)
          : buildOutsideWorkingHoursResponse(effectiveConfig),
        provider: 'catalog',
        model: productCards.length > 0 ? 'catalog_lookup' : 'outside_working_hours',
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
  const apiKeyForClassify = provider === 'claude' ? client?.claude_api_key : client?.openai_api_key;
  const customerIntent = await classifyCustomerIntent({
    apiKey: apiKeyForClassify,
    provider,
    message,
    conversationHistory,
    config: effectiveConfig
  });

  // Log seguro da intenção completa (sem token)
  console.log('[INTENT FULL] intent=' + customerIntent.intent
    + ' source=' + (customerIntent.source || '')
    + ' query="' + (customerIntent.search_query || '') + '"'
    + ' semantic="' + (customerIntent.semantic_query || '') + '"'
    + ' theme="' + (customerIntent.theme || '') + '"'
    + ' product_type="' + (customerIntent.product_type || '') + '"'
    + ' allow_related=' + (customerIntent.allow_related_products === true ? 'true' : 'false'));

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
  if (customerIntent.intent === 'product_stock_followup') {
    // Guard: se a mensagem contém produto explícito, o LLM classificou errado.
    // Redirecionar para product_search com a query extraída.
    const _stockFollowupOverrideQuery = getProductSearchPhrase(message);
    if (_stockFollowupOverrideQuery) {
      console.log('[FOLLOWUP DECISION] explicit_product=true reason=override_stock_followup query="' + _stockFollowupOverrideQuery + '"');
      const _overrideQuery = customerIntent.search_query || _stockFollowupOverrideQuery;
      console.log('[PRODUCT CLEAN QUERY] "' + _overrideQuery + '" (override from product_stock_followup)');
      const _overrideContext = await buildProductContextForConfig(_overrideQuery, effectiveConfig, conversationHistory);
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
    const lastProductRequest = getRecentCustomerProductRequest(conversationHistory);
    // Tokens da mensagem atual — pode ser refinamento ("princesas da disney")
    const _followupCurrentTokens = getProductSearchPhrase(message);
    const _followupHasOwnTokens = _followupCurrentTokens.length > 0;
    if (lastProductRequest) {
      const _followupBaseQuery = getProductSearchPhrase(lastProductRequest);
      // Se a mensagem atual tem tokens próprios (refinamento/complemento),
      // combinar com a busca anterior para formar query completa.
      // Ex: lastProductRequest="tem Camisa de princesa" + message="princesas da disney"
      //   → merged="camisa princesa princesas disney" → deduplicado → "camisa princesa disney"
      let cleanQuery = _followupBaseQuery;
      if (_followupHasOwnTokens && _followupBaseQuery) {
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
      } else if (_followupHasOwnTokens && !_followupBaseQuery) {
        // Sem histórico de produto, usar só os tokens atuais
        cleanQuery = _followupCurrentTokens;
      }
      console.log('[FOLLOWUP DECISION] explicit_product=' + _followupHasOwnTokens + ' reason=product_followup query="' + cleanQuery + '"');
      if (cleanQuery) {
        console.log('[PRODUCT CLEAN QUERY] "' + cleanQuery + '" (product_followup)');
        const productContext = await buildProductContextForConfig(cleanQuery, effectiveConfig, conversationHistory);
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
                console.log('[SEMANTIC CARDS] cards com imagem: ' + _semCardsImg.length + ' | sem imagem: ' + _semCardsTxt.length);
                if (_semCardsImg.length > 0) {
                  return {
                    skipped: false,
                    response: _semResult.customerNote + '\n\n' + buildProductCardsResponse(_semCardsImg),
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
                  response: _semResult.customerNote + '\n\n' + _semListaTxt,
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
      const productContext = await buildProductContextForConfig(cleanQuery, effectiveConfig, conversationHistory);
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
        const allProductsCollected = (productContext.allProductsCollected || []);
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
            const noteText = semanticResult.customerNote;
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
      }
    }
    // Se cleanQuery estiver vazio ou busca não retornou nada, cai para LLM normal
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

    if (result.product_lookup_attempted && !result.products_found && (!Array.isArray(result.product_cards) || result.product_cards.length === 0)) {
      result.response = buildProductLookupEmptyResponse(result.product_search_text || message);
    } else {
      result.response = normalizeProductMediaResponse(
        suppressRepeatedGreeting(result.response, effectiveConfig.greeting_message, conversation),
        result.product_cards
      );
    }

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
