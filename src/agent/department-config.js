const DEFAULT_DEPARTMENTS = {
  sales: {
    enabled: true,
    name: 'Vendas',
    objective: 'converter interesse em produto em atendimento objetivo, com catalogo e cards quando houver evidencia',
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
    objective: 'responder duvidas gerais, politicas, prazos, troca, entrega e funcionamento sem inventar informacoes',
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
    objective: 'consultar pagamentos, pedidos, cobrancas e status transacional antes de responder',
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
    objective: 'tratar horarios, agendamentos, retirada marcada e disponibilidade operacional',
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
    objective: 'encaminhar somente quando o cliente pedir humano explicitamente ou quando regra critica exigir',
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

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[\n,]+/).map(item => item.trim()).filter(Boolean);
  return [];
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
      objective: String(current.objective || defaults.objective).trim() || defaults.objective,
      sourcePriority: normalizeStringList(current.sourcePriority || current.source_priority || defaults.sourcePriority),
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
  normalizeStringList
};
