const messageTypes = require('../types/message.types');
const lightweightRouter = require('../router/lightweight-router');
const sourceDecision = require('../router/source-decision');
const queryRewriter = require('../retrieval/query-rewriter');
const retrievalOrchestrator = require('../retrieval/retrieval-orchestrator');
const evidenceRanker = require('../retrieval/evidence-ranker');
const answerComposer = require('./answer-composer');
const confidenceGuardrail = require('./confidence-guardrail');
const humanHandoff = require('../handoff/human-handoff.service');
const { logAgentStep } = require('../utils/structured-logger');

async function normalize(rawMessage = {}) {
  return messageTypes.createNormalizedMessage({
    conversationId: rawMessage.conversationId || rawMessage.conversation?.id || '',
    clientId: rawMessage.clientId || rawMessage.client_id || '',
    customerPhone: rawMessage.customerPhone || rawMessage.contact?.phone || rawMessage.conversation?.phone || '',
    customerName: rawMessage.customerName || rawMessage.contact?.name || rawMessage.conversation?.contact_name || '',
    text: String(rawMessage.text || rawMessage.message || rawMessage.content || '').trim(),
    raw: rawMessage,
    media: rawMessage.media || null,
    conversation: rawMessage.conversation || null,
    contact: rawMessage.contact || null,
    conversationHistory: Array.isArray(rawMessage.conversationHistory) ? rawMessage.conversationHistory : [],
    createdAt: rawMessage.createdAt || new Date().toISOString()
  });
}

async function handleIncomingWhatsAppMessage(rawMessage = {}, options = {}) {
  const logger = options.logger || console;
  const adapters = options.adapters || {};
  const normalizedMessage = await normalize(rawMessage);

  logAgentStep({
    conversationId: normalizedMessage.conversationId,
    step: 'message_normalizer',
    inputSummary: normalizedMessage.text || '[sem texto]',
    outputSummary: normalizedMessage.customerPhone,
    confidence: 1,
    sourcesUsed: [],
    decision: 'mensagem normalizada'
  }, logger);

  const route = await lightweightRouter.route(normalizedMessage);
  logAgentStep({
    conversationId: normalizedMessage.conversationId,
    step: 'lightweight_router',
    inputSummary: normalizedMessage.text,
    outputSummary: JSON.stringify(route),
    confidence: route.confidence,
    sourcesUsed: route.requiredSources,
    decision: route.reason
  }, logger);

  if (route.intent === 'human_request' && route.explicitHumanRequest === true) {
    const handoff = humanHandoff.create({
      message: normalizedMessage,
      reason: 'cliente pediu explicitamente atendimento humano',
      route
    });
    logAgentStep({
      conversationId: normalizedMessage.conversationId,
      step: 'explicit_handoff',
      inputSummary: normalizedMessage.text,
      outputSummary: handoff.response,
      confidence: 1,
      sourcesUsed: ['conversation_memory'],
      decision: handoff.reason
    }, logger);
    return {
      action: 'handoff',
      response: handoff.response,
      handoff,
      route,
      product_cards: []
    };
  }

  const retrievalPlan = await sourceDecision.build({
    message: normalizedMessage,
    route
  });
  logAgentStep({
    conversationId: normalizedMessage.conversationId,
    step: 'source_decision',
    inputSummary: route.reason,
    outputSummary: retrievalPlan.executeSources.join(', '),
    confidence: route.confidence,
    sourcesUsed: retrievalPlan.executeSources,
    decision: retrievalPlan.reason
  }, logger);

  const rewrittenQuery = await queryRewriter.rewrite({
    message: normalizedMessage,
    route,
    retrievalPlan
  });

  logAgentStep({
    conversationId: normalizedMessage.conversationId,
    step: 'retrieval',
    inputSummary: rewrittenQuery,
    outputSummary: retrievalPlan.executeSources.join(', '),
    confidence: route.confidence,
    sourcesUsed: retrievalPlan.executeSources,
    decision: 'iniciando recuperacao de evidencias'
  }, logger);

  const evidenceBundle = await retrievalOrchestrator.retrieve({
    message: normalizedMessage,
    query: rewrittenQuery,
    route,
    retrievalPlan,
    adapters,
    logger
  });

  const rankedEvidence = await evidenceRanker.rank({
    message: normalizedMessage,
    route,
    evidenceBundle
  });
  logAgentStep({
    conversationId: normalizedMessage.conversationId,
    step: 'ranker',
    inputSummary: `${evidenceBundle.evidence.length} evidencias`,
    outputSummary: `${rankedEvidence.topEvidence.length} evidencias priorizadas`,
    confidence: rankedEvidence.topEvidence[0]?.score || 0,
    sourcesUsed: rankedEvidence.sourcesUsed,
    decision: rankedEvidence.conflicts.length ? 'conflito detectado' : 'evidencias ranqueadas'
  }, logger);

  const draftAnswer = await answerComposer.compose({
    message: normalizedMessage,
    route,
    evidence: rankedEvidence
  });
  logAgentStep({
    conversationId: normalizedMessage.conversationId,
    step: 'composer',
    inputSummary: `${rankedEvidence.topEvidence.length} evidencias`,
    outputSummary: draftAnswer.text || draftAnswer.missingInfo || '',
    confidence: draftAnswer.confidence === 'high' ? 1 : (draftAnswer.confidence === 'medium' ? 0.6 : 0.2),
    sourcesUsed: rankedEvidence.sourcesUsed,
    decision: 'rascunho composto somente apos evidencias'
  }, logger);

  const validation = await confidenceGuardrail.validate({
    message: normalizedMessage,
    route,
    evidence: rankedEvidence,
    draftAnswer
  });
  logAgentStep({
    conversationId: normalizedMessage.conversationId,
    step: 'guardrail',
    inputSummary: draftAnswer.text || '',
    outputSummary: validation.finalAnswer || validation.clarificationQuestion || validation.discoveryQuestion || '',
    confidence: validation.confidence === 'high' ? 1 : (validation.confidence === 'medium' ? 0.6 : 0.2),
    sourcesUsed: rankedEvidence.sourcesUsed,
    decision: validation.reason
  }, logger);

  if (validation.action === 'send') {
    return {
      action: 'send',
      response: validation.finalAnswer,
      route,
      retrievalPlan,
      evidence: rankedEvidence,
      validation,
      product_cards: validation.product_cards || draftAnswer.product_cards || []
    };
  }

  if (validation.action === 'clarify') {
    logAgentStep({
      conversationId: normalizedMessage.conversationId,
      step: 'clarification',
      inputSummary: normalizedMessage.text,
      outputSummary: validation.clarificationQuestion,
      confidence: 0.5,
      sourcesUsed: rankedEvidence.sourcesUsed,
      decision: validation.reason
    }, logger);
    return {
      action: 'clarify',
      response: validation.clarificationQuestion,
      route,
      retrievalPlan,
      evidence: rankedEvidence,
      validation,
      product_cards: []
    };
  }

  if (validation.action === 'continue_discovery') {
    logAgentStep({
      conversationId: normalizedMessage.conversationId,
      step: 'discovery',
      inputSummary: normalizedMessage.text,
      outputSummary: validation.discoveryQuestion,
      confidence: 0.4,
      sourcesUsed: rankedEvidence.sourcesUsed,
      decision: validation.reason
    }, logger);
    return {
      action: 'continue_discovery',
      response: validation.discoveryQuestion,
      route,
      retrievalPlan,
      evidence: rankedEvidence,
      validation,
      product_cards: []
    };
  }

  if (validation.action === 'handoff' && route.explicitHumanRequest === true) {
    const handoff = humanHandoff.create({
      message: normalizedMessage,
      route,
      evidence: rankedEvidence,
      draftAnswer,
      reason: 'cliente pediu explicitamente atendimento humano'
    });
    return {
      action: 'handoff',
      response: handoff.response,
      route,
      handoff,
      product_cards: []
    };
  }

  return {
    action: 'continue_discovery',
    response: 'Me passa mais um detalhe para eu conseguir te ajudar melhor?',
    route,
    retrievalPlan,
    evidence: rankedEvidence,
    validation,
    product_cards: []
  };
}

module.exports = {
  normalize,
  handleIncomingWhatsAppMessage
};
