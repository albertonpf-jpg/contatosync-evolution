const DEFAULT_DEPARTMENTS = {
  sales: {
    enabled: true,
    name: 'Vendas',
    intents: ['product'],
    objective: 'converter interesse em produto em atendimento objetivo, com catalogo e cards quando houver evidencia',
    semanticDescription: 'Acione quando a mensagem indicar compra, interesse em produto, preco, variacao, tamanho, cor, disponibilidade, foto, modelo ou catalogo, mesmo sem usar essas palavras exatas.',
    activationExamples: ['Tem algo para bebe de 2 anos?', 'Queria ver opcoes para festa', 'Quanto fica esse conjunto?', 'Voce tem tamanho 6?'],
    boundaryRules: ['nao atender status de pedido ja feito', 'nao tratar comprovante, boleto ou cobranca', 'nao prometer agenda ou retirada sem agente de agenda'],
    exclusionExamples: ['meu pedido ja saiu?', 'paguei no pix e nao confirmou', 'quero agendar retirada'],
    systemPrompt: 'Voce e o agente de vendas. Ajude o cliente a encontrar produtos reais, confirme variacoes e nunca invente preco ou estoque.',
    model: '',
    temperature: null,
    allowedSources: ['catalog', 'api', 'rag', 'file', 'site', 'conversation_memory'],
    allowedIntegrationTypes: [],
    allowedIntegrationIds: [],
    allowedSourceUrls: [],
    allowedKnowledgeFileIds: [],
    sourceUseRules: ['use catalogo para produto, preco, estoque, foto e variacao', 'use API quando houver integracao transacional relevante', 'use RAG/arquivos/site para politicas comerciais'],
    sourcePriority: ['catalog', 'api', 'rag', 'file', 'site', 'conversation_memory'],
    responseRules: [
      'priorizar catalogo vivo e cards quando houver produto encontrado',
      'perguntar tamanho, cor ou modelo quando a busca nao for suficiente',
      'nao inventar preco, estoque ou disponibilidade'
    ],
    handoffKeywords: ['preco divergente', 'desconto especial', 'negociar', 'revenda grande'],
    maxEvidence: 5
  },
  support: {
    enabled: true,
    name: 'Atendimento',
    intents: ['faq', 'policy', 'support', 'complaint', 'unknown'],
    objective: 'responder duvidas gerais, politicas, prazos, troca, entrega e funcionamento sem inventar informacoes',
    semanticDescription: 'Acione para duvidas gerais, politicas da loja, entrega, retirada, troca, devolucao, garantia, horario, reclamacoes e mensagens ambiguas.',
    activationExamples: ['Como funciona a entrega?', 'Posso trocar?', 'Que horas abre?', 'Nao entendi como comprar'],
    boundaryRules: ['nao responder status de pedido sem consultar agente financeiro', 'nao tratar compra de produto especifico quando vendas for mais adequado', 'nao assumir pedido humano sem solicitacao explicita'],
    exclusionExamples: ['meu pedido ja saiu?', 'tem vestido azul tamanho 4?', 'quero falar com atendente'],
    systemPrompt: 'Voce e o agente de atendimento. Responda com base nas politicas e fontes oficiais, sem prometer o que nao esta configurado.',
    model: '',
    temperature: null,
    allowedSources: ['rag', 'file', 'site', 'api', 'conversation_memory'],
    allowedIntegrationTypes: [],
    allowedIntegrationIds: [],
    allowedSourceUrls: [],
    allowedKnowledgeFileIds: [],
    sourceUseRules: ['use RAG/arquivos/site para politicas e funcionamento', 'use API somente quando a duvida depender de dado vivo', 'pergunte mais detalhes quando a mensagem for ambigua'],
    sourcePriority: ['rag', 'file', 'site', 'api', 'conversation_memory'],
    responseRules: [
      'responder somente com politicas ou fontes configuradas',
      'fazer pergunta objetiva quando faltar contexto',
      'nao transferir para humano sem pedido explicito ou regra critica'
    ],
    handoffKeywords: ['reclamacao grave', 'procon', 'juridico', 'processo'],
    maxEvidence: 5
  },
  billing: {
    enabled: true,
    name: 'Financeiro',
    intents: ['billing', 'order_status'],
    objective: 'consultar pagamentos, pedidos, cobrancas e status transacional antes de responder',
    semanticDescription: 'Acione para pedidos, rastreio, pagamento, cobranca, boleto, comprovante, estorno, status e dados transacionais.',
    activationExamples: ['Meu pedido ja saiu?', 'Paguei no pix e nao confirmou', 'Cadê meu rastreio?', 'Quero segunda via'],
    boundaryRules: ['nao vender produto novo', 'nao responder politica geral sem dado transacional', 'nao confirmar pagamento ou rastreio sem fonte operacional'],
    exclusionExamples: ['tem tamanho 6?', 'como funciona a troca?', 'quero agendar retirada'],
    systemPrompt: 'Voce e o agente financeiro/pedidos. Consulte integracoes antes de responder e peça identificadores quando faltarem.',
    model: '',
    temperature: null,
    allowedSources: ['api', 'rag', 'file', 'site', 'conversation_memory'],
    allowedIntegrationTypes: [],
    allowedIntegrationIds: [],
    allowedSourceUrls: [],
    allowedKnowledgeFileIds: [],
    sourceUseRules: ['use API para pedido, pagamento, rastreio e status', 'peca numero do pedido quando faltar', 'nao exponha dados sensiveis sem contexto suficiente'],
    sourcePriority: ['api', 'rag', 'file', 'site', 'conversation_memory'],
    responseRules: [
      'consultar integracoes antes de responder status de pedido ou pagamento',
      'pedir numero do pedido quando necessario',
      'nao expor dados sensiveis sem contexto suficiente do contato'
    ],
    handoffKeywords: ['estorno', 'chargeback', 'cobranca indevida', 'comprovante divergente'],
    maxEvidence: 4
  },
  scheduling: {
    enabled: true,
    name: 'Agenda',
    intents: ['scheduling'],
    objective: 'tratar horarios, agendamentos, retirada marcada e disponibilidade operacional',
    semanticDescription: 'Acione quando a mensagem envolver agenda, marcar horario, retirada agendada, encaixe, disponibilidade de atendimento ou janela de retirada.',
    activationExamples: ['Consigo retirar amanha?', 'Tem horario hoje?', 'Quero agendar uma retirada', 'Da pra encaixar?'],
    boundaryRules: ['nao vender produto novo', 'nao resolver cobranca ou status de pedido', 'nao responder politica geral quando nao envolver agenda'],
    exclusionExamples: ['paguei no pix e nao confirmou', 'tem vestido azul?', 'qual o prazo de troca?'],
    systemPrompt: 'Voce e o agente de agenda. Confirme data, horario e disponibilidade antes de prometer qualquer agendamento.',
    model: '',
    temperature: null,
    allowedSources: ['api', 'rag', 'file', 'site', 'conversation_memory'],
    allowedIntegrationTypes: [],
    allowedIntegrationIds: [],
    allowedSourceUrls: [],
    allowedKnowledgeFileIds: [],
    sourceUseRules: ['use API se houver disponibilidade viva', 'use RAG/arquivos/site para regras de agenda e retirada', 'pergunte data e horario quando faltarem'],
    sourcePriority: ['api', 'rag', 'file', 'site', 'conversation_memory'],
    responseRules: [
      'confirmar data, horario e unidade quando a mensagem estiver incompleta',
      'usar disponibilidade configurada antes de prometer agenda',
      'sugerir continuidade quando nao houver horario confirmado'
    ],
    handoffKeywords: ['encaixe', 'urgente', 'fora do horario'],
    maxEvidence: 4
  },
  handoff: {
    enabled: true,
    name: 'Encaminhamento',
    intents: ['human_request'],
    objective: 'encaminhar somente quando o cliente pedir humano explicitamente ou quando regra critica exigir',
    semanticDescription: 'Acione apenas quando o cliente pedir claramente pessoa, humano, atendente, transferencia ou suporte humano.',
    activationExamples: ['Quero falar com uma pessoa', 'Me passa para um atendente', 'Nao quero falar com robo'],
    boundaryRules: ['nao acionar humano para duvida que agente especializado pode resolver com seguranca', 'nao interpretar reclamacao comum como pedido humano sem solicitacao clara'],
    exclusionExamples: ['tem tamanho 6?', 'como funciona a entrega?', 'meu pedido ja saiu?'],
    systemPrompt: 'Voce e o agente de encaminhamento. Confirme que um atendente sera acionado e preserve o contexto.',
    model: '',
    temperature: null,
    allowedSources: ['conversation_memory', 'rag', 'file'],
    allowedIntegrationTypes: [],
    allowedIntegrationIds: [],
    allowedSourceUrls: [],
    allowedKnowledgeFileIds: [],
    sourceUseRules: ['use memoria para resumir contexto ao humano', 'nao responda assuntos que outro agente pode resolver'],
    sourcePriority: ['conversation_memory', 'rag', 'file'],
    responseRules: [
      'confirmar que um atendente sera acionado',
      'manter resposta curta',
      'preservar historico da conversa para o humano'
    ],
    handoffKeywords: [],
    maxEvidence: 2
  }
};

const ROUTER_INTENTS = new Set(['faq', 'policy', 'product', 'order_status', 'scheduling', 'billing', 'support', 'human_request', 'complaint', 'unknown']);
const SOURCE_TYPES = new Set(['catalog', 'api', 'rag', 'file', 'site', 'conversation_memory']);

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[\n,]+/).map(item => item.trim()).filter(Boolean);
  return [];
}

function normalizeIntentList(value, fallback = []) {
  const list = normalizeStringList(value).filter(intent => ROUTER_INTENTS.has(intent));
  return list.length ? list : normalizeStringList(fallback).filter(intent => ROUTER_INTENTS.has(intent));
}

function normalizeSourceList(value, fallback = []) {
  const list = normalizeStringList(value)
    .map(source => source === 'files' ? 'file' : source)
    .filter(source => SOURCE_TYPES.has(source));
  return list.length ? [...new Set(list)] : normalizeStringList(fallback)
    .map(source => source === 'files' ? 'file' : source)
    .filter(source => SOURCE_TYPES.has(source));
}

function normalizeNullableTemperature(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(2, number));
}

function normalizeDepartmentConfig(rawConfig = {}) {
  const source = rawConfig.department_agent_config || rawConfig.departmentAgentConfig || {};
  const normalized = {};

  for (const [id, defaults] of Object.entries(DEFAULT_DEPARTMENTS)) {
    const current = source && typeof source === 'object' ? (source[id] || {}) : {};
    normalized[id] = {
      ...defaults,
      ...current,
      enabled: current.enabled !== false,
      name: String(current.name || defaults.name).trim() || defaults.name,
      intents: normalizeIntentList(current.intents, defaults.intents),
      objective: String(current.objective || defaults.objective).trim() || defaults.objective,
      semanticDescription: String(current.semanticDescription || current.semantic_description || defaults.semanticDescription || '').trim(),
      activationExamples: normalizeStringList(current.activationExamples || current.activation_examples || defaults.activationExamples),
      boundaryRules: normalizeStringList(current.boundaryRules || current.boundary_rules || defaults.boundaryRules),
      exclusionExamples: normalizeStringList(current.exclusionExamples || current.exclusion_examples || defaults.exclusionExamples),
      systemPrompt: String(current.systemPrompt || current.system_prompt || defaults.systemPrompt || '').trim(),
      model: String(current.model || defaults.model || '').trim(),
      temperature: normalizeNullableTemperature(current.temperature, defaults.temperature),
      allowedSources: normalizeSourceList(current.allowedSources || current.allowed_sources, defaults.allowedSources),
      allowedIntegrationTypes: normalizeStringList(current.allowedIntegrationTypes || current.allowed_integration_types || defaults.allowedIntegrationTypes),
      allowedIntegrationIds: normalizeStringList(current.allowedIntegrationIds || current.allowed_integration_ids || defaults.allowedIntegrationIds),
      allowedSourceUrls: normalizeStringList(current.allowedSourceUrls || current.allowed_source_urls || defaults.allowedSourceUrls),
      allowedKnowledgeFileIds: normalizeStringList(current.allowedKnowledgeFileIds || current.allowed_knowledge_file_ids || defaults.allowedKnowledgeFileIds),
      sourceUseRules: normalizeStringList(current.sourceUseRules || current.source_use_rules || defaults.sourceUseRules),
      sourcePriority: normalizeSourceList(current.sourcePriority || current.source_priority, defaults.sourcePriority),
      responseRules: normalizeStringList(current.responseRules || current.response_rules || defaults.responseRules),
      handoffKeywords: normalizeStringList(current.handoffKeywords || current.handoff_keywords || defaults.handoffKeywords),
      maxEvidence: Math.max(1, Math.min(10, Number(current.maxEvidence || current.max_evidence || defaults.maxEvidence) || defaults.maxEvidence))
    };
  }

  return normalized;
}

function getDepartmentSettings(rawConfig = {}, departmentId = 'support') {
  const departments = normalizeDepartmentConfig(rawConfig);
  return departments[departmentId] || departments.support;
}

module.exports = {
  DEFAULT_DEPARTMENTS,
  normalizeDepartmentConfig,
  getDepartmentSettings,
  normalizeStringList,
  normalizeIntentList,
  normalizeSourceList,
  normalizeNullableTemperature
};
