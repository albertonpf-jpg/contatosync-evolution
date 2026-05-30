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
    ...(Array.isArray(departmentSettings.sourceUseRules) ? departmentSettings.sourceUseRules : [])
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
      const text = cleanEvidenceText(apiEvidence.content);
      return {
        text: text || 'Encontrei dados do pedido na integracao configurada.',
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
