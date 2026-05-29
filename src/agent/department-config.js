const DEFAULT_DEPARTMENTS = {
  sales: {
    enabled: true,
    name: 'Vendas',
    objective: 'converter interesse em produto em atendimento objetivo, com catalogo e cards quando houver evidencia',
    handoffKeywords: ['preco divergente', 'desconto especial', 'negociar', 'revenda grande'],
    maxEvidence: 5
  },
  support: {
    enabled: true,
    name: 'Atendimento',
    objective: 'responder duvidas gerais, politicas, prazos, troca, entrega e funcionamento sem inventar informacoes',
    handoffKeywords: ['reclamacao grave', 'procon', 'juridico', 'processo'],
    maxEvidence: 5
  },
  billing: {
    enabled: true,
    name: 'Financeiro',
    objective: 'consultar pagamentos, pedidos, cobrancas e status transacional antes de responder',
    handoffKeywords: ['estorno', 'chargeback', 'cobranca indevida', 'comprovante divergente'],
    maxEvidence: 4
  },
  scheduling: {
    enabled: true,
    name: 'Agenda',
    objective: 'tratar horarios, agendamentos, retirada marcada e disponibilidade operacional',
    handoffKeywords: ['encaixe', 'urgente', 'fora do horario'],
    maxEvidence: 4
  },
  handoff: {
    enabled: true,
    name: 'Encaminhamento',
    objective: 'encaminhar somente quando o cliente pedir humano explicitamente ou quando regra critica exigir',
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
