const lightweightRouter = require('../router/lightweight-router');
const { selectDepartmentAgent } = require('../agent/departments');
const { normalizeDepartmentConfig } = require('../agent/department-config');

const DEFAULT_ROUTE_DIAGNOSTIC_SCENARIOS = [
  {
    id: 'product-interest',
    label: 'Interesse em produto sem palavra-chave exata',
    message: 'Tem alguma opcao bonita para presente de menina de 2 anos?',
    expectedIntents: ['product'],
    expectedDepartments: ['sales'],
    requiredSources: ['catalog'],
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
    expectHandoff: false,
    minConfidence: 0.55
  },
  {
    id: 'payment-status',
    label: 'Pagamento e liberacao de pedido',
    message: 'Ja enviei o comprovante, meu pedido foi liberado?',
    expectedIntents: ['billing', 'order_status'],
    expectedDepartments: ['billing'],
    requiredSources: ['api'],
    expectHandoff: false,
    minConfidence: 0.55
  },
  {
    id: 'pickup-scheduling',
    label: 'Agendamento de retirada',
    message: 'Consigo marcar para retirar amanha as 15h?',
    expectedIntents: ['scheduling'],
    expectedDepartments: ['scheduling'],
    requiredSources: ['api'],
    expectHandoff: false,
    minConfidence: 0.55
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

function hasText(value) {
  return String(value || '').trim().length > 0;
}

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function normalizeIntegrations(config = {}) {
  return list(config.product_integrations).filter(integration =>
    integration
    && integration.enabled !== false
    && hasText(integration.api_endpoint)
  );
}

function buildSourceAvailability(config = {}) {
  const integrations = normalizeIntegrations(config);
  const knowledgeFiles = list(config.knowledge_files).filter(file =>
    file && (hasText(file.extractedText) || hasText(file.path) || hasText(file.originalName) || hasText(file.fileName))
  );
  const productUrls = [
    config.product_catalog_url,
    ...list(config.product_source_urls)
  ].filter(hasText);
  const siteUrls = [
    config.site_url,
    config.store_url,
    config.knowledge_base_url,
    ...list(config.site_urls),
    ...list(config.knowledge_source_urls),
    ...list(config.source_urls)
  ].filter(hasText);
  const hasPolicyText = hasText(config.system_prompt) || hasText(config.greeting_message) || hasText(config.fallback_message);

  return {
    api: {
      ready: integrations.length > 0,
      count: integrations.length,
      detail: integrations.length ? `${integrations.length} integracao(oes) operacional(is)` : 'nenhuma integracao operacional configurada'
    },
    catalog: {
      ready: productUrls.length > 0 || integrations.length > 0,
      count: productUrls.length + integrations.length,
      detail: productUrls.length || integrations.length ? 'catalogo/URL/API de produto configurado' : 'sem catalogo, URL de produto ou API de produto'
    },
    file: {
      ready: knowledgeFiles.length > 0 || hasPolicyText,
      count: knowledgeFiles.length,
      detail: knowledgeFiles.length ? `${knowledgeFiles.length} arquivo(s) de conhecimento` : (hasPolicyText ? 'texto configurado pode servir como fonte estatica' : 'sem arquivos de conhecimento')
    },
    site: {
      ready: siteUrls.length > 0,
      count: siteUrls.length,
      detail: siteUrls.length ? `${siteUrls.length} URL(s) configurada(s)` : 'sem URLs/site configurados'
    },
    rag: {
      ready: knowledgeFiles.length > 0 || siteUrls.length > 0 || hasPolicyText,
      count: knowledgeFiles.length + siteUrls.length + (hasPolicyText ? 1 : 0),
      detail: knowledgeFiles.length || siteUrls.length || hasPolicyText ? 'ha fontes estaticas para fundamentacao' : 'sem fonte estatica visivel para fundamentacao'
    },
    conversation_memory: {
      ready: true,
      count: 1,
      detail: 'memoria da conversa sempre disponivel no fluxo'
    }
  };
}

function buildAISourceReadiness(config = {}) {
  const availability = buildSourceAvailability(config);
  const departments = normalizeDepartmentConfig(config);
  const departmentsReadiness = {};
  const allIssues = [];

  for (const [id, department] of Object.entries(departments)) {
    const priority = list(department.sourcePriority);
    const allowed = list(department.allowedSources);
    const sources = priority.length ? priority : allowed;
    const issues = [];

    if (department.enabled !== false) sources.forEach((source, index) => {
      const normalizedSource = source === 'files' ? 'file' : source;
      const sourceAvailability = availability[normalizedSource];
      if (!sourceAvailability || sourceAvailability.ready) return;
      const severity = index === 0 && ['api', 'catalog', 'file', 'site', 'rag'].includes(normalizedSource)
        ? 'error'
        : 'warning';
      issues.push({
        severity,
        source: normalizedSource,
        message: `${department.name || id}: fonte ${normalizedSource} esta priorizada, mas ${sourceAvailability.detail}.`
      });
    });

    departmentsReadiness[id] = {
      id,
      name: department.name || id,
      enabled: department.enabled !== false,
      sources,
      issues
    };
    allIssues.push(...issues.map(issue => ({ ...issue, departmentId: id })));
  }

  return {
    availability,
    departments: departmentsReadiness,
    issues: allIssues,
    summary: {
      errors: allIssues.filter(issue => issue.severity === 'error').length,
      warnings: allIssues.filter(issue => issue.severity === 'warning').length
    }
  };
}

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
    safety: {
      willHandoff: route.explicitHumanRequest === true,
      willUseSemanticClassifier: route.routerMode === 'semantic',
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
      requiredSources: Array.isArray(item.requiredSources) ? item.requiredSources.map(String).filter(Boolean) : [],
      forbiddenSources: Array.isArray(item.forbiddenSources) ? item.forbiddenSources.map(String).filter(Boolean) : [],
      expectHandoff: typeof item.expectHandoff === 'boolean' ? item.expectHandoff : undefined,
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
