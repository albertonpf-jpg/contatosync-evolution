const sourceDecision = require('../../router/source-decision');

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

function selectDepartmentAgent(route = {}) {
  const intent = route.intent || 'unknown';
  return Object.values(departmentAgents).find(agent => agent.intents.includes(intent)) || departmentAgents.support;
}

module.exports = {
  departmentAgents,
  selectDepartmentAgent
};
