function firstUsefulEvidence(evidence = [], preferred = []) {
  const byPreferred = evidence.find(item => preferred.includes(item.sourceType) && String(item.content || '').trim());
  return byPreferred || null;
}

function cleanEvidenceText(text = '') {
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^(Cliente|IA|Assistente|Atendente)\s*:/i.test(line))
    .filter(line => !/^(Fonte|Nome da fonte|Titulo da pagina|Produto\/link)\b/i.test(line))
    .slice(0, 6)
    .join('\n')
    .replace(/^Informacoes (gerais|coletadas|operacionais).*?:\s*/i, '')
    .trim();
}

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function splitEvidenceSentences(text = '') {
  return String(text || '')
    .replace(/\r/g, '\n')
    .split(/\n|(?<=[.!?])\s+/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^(Cliente|IA|Assistente|Atendente)\s*:/i.test(line))
    .filter(line => !/^(Fonte|Nome da fonte|Titulo da pagina|Produto\/link|Arquivo|Tipo|Conteudo)\b/i.test(line));
}

function selectRelevantEvidenceText(question = '', content = '') {
  const q = normalizeText(question);
  const sentences = splitEvidenceSentences(content);
  const groups = [
    ['varejo', 'atacado', 'vendemos', 'vende', 'venda', 'pedido minimo', 'compra minima'],
    ['pix', 'cartao', 'pagamento', 'pagar', 'aceitamos', 'aceita'],
    ['frete', 'entrega', 'envio', 'enviamos', 'retirada', 'retirar'],
    ['cnpj', 'cpf', 'documento', 'cadastro'],
    ['troca', 'devolucao', 'garantia', 'defeito'],
    ['horario', 'atendimento', 'funcionamento']
  ];
  const wanted = groups.find(group => group.some(term => q.includes(term))) || [];
  const selected = wanted.length > 0
    ? sentences.filter(sentence => {
        const s = normalizeText(sentence);
        return wanted.some(term => s.includes(term));
      })
    : sentences;

  return selected
    .slice(0, 3)
    .join(' ')
    .replace(/^Prompt\/configuracao do cliente:\s*/i, '')
    .replace(/^Configuracao do cliente:\s*/i, '')
    .trim();
}

function getCatalogCards(evidence = []) {
  const cards = [];
  for (const item of evidence) {
    if (Array.isArray(item.metadata?.productCards)) cards.push(...item.metadata.productCards);
  }
  return cards;
}

function getLineValue(text = '', pattern) {
  return String(text || '').match(pattern)?.[1]?.trim() || '';
}

function uniqueItems(items = []) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const value = String(item || '').trim();
    if (!value) continue;
    const key = normalizeText(value);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function extractRequestedSizes(text = '') {
  const normalized = normalizeText(text);
  const sizes = [];
  const patterns = [
    /\b(?:tamanho|tam|numero|n[ºo])\s*(\d{1,2})\b/gi,
    /\b(\d{1,2})\s*(?:anos|ano)\b/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(normalized))) {
      sizes.push(match[1]);
    }
  }
  return uniqueItems(sizes);
}

function splitCsvValues(value = '') {
  return String(value || '')
    .split(/,|;|\|/)
    .map(item => item.trim())
    .filter(Boolean);
}

function parseProductSuggestionsFromText(content = '') {
  const text = String(content || '');
  const chunks = text
    .split(/(?=Produto:\s*)/i)
    .map(chunk => chunk.trim())
    .filter(chunk => /^Produto:\s*/i.test(chunk));

  return chunks.map(chunk => {
    const title = getLineValue(chunk, /^Produto:\s*([^\n]+)/i);
    if (!title) return null;
    const colors = splitCsvValues(getLineValue(chunk, /^Cores:\s*([^\n]+)/im));
    const sizes = splitCsvValues(getLineValue(chunk, /^Tamanhos:\s*([^\n]+)/im))
      .map(value => value.replace(/^0+/, '') || value);
    const variations = splitCsvValues(getLineValue(chunk, /^Variacoes:\s*([^\n]+)/im));
    return { title, colors, sizes, variations };
  }).filter(Boolean);
}

function getProductSuggestions(evidence = [], messageText = '') {
  const requestedSizes = extractRequestedSizes(messageText);
  const suggestions = [];

  for (const item of evidence) {
    if (!['catalog', 'rag', 'product_api'].includes(item.sourceType)) continue;
    const products = Array.isArray(item.metadata?.products) ? item.metadata.products : [];
    for (const product of products) {
      const title = String(product.title || product.name || product.nome || '').trim();
      if (!title) continue;
      suggestions.push({
        title,
        colors: Array.isArray(product.colors) ? product.colors : [],
        sizes: Array.isArray(product.sizes) ? product.sizes : [],
        variations: Array.isArray(product.variations) ? product.variations : []
      });
    }
    suggestions.push(...parseProductSuggestionsFromText(item.content));
  }

  const filtered = requestedSizes.length > 0
    ? suggestions.filter(product => {
        const haystack = [
          ...(product.sizes || []),
          ...(product.variations || [])
        ].map(value => normalizeText(value));
        return requestedSizes.some(size => haystack.some(value =>
          value === size
          || value.includes(`tamanho ${size}`)
          || value.includes(`tam ${size}`)
          || value.includes(` ${size}`)
        ));
      })
    : suggestions;

  const deduped = [];
  const seen = new Set();
  for (const product of filtered) {
    const key = normalizeText(product.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      title: product.title,
      colors: uniqueItems(product.colors || []).slice(0, 4),
      sizes: uniqueItems(product.sizes || []).slice(0, 8),
      variations: uniqueItems(product.variations || []).slice(0, 6)
    });
  }
  return deduped.slice(0, 4);
}

function buildProductSuggestionAnswer(products = [], messageText = '') {
  if (!products.length) return '';
  const requestedSizes = extractRequestedSizes(messageText);
  const sizeText = requestedSizes.length ? ` no tamanho ${requestedSizes.join(', ')}` : '';
  const lines = products.map((product, index) => {
    const details = [];
    if (product.sizes.length) details.push(`tamanhos: ${product.sizes.join(', ')}`);
    if (product.colors.length) details.push(`cores: ${product.colors.join(', ')}`);
    if (!product.sizes.length && product.variations.length) details.push(`variacoes: ${product.variations.join(', ')}`);
    return `${index + 1}. ${product.title}${details.length ? ` (${details.join('; ')})` : ''}`;
  });
  return [
    `Encontrei opcoes compatíveis${sizeText} nas fontes do catalogo:`,
    ...lines,
    'Quer que eu veja mais detalhes de algum desses modelos?'
  ].join('\n');
}

function digitsOnly(value = '') {
  return String(value || '').replace(/\D/g, '');
}

function phoneMatches(left = '', right = '') {
  const a = digitsOnly(left);
  const b = digitsOnly(right);
  if (!a || !b) return false;
  return a.endsWith(b.slice(-10)) || b.endsWith(a.slice(-10)) || a.endsWith(b.slice(-11)) || b.endsWith(a.slice(-11));
}

function extractEvidencePhones(text = '') {
  return String(text || '')
    .split('\n')
    .filter(line => /(?:whatsapp|telefone|phone|celular)/i.test(line))
    .filter(line => !/https?:\/\//i.test(line))
    .map(line => digitsOnly(line))
    .filter(value => value.length >= 8);
}

function buildSafeOrderStatusText(content = '', message = {}) {
  const text = String(content || '');
  const explicitOrderSentence = String(text.match(/\bpedido\s*#?\s*\d+[^\n]*/i)?.[0] || '').trim();
  const messageHasOrderRef = /\b(?:pedido|ordem|compra)\s*#?\s*\d+/i.test(message.text || '');
  const customerPhone = message.customerPhone || message.contact?.phone || message.conversation?.phone || '';
  const evidencePhones = extractEvidencePhones(text);
  const orderCode = getLineValue(text, /^-\s*(?:codigo|pedido|numero_pedido|order_id):\s*([^\n]+)/im)
    || getLineValue(text, /\n(?:codigo|pedido|numero_pedido|order_id):\s*([^\n]+)/i);
  const trackingCode = getLineValue(text, /(?:rastreio|codigo_rastreio|tracking(?:_code)?):\s*([^\n]+)/i);
  const paymentStatus = getLineValue(text, /pagamentos:\s*status:\s*([^\n]+)/i)
    || getLineValue(text, /(?:pagamento_status|status_pagamento):\s*([^\n]+)/i);
  const total = getLineValue(text, /^-\s*total:\s*([^\n]+)/im) || getLineValue(text, /\ntotal:\s*([^\n]+)/i);
  const deliveryMethod = getLineValue(text, /forma_entrega:\s*nome:\s*([^\n]+)/i);
  const paid = /status_pago:\s*true/i.test(text) || /pagamentos:\s*status:\s*pago/i.test(text);
  const preparing = /status_em_separacao:\s*true/i.test(text);
  const separated = /status_separado:\s*true/i.test(text);
  const shipped = /status_despachado:\s*true/i.test(text);
  const delivered = /status_entregue:\s*true/i.test(text);
  const hasOrderSignal = Boolean(orderCode || trackingCode || paymentStatus || total || deliveryMethod
    || paid || preparing || separated || shipped || delivered);
  const hasMatchingPhone = customerPhone && evidencePhones.some(phone => phoneMatches(phone, customerPhone));

  if (!messageHasOrderRef && !orderCode && !hasMatchingPhone) return '';

  if (!hasOrderSignal) {
    return explicitOrderSentence && !/cliente:\s*(nome|whatsapp|telefone|email|cpf|cnpj)/i.test(explicitOrderSentence)
      ? explicitOrderSentence
      : '';
  }

  const currentStatus = delivered
    ? 'entregue'
    : shipped
      ? 'despachado/enviado'
      : separated
        ? 'separado'
        : preparing
          ? 'em separacao'
          : paid || /pago/i.test(paymentStatus)
            ? 'pagamento confirmado, aguardando separacao/envio'
            : 'localizado na integracao';

  return [
    orderCode ? `Encontrei o pedido ${orderCode} na integracao.` : 'Encontrei o pedido na integracao.',
    total ? `Total: ${total}.` : '',
    deliveryMethod ? `Entrega: ${deliveryMethod}.` : '',
    trackingCode ? `Rastreio: ${trackingCode}.` : '',
    `Status atual: ${currentStatus}.`,
    paymentStatus || paid ? `Pagamento: ${paid || /pago/i.test(paymentStatus) ? 'pago/confirmado' : paymentStatus}.` : ''
  ].filter(Boolean).join('\n');
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

function buildEvidenceBrief(evidence = []) {
  return evidence
    .filter(item => String(item.content || '').trim())
    .slice(0, 8)
    .map((item, index) => [
      `Fonte ${index + 1}: ${item.sourceName || item.sourceType || 'fonte'}`,
      `Tipo: ${item.sourceType || ''}`,
      `Conteudo: ${cleanEvidenceText(item.content).slice(0, 1800)}`
    ].join('\n'))
    .join('\n\n---\n\n');
}

async function callOpenAIAnswerComposer({ apiKey, model, temperature, prompt, maxTokens = 420 }) {
  if (!String(apiKey || '').trim()) return null;
  const body = {
    model: model || 'gpt-4o-mini',
    instructions: 'Voce compoe respostas curtas de WhatsApp somente com base nas evidencias fornecidas. Retorne apenas JSON valido.',
    input: [{ role: 'user', content: prompt }],
    max_output_tokens: maxTokens
  };
  if (!String(body.model).startsWith('gpt-5')) {
    body.temperature = typeof temperature === 'number' ? temperature : 0.2;
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
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${response.status}`);
  const text = data.output_text
    || (Array.isArray(data.output) ? data.output.flatMap(item => item.content || []).map(item => item.text || '').join('\n') : '');
  return parseJsonObject(text);
}

async function callClaudeAnswerComposer({ apiKey, model, temperature, prompt, maxTokens = 420 }) {
  if (!String(apiKey || '').trim()) return null;
  const body = {
    model: model || 'claude-3-haiku-20240307',
    max_tokens: maxTokens,
    temperature: typeof temperature === 'number' ? temperature : 0.2,
    system: 'Voce compoe respostas curtas de WhatsApp somente com base nas evidencias fornecidas. Retorne apenas JSON valido.',
    messages: [{ role: 'user', content: prompt }]
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Claude HTTP ${response.status}`);
  const text = Array.isArray(data.content)
    ? data.content.map(item => item?.text || '').join('\n')
    : '';
  return parseJsonObject(text);
}

async function composeWithAgentModel({ message = {}, route = {}, ranked = [], departmentSettings = {} } = {}) {
  if (departmentSettings.llmResponseEnabled === false) return null;
  if (route.intent === 'product' || route.intent === 'order_status' || route.explicitHumanRequest) return null;

  const evidenceBrief = buildEvidenceBrief(ranked);
  if (!evidenceBrief) return null;

  const runtime = message.effectiveConfig?._answerRuntimeContext || {};
  const hasRuntimeComposer = typeof runtime.generateAnswer === 'function';
  const model = departmentSettings.model || message.effectiveConfig?.model || 'gpt-4o-mini';
  const wantsClaude = String(model || '').toLowerCase().includes('claude');
  const apiKey = wantsClaude
    ? (runtime.claudeApiKey || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY)
    : (runtime.openaiApiKey || message.effectiveConfig?.intent_classifier_api_key || process.env.OPENAI_API_KEY);
  if (!hasRuntimeComposer && !String(apiKey || '').trim()) return null;

  const rules = [
    ...(Array.isArray(departmentSettings.responseRules) ? departmentSettings.responseRules : []),
    ...(Array.isArray(departmentSettings.sourceUseRules) ? departmentSettings.sourceUseRules : []),
    ...(Array.isArray(departmentSettings.boundaryRules) ? departmentSettings.boundaryRules : [])
  ].join('\n- ');
  const sourceContract = Array.isArray(departmentSettings.allowedSources) && departmentSettings.allowedSources.length > 0
    ? `Fontes autorizadas para este agente: ${departmentSettings.allowedSources.join(', ')}`
    : '';
  const prompt = [
    departmentSettings.systemPrompt || departmentSettings.objective || 'Voce e um agente de atendimento.',
    '',
    'Mensagem do cliente:',
    message.text || '',
    '',
    'Intencao e setor:',
    `${route.intent || 'unknown'} / ${departmentSettings.name || ''}`,
    '',
    rules ? `Regras do agente:\n- ${rules}` : '',
    sourceContract,
    '',
    'Evidencias permitidas para responder:',
    evidenceBrief,
    '',
    'Tarefa: responda em portugues do Brasil, em tom natural de WhatsApp. Use somente as evidencias acima. Se faltar dado essencial, deixe text vazio e preencha missingInfo em vez de inventar.',
    'Formato JSON obrigatorio:',
    '{"text":"resposta curta","confidence":"high|medium|low","missingInfo":"","grounded":true}'
  ].filter(Boolean).join('\n');

  try {
    const generated = hasRuntimeComposer
      ? await runtime.generateAnswer({ message, route, ranked, departmentSettings, prompt })
      : wantsClaude
        ? await callClaudeAnswerComposer({
            apiKey,
            model,
            temperature: departmentSettings.temperature,
            prompt,
            maxTokens: message.effectiveConfig?.max_tokens || 420
          })
        : await callOpenAIAnswerComposer({
            apiKey,
            model,
            temperature: departmentSettings.temperature,
            prompt,
            maxTokens: message.effectiveConfig?.max_tokens || 420
          });

    const text = String(generated?.text || '').trim();
    const missingInfo = String(generated?.missingInfo || '').trim();
    if (!text && missingInfo) {
      return {
        text: '',
        confidence: 'low',
        grounded: false,
        missingInfo,
        product_cards: [],
        composer: 'agent_llm'
      };
    }
    if (!text) return null;
    return {
      text,
      confidence: ['high', 'medium', 'low'].includes(generated.confidence) ? generated.confidence : 'medium',
      grounded: generated.grounded !== false,
      missingInfo,
      product_cards: [],
      composer: 'agent_llm'
    };
  } catch (error) {
    return {
      text: '',
      confidence: 'low',
      grounded: false,
      missingInfo: '',
      product_cards: [],
      composer: 'agent_llm_failed',
      error: String(error?.message || error)
    };
  }
}

async function compose({ message = {}, route = {}, evidence = {} } = {}) {
  const ranked = evidence.topEvidence || evidence.evidence || [];
  const productCards = getCatalogCards(ranked);
  const departmentSettings = evidence.departmentSettings || evidence.department_settings || {};

  if (route.explicitHumanRequest) {
    return {
      text: 'Certo, vou te encaminhar para um atendente.',
      confidence: 'high',
      grounded: true,
      product_cards: []
    };
  }

  if (route.intent === 'product') {
    const catalogEvidence = ranked.find(item => item.sourceType === 'catalog') || firstUsefulEvidence(ranked, ['catalog']);
    if (productCards.length > 0) {
      return {
        text: 'Encontrei essas opcoes no catalogo. Enviei as fotos acima; posso verificar tamanho, cor ou disponibilidade desse produto.',
        confidence: 'high',
        grounded: true,
        product_cards: productCards
      };
    }
    const suggestedProducts = getProductSuggestions(ranked, message.text || '');
    if (suggestedProducts.length > 0) {
      return {
        text: buildProductSuggestionAnswer(suggestedProducts, message.text || ''),
        confidence: 'high',
        grounded: true,
        product_cards: []
      };
    }
    if (catalogEvidence?.metadata?.lookupAttempted && catalogEvidence?.metadata?.productsFound === false) {
      return {
        text: 'Nao encontrei com esses detalhes. Voce quer procurar por outro tamanho, cor ou modelo?',
        confidence: 'medium',
        grounded: true,
        product_cards: []
      };
    }
    return {
      text: '',
      confidence: 'low',
      grounded: false,
      missingInfo: 'product',
      product_cards: []
    };
  }

  if (route.intent === 'order_status') {
    const apiEvidence = firstUsefulEvidence(ranked, ['api']);
    if (apiEvidence && !apiEvidence.metadata?.error) {
      const text = buildSafeOrderStatusText(apiEvidence.content, message);
      if (!text) {
        return {
          text: '',
          confidence: 'low',
          grounded: false,
          missingInfo: 'order_number',
          product_cards: []
        };
      }
      return {
        text,
        confidence: 'high',
        grounded: true,
        product_cards: []
      };
    }
    if (apiEvidence?.metadata?.error) {
      return {
        text: 'Nao consegui consultar o pedido neste momento. Me envia o numero do pedido para eu tentar verificar com mais precisao?',
        confidence: 'low',
        grounded: false,
        missingInfo: 'order_number',
        product_cards: []
      };
    }
    return {
      text: '',
      confidence: 'low',
      grounded: false,
      missingInfo: 'order_number',
      product_cards: []
    };
  }

  const llmDraft = await composeWithAgentModel({ message, route, ranked, departmentSettings });
  if (llmDraft?.grounded && llmDraft.text) return llmDraft;
  if (llmDraft?.missingInfo) return llmDraft;

  const groundedEvidence = firstUsefulEvidence(ranked, ['rag', 'file', 'site', 'api', 'catalog', 'policy', 'faq']);
  if (!groundedEvidence) {
    return {
      text: '',
      confidence: 'low',
      grounded: false,
      missingInfo: inferMissingInfo(message, route),
      product_cards: []
    };
  }

  const text = selectRelevantEvidenceText(message.text || '', groundedEvidence.content) || cleanEvidenceText(groundedEvidence.content);
  if (!text) {
    return {
      text: '',
      confidence: 'low',
      grounded: false,
      missingInfo: inferMissingInfo(message, route),
      product_cards: []
    };
  }
  return {
    text,
    confidence: groundedEvidence.score >= 0.65 ? 'high' : 'medium',
    grounded: true,
    product_cards: []
  };
}

function inferMissingInfo(message = {}, route = {}) {
  const text = String(message.text || '');
  if (route.intent === 'product') return 'product';
  if (route.intent === 'order_status') return 'order_number';
  if (/\b(varejo|atacado|quantidade|unidade)\b/i.test(text)) return 'purchase_mode';
  if (/\bcidade\b|minha cidade|isso vale/i.test(text)) return 'city';
  return 'details';
}

module.exports = {
  compose,
  cleanEvidenceText,
  getCatalogCards,
  composeWithAgentModel,
  buildEvidenceBrief,
  callOpenAIAnswerComposer,
  callClaudeAnswerComposer
};
