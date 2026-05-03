const { v4: uuidv4 } = require('uuid');
const { isWithinWorkingHours } = require('../utils/helpers');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');

const execFileAsync = promisify(execFile);

function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean);
  return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

function includesAnyKeyword(message, keywords) {
  const text = String(message || '').toLowerCase();
  return normalizeList(keywords).some(keyword => text.includes(keyword.toLowerCase()));
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

function buildSystemPrompt(config, contact, conversation) {
  const basePrompt = config.system_prompt || 'Voce e um assistente virtual de atendimento via WhatsApp. Responda em portugues do Brasil, com clareza e objetividade.';
  const totalMessages = Number(conversation?.total_messages || 0);
  const canGreet = conversation?.conversation_created === true || totalMessages <= 1;
  const greeting = config.greeting_message
    ? `\n\nSaudacao configurada: ${config.greeting_message}\nUse essa saudacao somente na primeira resposta do atendimento. Se a conversa ja estiver em andamento, nao cumprimente de novo e responda direto ao assunto do cliente.`
    : '';
  const fallback = config.fallback_message ? `\n\nSe nao tiver certeza, use esta orientacao de fallback: ${config.fallback_message}` : '';
  const triggerKeywords = normalizeList(config.trigger_keywords);
  const triggerContext = triggerKeywords.length > 0
    ? `\n\nAssuntos prioritarios configurados: ${triggerKeywords.join(', ')}. Use isso como contexto de atendimento, mas responda tambem mensagens gerais do cliente.`
    : '';
  const context = [
    'Contexto do atendimento:',
    `- Cliente no WhatsApp: ${contact?.name || conversation?.contact_name || 'Contato sem nome'}`,
    `- Telefone: ${contact?.phone || conversation?.phone || 'nao informado'}`,
    '- Nunca invente precos, estoque, prazos ou politicas.',
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
  if (!Array.isArray(productCards) || productCards.length === 0) return response;

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
  const tokens = getSpecificProductTokens(getSearchTokens(searchText));
  const requested = tokens.length > 0 ? tokens.join(' ') : 'esse pedido';
  return `Nao encontrei fotos seguras de ${requested} no catalogo configurado. Pode me mandar outro nome, cor ou categoria para eu buscar de novo?`;
}

function buildProductCardsResponse(productCards = []) {
  const first = productCards[0];
  return [
    `Encontrei ${first?.title || 'opcoes'} na loja.`,
    first?.description || '',
    'Enviei as fotos correspondentes acima.'
  ].filter(Boolean).join('\n');
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

function shouldUseConfiguredProductSources(message) {
  if (extractUrls(message).length > 0) return true;
  const text = String(message || '').toLowerCase();
  return [
    'produto',
    'produtos',
    'catalogo',
    'catálogo',
    'preco',
    'preço',
    'valor',
    'estoque',
    'tem ',
    'vende',
    'comprar',
    'foto',
    'imagem',
    'tamanho',
    'variacao',
    'variação',
    'cor ',
    'vestido',
    'vestidos',
    'conjunto',
    'conjuntos',
    'blusa',
    'blusas',
    'body',
    'bodys',
    'calca',
    'calÃ§a',
    'calcas',
    'calÃ§as',
    'cropped',
    'croppeds',
    'croped',
    'macacao',
    'macacÃ£o',
    'jardineira',
    'saia',
    'saias',
    'short',
    'shorts',
    'camiseta',
    'camisetas',
    'tshirt',
    't-shirt'
  ].some(term => text.includes(term));
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
      'para',
      'com',
      'que'
    ].includes(token))
    .filter(token => !/^\d+$/.test(token));
}

function getSpecificProductTokens(tokens) {
  const generic = new Set([
    'roupa',
    'roupas',
    'infantil',
    'infantis',
    'adulto',
    'adultos',
    'masculino',
    'masculinos',
    'feminino',
    'femininos',
    'modelo',
    'peca',
    'pecas'
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

function getFacilZapPrice(product) {
  return product?.precos_produto?.promocional
    || product?.precos_produto?.preco_a_partir?.preco
    || product?.precos_produto?.padrao
    || product?.preco
    || null;
}

function getFacilZapVariations(product) {
  const variations = product?.variacoes && typeof product.variacoes === 'object'
    ? Object.values(product.variacoes)
    : [];
  return variations
    .map(variation => variation?.nome || variation?.subgrupo)
    .filter(Boolean)
    .slice(0, 8);
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

function getFacilZapProductsPageUrl(pageUrl) {
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
  return {
    id: product.id,
    url: String(catalogBase).replace('{PATH}', 'produto/' + product.id),
    title: product.nome || 'Produto',
    description: stripHtml(product.descricao || ''),
    price: price ? formatCurrencyBRL(price) : '',
    stock: Number.isFinite(Number(product.total_estoque)) ? Number(product.total_estoque) : null,
    category: product.categoria_nome || product.categoria || '',
    categoryName: product.categoria_nome || '',
    variations,
    images: [...new Set(images)].slice(0, 5),
    score: 0
  };
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

function getRelevantProducts(products, message) {
  const messageTokens = getSearchTokens(message);
  const specificTokens = getSpecificProductTokens(messageTokens);
  const colorTokens = getColorTokens(messageTokens);
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
      return {
        ...product,
        score: getProductScore(product, messageTokens),
        _titleMatches: countTokenMatches(title, messageTokens),
        _specificMatches: countTokenMatches(haystack, specificTokens),
        _colorMatches: countTokenMatches(titleAndVariations, colorTokens),
        _hasConflictingTitleColor: colorTokens.length > 0 && titleColors.some(color => !colorTokens.includes(color))
      };
    })
    .sort((a, b) => b.score - a.score);

  if (messageTokens.length === 0) return uniqueProducts.slice(0, 6);

  const minSpecificMatches = specificTokens.length >= 2 ? specificTokens.length : specificTokens.length;
  const bestScore = uniqueProducts[0]?.score || 0;
  const matched = uniqueProducts.filter(product => {
    if (product.score <= 0) return false;
    if (minSpecificMatches > 0 && product._specificMatches < minSpecificMatches) return false;
    if (colorTokens.length > 0 && product._colorMatches < colorTokens.length) return false;
    if (product._hasConflictingTitleColor) return false;
    if (bestScore >= 6 && product.score < Math.ceil(bestScore * 0.7)) return false;
    if (messageTokens.length >= 3 && product._titleMatches === 0 && product._specificMatches < 2) return false;
    return true;
  });
  if (matched.length > 0) return matched.slice(0, 6);
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
    const productsPageUrl = getFacilZapProductsPageUrl(pageUrl);
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

async function fetchProductContext(message, sourceUrls = []) {
  const urls = normalizeSourceUrls([message, ...sourceUrls]);
  if (urls.length === 0) return { contextText: '', imageUrls: [], productCards: [] };

  const products = [];
  const imageUrls = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'ContatoSyncBot/1.0 (+https://contatosync-evolution.vercel.app)'
        },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) continue;
      const html = await response.text();
      const facilZapProducts = await fetchFacilZapProductsFromHtml(html, url, message);
      if (facilZapProducts.length > 0) {
        for (const product of facilZapProducts) {
          for (const image of product.images || []) {
            if (!imageUrls.includes(image)) imageUrls.push(image);
          }
          products.push(product);
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
          products.push(product);
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
      products.push({ url, title, description, images: candidateImages.slice(0, 5) });
    } catch (error) {
      products.push({ url, title: '', description: `Nao foi possivel acessar a pagina: ${error.message}`, images: [] });
    }
  }

  const relevantProducts = getRelevantProducts(products, message);

  if (relevantProducts.length === 0) return { contextText: '', imageUrls: [], productCards: [] };

  const contextText = relevantProducts.map((product, index) => [
    `Produto/link ${index + 1}: ${product.url}`,
    product.title ? `Titulo: ${product.title}` : '',
    product.price ? `Preco: ${product.price}` : '',
    product.stock !== null && product.stock !== undefined ? `Estoque informado: ${product.stock}` : '',
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
        title: String((product.title || 'Produto') + suffix).slice(0, 60),
        description: [
          product.price ? `Preco: ${product.price}` : '',
          product.variations?.length ? `Variacoes: ${product.variations.slice(0, 4).join(', ')}` : '',
          product.description || ''
        ].filter(Boolean).join('\n').slice(0, 180),
        url: product.url,
        imageUrl: image
      });
    }
  }

  return {
    contextText: `Informacoes coletadas da loja virtual:\n${contextText}`,
    imageUrls: relevantProducts.flatMap(product => product.images || []).slice(0, 5),
    productCards: productCards.slice(0, 10),
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
    '.md': 'text/markdown'
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
  return ['.txt', '.csv', '.json', '.md', '.log', '.xml'].includes(ext)
    || mime.startsWith('text/')
    || ['application/json', 'application/xml'].includes(mime);
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

function buildProductSearchText(message, conversationHistory = []) {
  const current = String(message || '').trim();
  const currentShouldSearch = shouldUseConfiguredProductSources(current);
  const currentIsFollowUp = /cad[eê]|foto|fotos|imagem|imagens|manda|mande|envia|envie|quero ver|mostra|mostre/i.test(current);
  if (!currentShouldSearch) return current;
  if (getSpecificProductTokens(getSearchTokens(current)).length > 0) return current;

  const recentCustomerMessages = Array.isArray(conversationHistory)
    ? conversationHistory
      .filter(item => item && item.direction !== 'out' && !item.is_from_ai)
      .slice(-6)
      .map(item => String(item.content || '').trim())
      .filter(Boolean)
    : [];
  const lastProductRequest = [...recentCustomerMessages]
    .reverse()
    .find(item => getSpecificProductTokens(getSearchTokens(item)).length > 0);
  const parts = currentIsFollowUp && lastProductRequest ? [lastProductRequest, current] : [current];
  return [...new Set(parts)].join('\n');
}

async function buildProductContextForConfig(message, config, conversationHistory = []) {
  const searchText = buildProductSearchText(message, conversationHistory);
  const configuredSources = [
    config?.product_catalog_url,
    ...(Array.isArray(config?.product_source_urls) ? config.product_source_urls : []),
    config?.system_prompt
  ];
  if (config?.product_search_enabled === false) return { contextText: '', imageUrls: [], productCards: [], lookupAttempted: false };
  const shouldSearch = shouldUseConfiguredProductSources(searchText);
  const productContext = await fetchProductContext(searchText, shouldSearch ? configuredSources : []);
  return { ...productContext, lookupAttempted: shouldSearch, searchText };
}

function buildProductContextText(productContext) {
  if (!productContext?.contextText) return '';
  return `${productContext.contextText}\n\nUse somente os produtos que batem com o pedido do cliente. Se o cliente pediu um produto especifico, nao inclua produtos parecidos, personagens, outras estampas, outras cores ou outras categorias. Se nao houver correspondencia clara, diga que nao encontrou fotos seguras para enviar. Use nomes, precos, fotos, variacoes e disponibilidade quando existirem. Nao pergunte se pode enviar fotos: quando houver imagens, responda considerando que o sistema enviara as fotos antes do texto. Nao escreva URLs de imagens na resposta. As imagens serao enviadas pelo sistema como carrossel interativo fora do texto. Nao responda apenas com o link da loja se houver dados de produtos acima. Nao invente preco, estoque ou variacao que nao esteja no conteudo coletado.`;
}

async function buildOpenAIInputContent({ apiKey, message, media, config, conversationHistory }) {
  const productContext = await buildProductContextForConfig(message, config, conversationHistory);
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

  if (!media || (!media.path && !media.url)) return { content, productImages: productContext.imageUrls, productCards: productContext.productCards, productLookupAttempted: productContext.lookupAttempted, productSearchText: productContext.searchText };

  const kind = getMediaKind(media);
  const mimeType = media.mimeType || media.mimetype || getMimeTypeFromPath(media.path || '', 'application/octet-stream');
  content.push({ type: 'input_text', text: `Dados da midia recebida:\n${getMediaDescription(media)}` });

  if (kind === 'image' && media.path && fs.existsSync(media.path)) {
    content.push({ type: 'input_image', image_url: fileToDataUrl(media.path, mimeType), detail: 'auto' });
    return { content, productImages: productContext.imageUrls, productCards: productContext.productCards, productLookupAttempted: productContext.lookupAttempted, productSearchText: productContext.searchText };
  }

  if (kind === 'image' && media.url && /^https?:\/\//i.test(media.url)) {
    content.push({ type: 'input_image', image_url: media.url, detail: 'auto' });
    return { content, productImages: productContext.imageUrls, productCards: productContext.productCards, productLookupAttempted: productContext.lookupAttempted, productSearchText: productContext.searchText };
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
    return { content, productImages: productContext.imageUrls, productCards: productContext.productCards, productLookupAttempted: productContext.lookupAttempted, productSearchText: productContext.searchText };
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
      return { content, productImages: productContext.imageUrls, productCards: productContext.productCards, productLookupAttempted: productContext.lookupAttempted, productSearchText: productContext.searchText };
    }

    if (canReadTextFile(media.path, mimeType) && stat.size <= 1024 * 1024) {
      content.push({
        type: 'input_text',
        text: `Conteudo do arquivo ${media.fileName || path.basename(media.path)}:\n${fs.readFileSync(media.path, 'utf8').slice(0, 20000)}`
      });
      return { content, productImages: productContext.imageUrls, productCards: productContext.productCards, productLookupAttempted: productContext.lookupAttempted, productSearchText: productContext.searchText };
    }
  }

  content.push({ type: 'input_text', text: 'A midia foi recebida, mas esse tipo de arquivo nao pode ser analisado diretamente. Responda considerando o nome, tipo e legenda informados.' });
  return { content, productImages: productContext.imageUrls, productCards: productContext.productCards, productLookupAttempted: productContext.lookupAttempted, productSearchText: productContext.searchText };
}

async function callOpenAI({ apiKey, config, input, systemPrompt, media, conversationHistory }) {
  const startedAt = Date.now();
  const builtInput = Array.isArray(input)
    ? { content: input, productImages: [] }
    : await buildOpenAIInputContent({ apiKey, message: input, media, config, conversationHistory });
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
    ...getTokenUsageFromOpenAI(data)
  };
}

async function buildClaudeInputContent({ input, media, config, conversationHistory }) {
  const productContext = await buildProductContextForConfig(input, config, conversationHistory);
  const parts = [];
  const historyText = formatConversationHistory(conversationHistory);
  if (historyText) parts.push(`Historico da conversa desde a primeira mensagem disponivel:\n${historyText}`);
  if (input) parts.push(String(input));
  if (productContext.contextText) parts.push(buildProductContextText(productContext));
  else if (productContext.lookupAttempted) parts.push('O cliente pediu fotos ou produtos, mas nenhum produto com imagem foi encontrado no catalogo configurado. Nao diga que vai enviar fotos e nao prometa encaminhar para atendente apenas por falta de imagem. Responda de forma transparente que nao encontrei fotos seguras desse pedido no catalogo e peca para o cliente confirmar o nome do produto, cor ou categoria.');
  if (media) parts.push(`Midia recebida:\n${getMediaDescription(media)}`);
  return {
    inputText: parts.filter(Boolean).join('\n\n'),
    productImages: productContext.imageUrls || [],
    productCards: productContext.productCards || [],
    productLookupAttempted: productContext.lookupAttempted === true,
    productSearchText: productContext.searchText || ''
  };
}

async function callClaude({ apiKey, config, input, systemPrompt, media, conversationHistory }) {
  const startedAt = Date.now();
  const builtInput = await buildClaudeInputContent({ input, media, config, conversationHistory });
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
    product_search_text: builtInput.productSearchText || ''
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
      .select('integration_type, integration_name, api_endpoint, enabled, is_active')
      .eq('client_id', clientId)
      .in('integration_type', ['facilzap', 'ecommerce'])
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

  if (!isWithinWorkingHours(config, config.timezone || 'America/Sao_Paulo')) {
    return { skipped: true, reason: 'Fora do horario de funcionamento' };
  }

  if (includesAnyKeyword(message, config.blacklist_keywords)) {
    return { skipped: true, reason: 'Palavra bloqueada detectada' };
  }

  const provider = getProviderForModel(config.model || client?.ai_model);
  const effectiveConfig = {
    ...config,
    product_source_urls: normalizeSourceUrls((integrations || []).map(integration => integration.api_endpoint)),
    model: config.model || client?.ai_model || (provider === 'claude' ? 'claude-3-haiku' : 'gpt-4o-mini')
  };
  const systemPrompt = buildSystemPrompt(effectiveConfig, contact, conversation);
  const conversationHistory = await getConversationMessagesFromStart(supabase, clientId, conversation?.id);
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
    return { skipped: true, reason: 'Limite diario atingido' };
  }

  const apiKey = provider === 'claude' ? client?.claude_api_key : client?.openai_api_key;
  if (!apiKey || apiKey === '***') {
    const productContext = await buildProductContextForConfig(message, effectiveConfig, conversationHistory);
    if (productContext.lookupAttempted && productContext.productCards?.length) {
      return {
        skipped: false,
        response: buildProductCardsResponse(productContext.productCards),
        provider: 'catalog',
        model: 'catalog_lookup',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        processing_time_ms: 0,
        product_images: productContext.imageUrls || [],
        product_cards: productContext.productCards,
        product_lookup_attempted: true,
        product_search_text: productContext.searchText || message
      };
    }
    return { skipped: true, reason: 'API key nao configurada' };
  }

  try {
    const result = provider === 'claude'
      ? await callClaude({
          apiKey,
          config: effectiveConfig,
          input: message,
          systemPrompt,
          media,
          conversationHistory
        })
      : await callOpenAI({ apiKey, config: effectiveConfig, input: message, systemPrompt, media, conversationHistory });

    if (result.product_lookup_attempted && (!Array.isArray(result.product_cards) || result.product_cards.length === 0)) {
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

    throw error;
  }
}

module.exports = {
  generateAIResponse
};
