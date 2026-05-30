const lightweightRouter = require('../router/lightweight-router');
const { selectDepartmentAgent } = require('../agent/departments');
const { buildAISourceReadiness, buildSourceAvailability } = require('../agent/source-readiness');
const { buildSemanticIntentReadiness } = require('../router/semantic-intent-classifier');

const DEFAULT_ROUTE_DIAGNOSTIC_SCENARIOS = [
  {
    id: 'product-interest',
    label: 'Interesse em produto sem palavra-chave exata',
    message: 'Minha sobrinha vai fazer 2 anos e queria algo bonito para ela usar na festa.',
    expectedIntents: ['product'],
    expectedDepartments: ['sales'],
    requiredSources: ['catalog'],
    expectSemantic: true,
    expectHandoff: false,
    minConfidence: 0.55
  },
  {
    id: 'store-policy',
    label: 'Politica de loja e duvida operacional',
    message: 'Se nao servir, consigo trocar depois da retirada?',
    expectedIntents: ['policy', 'faq', 'support'],
    expectedDepartments: ['support'],
    requiredSources: ['rag'],
    expectSemantic: true,
    expectHandoff: false,
    minConfidence: 0.55
  },
  {
    id: 'payment-status',
    label: 'Pagamento e liberacao de pedido',
    message: 'Ja enviei o comprovante, meu pedido foi liberado?',
    expectedIntents: ['billing', 'order_status'],
    expectedDepartments: ['billing'],
    forbiddenDepartments: ['sales', 'support', 'scheduling'],
    requiredSources: ['api'],
    expectSemantic: true,
    expectHandoff: false,
    minConfidence: 0.55
  },
  {
    id: 'product-vs-billing-boundary',
    label: 'Produto nao deve cair no financeiro',
    message: 'Tem vestido azul tamanho 4 para festa?',
    expectedIntents: ['product'],
    expectedDepartments: ['sales'],
    forbiddenDepartments: ['billing', 'scheduling', 'handoff'],
    requiredSources: ['catalog'],
    forbiddenSources: ['api'],
    expectSemantic: true,
    expectHandoff: false,
    minConfidence: 0.55
  },
  {
    id: 'pickup-scheduling',
    label: 'Agendamento de retirada',
    message: 'Consigo marcar para retirar amanha as 15h?',
    expectedIntents: ['scheduling'],
    expectedDepartments: ['scheduling'],
    forbiddenDepartments: ['sales', 'billing', 'handoff'],
    requiredSources: ['api'],
    expectSemantic: true,
    expectHandoff: false,
    minConfidence: 0.55
  },
  {
    id: 'ambiguous-without-keywords',
    label: 'Mensagem vaga nao deve escolher agente no chute',
    message: 'Oi, preciso resolver isso para hoje.',
    expectedIntents: ['unknown'],
    expectedDepartments: ['support'],
    forbiddenDepartments: ['sales', 'billing', 'scheduling', 'handoff'],
    expectClarification: true,
    expectHandoff: false,
    minConfidence: 0.25
  },
  {
    id: 'human-request',
    label: 'Pedido explicito de humano',
    message: 'Quero falar com uma pessoa do atendimento',
    expectedIntents: ['human_request'],
    expectedDepartments: ['handoff'],
    expectHandoff: true,
    minConfidence: 0.8
  }
];

async function buildAIRouteDiagnosis({ message = '', config = {}, client = {}, conversationHistory = [], contact = {}, conversation = {} } = {}) {
  const effectiveConfig = {
    ...config,
    _intentRuntimeContext: {
      openaiApiKey: client.openai_api_key,
      claudeApiKey: client.claude_api_key,
      ...(config._intentRuntimeContext || {})
    }
  };
  const normalizedMessage = {
    clientId: config.client_id || client.id || '',
    conversationId: conversation.id || '',
    customerPhone: contact.phone || conversation.phone || '',
    customerName: contact.name || conversation.contact_name || '',
    text: String(message || '').trim(),
    conversationHistory: Array.isArray(conversationHistory) ? conversationHistory : [],
    effectiveConfig
  };

  const route = await lightweightRouter.route(normalizedMessage);
  const departmentAgent = selectDepartmentAgent(route, effectiveConfig);
  const retrievalPlan = await departmentAgent.buildRetrievalPlan({
    message: normalizedMessage,
    route
  });

  const sourceReadiness = buildAISourceReadiness(effectiveConfig);
  const semanticReadiness = buildSemanticIntentReadiness(effectiveConfig, client);

  return {
    message: normalizedMessage.text,
    route: {
      intent: route.intent,
      confidence: route.confidence,
      reason: route.reason,
      routerMode: route.routerMode,
      fallbackIntent: route.fallbackIntent,
      inferredDepartmentId: route.inferredDepartmentId,
      semanticDepartmentId: route.semanticDepartmentId,
      configuredDepartmentId: route.configuredDepartmentId,
      routingConflict: route.routingConflict === true,
      semantic: route.semantic,
      configured: route.configured,
      semanticSkippedReason: route.semanticSkippedReason,
      explicitHumanRequest: route.explicitHumanRequest === true,
      requiredSources: route.requiredSources || []
    },
    department: {
      id: departmentAgent.id,
      name: departmentAgent.settings?.name || departmentAgent.label,
      enabled: departmentAgent.settings?.enabled !== false,
      objective: departmentAgent.settings?.objective || '',
      systemPrompt: departmentAgent.settings?.systemPrompt || '',
      model: departmentAgent.settings?.model || effectiveConfig.model || '',
      temperature: departmentAgent.settings?.temperature ?? effectiveConfig.temperature ?? null
    },
    retrievalPlan: {
      executeSources: retrievalPlan.executeSources || [],
      skippedSources: [...new Set(retrievalPlan.skippedSources || [])],
      sourcePriority: retrievalPlan.departmentSettings?.sourcePriority || [],
      maxEvidence: retrievalPlan.departmentSettings?.maxEvidence,
      reason: retrievalPlan.reason || ''
    },
    sourceBindings: {
      allowedSources: retrievalPlan.departmentSettings?.allowedSources || [],
      allowedIntegrationTypes: retrievalPlan.departmentSettings?.allowedIntegrationTypes || [],
      allowedIntegrationIds: retrievalPlan.departmentSettings?.allowedIntegrationIds || [],
      allowedSourceUrls: retrievalPlan.departmentSettings?.allowedSourceUrls || [],
      allowedKnowledgeFileIds: retrievalPlan.departmentSettings?.allowedKnowledgeFileIds || [],
      sourceUseRules: retrievalPlan.departmentSettings?.sourceUseRules || [],
      responseRules: retrievalPlan.departmentSettings?.responseRules || []
    },
    sourceReadiness: {
      department: sourceReadiness.departments[departmentAgent.id] || null,
      availability: sourceReadiness.availability,
      issues: (sourceReadiness.departments[departmentAgent.id]?.issues || [])
    },
    semanticReadiness,
    safety: {
      willHandoff: route.explicitHumanRequest === true,
      willUseSemanticClassifier: route.routerMode === 'semantic' && semanticReadiness.ready === true,
      needsClarificationLikely: route.intent === 'unknown'
        || Number(route.confidence || 0) < 0.55
        || route.routingConflict === true
        || Boolean(route.semantic?.ambiguity)
    }
  };
}

function normalizeScenarioList(scenarios) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    return DEFAULT_ROUTE_DIAGNOSTIC_SCENARIOS;
  }

  return scenarios
    .filter(item => item && typeof item === 'object')
    .map((item, index) => ({
      id: String(item.id || `scenario-${index + 1}`).trim(),
      label: String(item.label || item.name || `Cenario ${index + 1}`).trim(),
      message: String(item.message || '').trim(),
      expectedIntents: Array.isArray(item.expectedIntents) ? item.expectedIntents.map(String).filter(Boolean) : [],
      expectedDepartments: Array.isArray(item.expectedDepartments) ? item.expectedDepartments.map(String).filter(Boolean) : [],
      forbiddenDepartments: Array.isArray(item.forbiddenDepartments) ? item.forbiddenDepartments.map(String).filter(Boolean) : [],
      requiredSources: Array.isArray(item.requiredSources) ? item.requiredSources.map(String).filter(Boolean) : [],
      forbiddenSources: Array.isArray(item.forbiddenSources) ? item.forbiddenSources.map(String).filter(Boolean) : [],
      expectHandoff: typeof item.expectHandoff === 'boolean' ? item.expectHandoff : undefined,
      expectSemantic: typeof item.expectSemantic === 'boolean' ? item.expectSemantic : undefined,
      expectClarification: typeof item.expectClarification === 'boolean' ? item.expectClarification : undefined,
      minConfidence: Number.isFinite(Number(item.minConfidence)) ? Number(item.minConfidence) : undefined
    }))
    .filter(item => item.message);
}

function evaluateAIRouteScenario(diagnosis, scenario) {
  const checks = [];
  const executedSources = new Set(diagnosis.retrievalPlan?.executeSources || []);

  if (scenario.expectedIntents?.length) {
    checks.push({
      id: 'intent',
      passed: scenario.expectedIntents.includes(diagnosis.route?.intent),
      expected: scenario.expectedIntents,
      actual: diagnosis.route?.intent
    });
  }

  if (scenario.expectedDepartments?.length) {
    checks.push({
      id: 'department',
      passed: scenario.expectedDepartments.includes(diagnosis.department?.id),
      expected: scenario.expectedDepartments,
      actual: diagnosis.department?.id
    });
  }

  for (const department of scenario.forbiddenDepartments || []) {
    checks.push({
      id: `forbidden-department:${department}`,
      passed: diagnosis.department?.id !== department,
      expected: `diferente de ${department}`,
      actual: diagnosis.department?.id
    });
  }

  for (const source of scenario.requiredSources || []) {
    checks.push({
      id: `source:${source}`,
      passed: executedSources.has(source),
      expected: source,
      actual: Array.from(executedSources)
    });
  }

  for (const source of scenario.forbiddenSources || []) {
    checks.push({
      id: `forbidden-source:${source}`,
      passed: !executedSources.has(source),
      expected: `sem ${source}`,
      actual: Array.from(executedSources)
    });
  }

  if (typeof scenario.expectHandoff === 'boolean') {
    checks.push({
      id: 'handoff',
      passed: diagnosis.safety?.willHandoff === scenario.expectHandoff,
      expected: scenario.expectHandoff,
      actual: diagnosis.safety?.willHandoff === true
    });
  }

  if (typeof scenario.expectSemantic === 'boolean') {
    checks.push({
      id: 'semantic-router',
      passed: diagnosis.safety?.willUseSemanticClassifier === scenario.expectSemantic,
      expected: scenario.expectSemantic,
      actual: diagnosis.safety?.willUseSemanticClassifier === true
    });
  }

  if (typeof scenario.expectClarification === 'boolean') {
    checks.push({
      id: 'clarification',
      passed: diagnosis.safety?.needsClarificationLikely === scenario.expectClarification,
      expected: scenario.expectClarification,
      actual: diagnosis.safety?.needsClarificationLikely === true
    });
  }

  if (typeof scenario.minConfidence === 'number') {
    checks.push({
      id: 'confidence',
      passed: Number(diagnosis.route?.confidence || 0) >= scenario.minConfidence,
      expected: scenario.minConfidence,
      actual: Number(diagnosis.route?.confidence || 0)
    });
  }

  return {
    ...scenario,
    passed: checks.every(check => check.passed),
    checks,
    diagnosis
  };
}

async function runAIRouteDiagnosticsSuite({ scenarios, config = {}, client = {}, conversationHistory = [], contact = {}, conversation = {} } = {}) {
  const normalizedScenarios = normalizeScenarioList(scenarios);
  const results = [];

  for (const scenario of normalizedScenarios) {
    const diagnosis = await buildAIRouteDiagnosis({
      message: scenario.message,
      config,
      client,
      conversationHistory,
      contact,
      conversation
    });
    results.push(evaluateAIRouteScenario(diagnosis, scenario));
  }

  const passed = results.filter(result => result.passed).length;

  return {
    generatedAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed: results.length - passed,
    score: results.length ? Math.round((passed / results.length) * 100) : 0,
    results
  };
}

module.exports = {
  DEFAULT_ROUTE_DIAGNOSTIC_SCENARIOS,
  buildAIRouteDiagnosis,
  buildAISourceReadiness,
  buildSourceAvailability,
  evaluateAIRouteScenario,
  runAIRouteDiagnosticsSuite
};
