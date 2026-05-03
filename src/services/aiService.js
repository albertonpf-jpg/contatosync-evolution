const { v4: uuidv4 } = require('uuid');
const { isWithinWorkingHours } = require('../utils/helpers');

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
  const greeting = config.greeting_message ? `\n\nMensagem de saudacao configurada: ${config.greeting_message}` : '';
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
    '- Responda como mensagem curta de WhatsApp, sem markdown pesado.'
  ].join('\n');

  return `${basePrompt}${greeting}${fallback}${triggerContext}\n\n${context}`;
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

async function callOpenAI({ apiKey, config, input, systemPrompt }) {
  const startedAt = Date.now();
  const body = {
    model: config.model || 'gpt-4o-mini',
    instructions: systemPrompt,
    input,
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
  const [{ data: config }, { data: client }] = await Promise.all([
    supabase
      .from('evolution_ai_config')
      .select('*')
      .eq('client_id', clientId)
      .single(),
    supabase
      .from('evolution_clients')
      .select('id, openai_api_key, claude_api_key, ai_model, auto_reply_enabled')
      .eq('id', clientId)
      .single()
  ]);

  return { config, client };
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

async function generateAIResponse({ supabase, clientId, message, conversation, contact }) {
  const { config, client } = await getAISetup(supabase, clientId);

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
    model: config.model || client?.ai_model || (provider === 'claude' ? 'claude-3-haiku' : 'gpt-4o-mini')
  };
  const systemPrompt = buildSystemPrompt(effectiveConfig, contact, conversation);

  try {
    const result = provider === 'claude'
      ? await callClaude({ apiKey, config: effectiveConfig, input: message, systemPrompt })
      : await callOpenAI({ apiKey, config: effectiveConfig, input: message, systemPrompt });

    await logAIResult(supabase, {
      client_id: clientId,
      conversation_id: conversation?.id,
      status: 'success',
      ...result
    });

    return { skipped: false, ...result };
  } catch (error) {
    await logAIResult(supabase, {
      client_id: clientId,
      conversation_id: conversation?.id,
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
