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
    product.description ? `Descricao: ${product.description}` : '',
    product.images?.length ? `Imagens encontradas: ${product.images.slice(0, 5).join(', ')}` : ''
  ].filter(Boolean).join('\n')).join('\n\n');

  const productCards = [];
  for (const product of products) {
    for (const image of (product.images || []).slice(0, 5)) {
      productCards.push({
        title: product.title || 'Produto',
        description: product.description || '',
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

async function buildOpenAIInputContent({ apiKey, message, media, config }) {
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

  if (productContext.contextText) {
    content.push({
      type: 'input_text',
      text: `${productContext.contextText}\n\nSe essas informacoes forem de produto, responda com dados uteis e objetivos. Nao invente preco, estoque ou variacao que nao esteja no conteudo coletado.`
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

async function callOpenAI({ apiKey, config, input, systemPrompt, media }) {
  const startedAt = Date.now();
  const builtInput = Array.isArray(input)
    ? { content: input, productImages: [] }
    : await buildOpenAIInputContent({ apiKey, message: input, media, config });
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

  try {
    const result = provider === 'claude'
      ? await callClaude({ apiKey, config: effectiveConfig, input: media ? `${message || ''}\n\nMidia recebida:\n${getMediaDescription(media)}` : message, systemPrompt })
      : await callOpenAI({ apiKey, config: effectiveConfig, input: message, systemPrompt, media });

    result.response = suppressRepeatedGreeting(result.response, effectiveConfig.greeting_message, conversation);

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
