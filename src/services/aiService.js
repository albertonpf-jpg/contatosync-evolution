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
      'Estou enviando as fotos agora.'
    ].filter(Boolean).join('\n');
  }

  return response
    .replace(/(?:posso|quer que eu|deseja que eu)[^.!?\n]*(?:foto|imagem|imagens|fotos)[^.!?\n]*[.!?]?/gi, 'Estou enviando as fotos agora.')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
    'cor '
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
    .filter(token => token.length >= 3 && !['produto', 'produtos', 'preco', 'valor', 'foto', 'imagem', 'quero', 'tem', 'voce', 'voces', 'para', 'com'].includes(token));
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

function getProductScore(product, messageTokens) {
  if (!messageTokens.length) return 0;
  const haystack = normalizeSearchText([
    product.title,
    product.description,
    product.variations?.join(' ')
  ].join(' '));
  return messageTokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
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
  const endpoint = html.match(/const\s+urlCarregarSecoesProdutos\s*=\s*`([^`]+)`/i)?.[1]
    || html.match(/const\s+urlCarregarSecoesProdutos\s*=\s*['"]([^'"]+)['"]/i)?.[1];
  if (!endpoint) return [];

  const categoryMatch = html.match(/const\s+categoriasAtivasCatalogo\s*=\s*(\[[\s\S]*?\]);/i);
  let categories = [];
  if (categoryMatch?.[1]) {
    try {
      categories = JSON.parse(categoryMatch[1]);
    } catch (error) {
      categories = [];
    }
  }

  const messageTokens = getSearchTokens(message);
  const matchingCategories = categories
    .filter(category => getProductScore({ title: category.nome }, messageTokens) > 0)
    .map(category => String(category.id))
    .slice(0, 4);

  const body = {
    secoes: ['lancamentos', 'mais_vendidos', 'promocoes', 'destaques'],
    categorias: matchingCategories
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'ContatoSyncBot/1.0 (+https://contatosync-evolution.vercel.app)'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) return [];
  const data = await response.json();
  const catalogBase = html.match(/const\s+baseUrlCatalogo\s*=\s*`([^`]+)`/i)?.[1]
    || new URL('/c/varejo/{PATH}', pageUrl).toString();

  const products = [];
  for (const list of Object.values(data)) {
    if (!Array.isArray(list)) continue;
    for (const product of list) {
      const images = [
        ...(Array.isArray(product.imagens) ? product.imagens : []),
        ...(product.imagens_variacoes && typeof product.imagens_variacoes === 'object' ? Object.values(product.imagens_variacoes).flat() : [])
      ].map(getFacilZapImageUrl).filter(Boolean);
      const price = getFacilZapPrice(product);
      const variations = getFacilZapVariations(product);
      products.push({
        id: product.id,
        url: String(catalogBase).replace('{PATH}', 'produto/' + product.id),
        title: product.nome || 'Produto',
        description: stripHtml(product.descricao || ''),
        price: price ? formatCurrencyBRL(price) : '',
        stock: Number.isFinite(Number(product.total_estoque)) ? Number(product.total_estoque) : null,
        variations,
        images: [...new Set(images)].slice(0, 5),
        score: 0
      });
    }
  }

  const uniqueProducts = dedupeProducts(products)
    .map(product => ({ ...product, score: getProductScore(product, messageTokens) }))
    .sort((a, b) => b.score - a.score);

  return uniqueProducts.slice(0, 10);
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

  if (products.length === 0) return { contextText: '', imageUrls: [], productCards: [] };

  const contextText = products.map((product, index) => [
    `Produto/link ${index + 1}: ${product.url}`,
    product.title ? `Titulo: ${product.title}` : '',
    product.price ? `Preco: ${product.price}` : '',
    product.stock !== null && product.stock !== undefined ? `Estoque informado: ${product.stock}` : '',
    product.variations?.length ? `Variacoes: ${product.variations.join(', ')}` : '',
    product.description ? `Descricao: ${product.description}` : '',
    product.images?.length ? `Imagens disponiveis para envio: ${product.images.slice(0, 5).length}` : ''
  ].filter(Boolean).join('\n')).join('\n\n');

  const productCards = [];
  for (const product of products) {
    for (const image of (product.images || []).slice(0, 5)) {
      productCards.push({
        title: String(product.title || 'Produto').slice(0, 60),
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
    imageUrls: imageUrls.slice(0, 5),
    productCards: productCards.slice(0, 10)
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

async function buildOpenAIInputContent({ apiKey, message, media, config, conversationHistory }) {
  const configuredSources = [
    config?.product_catalog_url,
    ...(Array.isArray(config?.product_source_urls) ? config.product_source_urls : []),
    config?.system_prompt
  ];
  const productContext = config?.product_search_enabled === false
    ? await fetchProductContext(message, [])
    : await fetchProductContext(message, shouldUseConfiguredProductSources(message) ? configuredSources : []);
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
      text: `${productContext.contextText}\n\nUse essas informacoes para responder com nomes, precos, fotos, variacoes e disponibilidade quando existirem. Nao pergunte se pode enviar fotos: quando houver imagens, diga que esta enviando agora. Nao escreva URLs de imagens na resposta. As imagens serao enviadas pelo sistema como midia/carrossel fora do texto. Nao responda apenas com o link da loja se houver dados de produtos acima. Nao invente preco, estoque ou variacao que nao esteja no conteudo coletado.`
    });
  }

  if (!media || (!media.path && !media.url)) return { content, productImages: productContext.imageUrls, productCards: productContext.productCards };

  const kind = getMediaKind(media);
  const mimeType = media.mimeType || media.mimetype || getMimeTypeFromPath(media.path || '', 'application/octet-stream');
  content.push({ type: 'input_text', text: `Dados da midia recebida:\n${getMediaDescription(media)}` });

  if (kind === 'image' && media.path && fs.existsSync(media.path)) {
    content.push({ type: 'input_image', image_url: fileToDataUrl(media.path, mimeType), detail: 'auto' });
    return { content, productImages: productContext.imageUrls, productCards: productContext.productCards };
  }

  if (kind === 'image' && media.url && /^https?:\/\//i.test(media.url)) {
    content.push({ type: 'input_image', image_url: media.url, detail: 'auto' });
    return { content, productImages: productContext.imageUrls, productCards: productContext.productCards };
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
    return { content, productImages: productContext.imageUrls, productCards: productContext.productCards };
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
      return { content, productImages: productContext.imageUrls, productCards: productContext.productCards };
    }

    if (canReadTextFile(media.path, mimeType) && stat.size <= 1024 * 1024) {
      content.push({
        type: 'input_text',
        text: `Conteudo do arquivo ${media.fileName || path.basename(media.path)}:\n${fs.readFileSync(media.path, 'utf8').slice(0, 20000)}`
      });
      return { content, productImages: productContext.imageUrls, productCards: productContext.productCards };
    }
  }

  content.push({ type: 'input_text', text: 'A midia foi recebida, mas esse tipo de arquivo nao pode ser analisado diretamente. Responda considerando o nome, tipo e legenda informados.' });
  return { content, productImages: productContext.imageUrls, productCards: productContext.productCards };
}

async function callOpenAI({ apiKey, config, input, systemPrompt, media, conversationHistory }) {
  const startedAt = Date.now();
  const builtInput = Array.isArray(input)
    ? { content: input, productImages: [] }
    : await buildOpenAIInputContent({ apiKey, message: input, media, config, conversationHistory });
  const body = {
    model: config.model || 'gpt-4o-mini',
    instructions: systemPrompt,
    input: [{ role: 'user', content: builtInput.content }],
    max_output_tokens: config.max_tokens || 500
  };

  if (!String(body.model).startsWith('gpt-5')) {
    body.temperature = typeof config.temperature === 'number' ? config.temperature : 0.7;
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
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
    ...getTokenUsageFromOpenAI(data)
  };
}

async function callClaude({ apiKey, config, input, systemPrompt }) {
  const startedAt = Date.now();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.model || 'claude-3-haiku',
      max_tokens: config.max_tokens || 500,
      temperature: typeof config.temperature === 'number' ? config.temperature : 0.7,
      system: systemPrompt,
      messages: [{ role: 'user', content: input }]
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `Claude respondeu HTTP ${response.status}`);
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
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    processing_time_ms: Date.now() - startedAt
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

  const todayUsage = await countTodayUsage(supabase, clientId);
  if (todayUsage >= (config.daily_limit || 50)) {
    return { skipped: true, reason: 'Limite diario atingido' };
  }

  const provider = getProviderForModel(config.model || client?.ai_model);
  const apiKey = provider === 'claude' ? client?.claude_api_key : client?.openai_api_key;
  if (!apiKey || apiKey === '***') {
    return { skipped: true, reason: 'API key nao configurada' };
  }

  const effectiveConfig = {
    ...config,
    product_source_urls: normalizeSourceUrls((integrations || []).map(integration => integration.api_endpoint)),
    model: config.model || client?.ai_model || (provider === 'claude' ? 'claude-3-haiku' : 'gpt-4o-mini')
  };
  const systemPrompt = buildSystemPrompt(effectiveConfig, contact, conversation);
  const conversationHistory = await getConversationMessagesFromStart(supabase, clientId, conversation?.id);

  try {
    const result = provider === 'claude'
      ? await callClaude({
          apiKey,
          config: effectiveConfig,
          input: [
            formatConversationHistory(conversationHistory) ? `Historico recente:\n${formatConversationHistory(conversationHistory)}` : '',
            media ? `${message || ''}\n\nMidia recebida:\n${getMediaDescription(media)}` : message
          ].filter(Boolean).join('\n\n'),
          systemPrompt
        })
      : await callOpenAI({ apiKey, config: effectiveConfig, input: message, systemPrompt, media, conversationHistory });

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

    throw error;
  }
}

module.exports = {
  generateAIResponse
};
