const sourceDecision = require('../../router/source-decision');
const { getDepartmentSettings } = require('../department-config');

function clonePlan(plan = {}) {
  return {
    ...plan,
    executeSources: Array.isArray(plan.executeSources) ? [...plan.executeSources] : [],
    skippedSources: Array.isArray(plan.skippedSources) ? [...plan.skippedSources] : [],
    sources: Array.isArray(plan.sources) ? plan.sources.map(source => ({ ...source })) : []
  };
}

function orderSources(plan, priority = []) {
  const next = clonePlan(plan);
  const priorityIndex = new Map(priority.map((source, index) => [source, index]));
  next.executeSources = [...next.executeSources].sort((a, b) => {
    const left = priorityIndex.has(a) ? priorityIndex.get(a) : 999;
    const right = priorityIndex.has(b) ? priorityIndex.get(b) : 999;
    return left - right;
  });
  next.sources = [...next.sources].sort((a, b) => {
    const left = priorityIndex.has(a.sourceType) ? priorityIndex.get(a.sourceType) : 999;
    const right = priorityIndex.has(b.sourceType) ? priorityIndex.get(b.sourceType) : 999;
    return left - right;
  });
  return next;
}

function buildPlanWithPriority({ message, route, priority, reason }) {
  const basePlan = sourceDecision.build({ message, route });
  const plan = orderSources(basePlan, priority);
  return {
    ...plan,
    departmentReason: reason,
    reason: `${basePlan.reason} Departamento responsavel: ${reason}`
  };
}

function applyDepartmentSettingsToPlan(plan = {}, settings = {}) {
  const sourcePriority = Array.isArray(settings.sourcePriority) && settings.sourcePriority.length > 0
    ? settings.sourcePriority
    : [];
  const next = sourcePriority.length > 0 ? orderSources(plan, sourcePriority) : clonePlan(plan);
  return {
    ...next,
    departmentSettings: {
      name: settings.name,
      objective: settings.objective,
      sourcePriority,
      responseRules: settings.responseRules || [],
      maxEvidence: settings.maxEvidence
    }
  };
}

const departmentAgents = {
  sales: {
    id: 'sales',
    label: 'Vendas',
    intents: ['product'],
    buildRetrievalPlan: ({ message, route }) => buildPlanWithPriority({
      message,
      route,
      priority: ['catalog', 'rag', 'file', 'site', 'conversation_memory'],
      reason: 'vendas prioriza catalogo, disponibilidade, preco e cards de produto'
    })
  },
  support: {
    id: 'support',
    label: 'Atendimento',
    intents: ['faq', 'policy', 'support', 'complaint', 'unknown'],
    buildRetrievalPlan: ({ message, route }) => buildPlanWithPriority({
      message,
      route,
      priority: ['rag', 'file', 'site', 'conversation_memory'],
      reason: 'atendimento prioriza politicas, arquivos, site e memoria da conversa'
    })
  },
  billing: {
    id: 'billing',
    label: 'Financeiro',
    intents: ['billing', 'order_status'],
    buildRetrievalPlan: ({ message, route }) => buildPlanWithPriority({
      message,
      route,
      priority: ['api', 'rag', 'file', 'site', 'conversation_memory'],
      reason: 'financeiro consulta integracoes transacionais antes de conhecimento estatico'
    })
  },
  scheduling: {
    id: 'scheduling',
    label: 'Agenda',
    intents: ['scheduling'],
    buildRetrievalPlan: ({ message, route }) => buildPlanWithPriority({
      message,
      route,
      priority: ['api', 'rag', 'file', 'site', 'conversation_memory'],
      reason: 'agenda consulta disponibilidade viva antes de regras gerais'
    })
  },
  handoff: {
    id: 'handoff',
    label: 'Encaminhamento',
    intents: ['human_request'],
    buildRetrievalPlan: ({ message, route }) => ({
      ...sourceDecision.build({ message, route }),
      departmentReason: 'encaminhamento so e acionado quando o cliente pede humano explicitamente'
    })
  }
};

const departmentRoutingDescriptions = {
  sales: 'produto, preco, estoque, catalogo, fotos, tamanhos, cores e interesse de compra',
  support: 'politicas, entrega, troca, devolucao, horario, duvidas gerais, reclamacoes e casos sem classificacao clara',
  billing: 'pedido, pagamento, cobranca, comprovante, rastreio e status transacional',
  scheduling: 'agenda, horario marcado, retirada, disponibilidade operacional e encaixe',
  handoff: 'pedido explicito de atendente humano'
};

function getDepartmentRoutingMap() {
  return Object.fromEntries(Object.entries(departmentAgents).map(([id, agent]) => [
    id,
    {
      id,
      label: agent.label,
      intents: [...agent.intents],
      triggerSummary: departmentRoutingDescriptions[id] || agent.intents.join(', ')
    }
  ]));
}

function selectDepartmentAgent(route = {}, config = {}) {
  const intent = route.intent || 'unknown';
  const initial = Object.values(departmentAgents).find(agent => agent.intents.includes(intent)) || departmentAgents.support;
  const initialSettings = getDepartmentSettings(config, initial.id);
  const selected = initialSettings.enabled === false && initial.id !== 'support' ? departmentAgents.support : initial;
  const settings = selected.id === initial.id ? initialSettings : getDepartmentSettings(config, selected.id);
  return {
    ...selected,
    settings,
    buildRetrievalPlan: async (args) => applyDepartmentSettingsToPlan(await selected.buildRetrievalPlan(args), settings)
  };
}

module.exports = {
  departmentAgents,
  getDepartmentRoutingMap,
  selectDepartmentAgent
};
