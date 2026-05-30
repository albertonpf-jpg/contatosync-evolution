const lightweightRouter = require('../router/lightweight-router');
const { selectDepartmentAgent } = require('../agent/departments');

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

  return {
    message: normalizedMessage.text,
    route: {
      intent: route.intent,
      confidence: route.confidence,
      reason: route.reason,
      routerMode: route.routerMode,
      fallbackIntent: route.fallbackIntent,
      semantic: route.semantic,
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
    safety: {
      willHandoff: route.explicitHumanRequest === true,
      willUseSemanticClassifier: route.routerMode === 'semantic',
      needsClarificationLikely: route.intent === 'unknown' || Number(route.confidence || 0) < 0.55
    }
  };
}

module.exports = {
  buildAIRouteDiagnosis
};
