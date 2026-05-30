function questionForMissingInfo(missingInfo = 'details', route = {}) {
  if (missingInfo === 'route_ambiguity') return 'Voce quer falar sobre produto, pedido, pagamento, agendamento ou uma duvida geral?';
  if (missingInfo === 'intent') return 'Voce quer falar sobre produto, pedido, pagamento, agendamento ou uma duvida geral?';
  if (missingInfo === 'order_number') return 'Me envia o numero do pedido para eu verificar pra voce?';
  if (missingInfo === 'product') return 'Para eu te responder certinho, voce esta falando de qual produto?';
  if (missingInfo === 'purchase_mode') return 'Voce quer saber sobre compra para uso proprio ou compra em quantidade?';
  if (missingInfo === 'city') return 'Qual e a sua cidade? Assim eu verifico essa informacao com mais precisao.';
  if (route.intent === 'product') return 'Voce quer procurar por outro tamanho, cor ou modelo?';
  return 'Me passa mais um detalhe para eu conseguir te ajudar melhor?';
}

async function validate({ message = {}, route = {}, evidence = {}, draftAnswer = {} } = {}) {
  if (route.explicitHumanRequest === true) {
    return {
      action: 'handoff',
      confidence: 'high',
      finalAnswer: 'Certo, vou te encaminhar para um atendente.',
      clarificationQuestion: '',
      discoveryQuestion: '',
      reason: 'cliente pediu explicitamente atendimento humano'
    };
  }

  const config = message.effectiveConfig || message.config || {};
  const strictSemanticIntent = config.semantic_intent_enabled !== false
    && config.require_semantic_intent_classifier === true;
  const semanticSkipped = Boolean(route.semanticSkippedReason);
  const answeredByLocalFallback = String(route.routerMode || '').includes('semantic_skipped')
    || String(route.routerMode || '').includes('semantic_error');
  if (strictSemanticIntent && semanticSkipped && answeredByLocalFallback) {
    return {
      action: 'clarify',
      confidence: 'low',
      finalAnswer: '',
      clarificationQuestion: questionForMissingInfo('route_ambiguity', route),
      discoveryQuestion: '',
      reason: `classificador semantico obrigatorio indisponivel: ${route.semanticSkippedReason}`
    };
  }

  if (route.needsHuman === true && route.explicitHumanRequest !== true) {
    return {
      action: 'clarify',
      confidence: 'low',
      finalAnswer: '',
      clarificationQuestion: questionForMissingInfo(draftAnswer.missingInfo, route),
      discoveryQuestion: '',
      reason: 'needsHuman bloqueado porque nao houve pedido explicito de humano'
    };
  }

  const routeAmbiguity = route.routingConflict === true
    || String(route.routerMode || '').startsWith('clarify_');
  if (routeAmbiguity) {
    const semanticMissingInfo = Array.isArray(route.semantic?.missingInfo) && route.semantic.missingInfo.length
      ? route.semantic.missingInfo[0]
      : '';
    const missingInfo = draftAnswer.missingInfo || semanticMissingInfo || 'route_ambiguity';
    return {
      action: 'clarify',
      confidence: 'low',
      finalAnswer: '',
      clarificationQuestion: questionForMissingInfo(missingInfo, route),
      discoveryQuestion: '',
      reason: 'roteamento ambiguo entre agentes; pedir esclarecimento antes de responder'
    };
  }

  const criticalSourceIssues = (evidence.sourceReadiness?.issues || []).filter(issue => issue.severity === 'error');
  if (criticalSourceIssues.length > 0) {
    const missingInfo = route.intent === 'order_status' || route.intent === 'billing'
      ? 'order_number'
      : draftAnswer.missingInfo;
    return {
      action: 'clarify',
      confidence: 'low',
      finalAnswer: '',
      clarificationQuestion: questionForMissingInfo(missingInfo, route),
      discoveryQuestion: '',
      reason: `fonte critica do agente indisponivel: ${criticalSourceIssues.map(issue => issue.source).join(', ')}`
    };
  }

  if (Array.isArray(evidence.conflicts) && evidence.conflicts.length > 0 && draftAnswer.confidence !== 'high') {
    return {
      action: 'clarify',
      confidence: 'low',
      finalAnswer: '',
      clarificationQuestion: 'Voce quer saber sobre qual situacao exatamente? Assim eu verifico sem misturar informacoes.',
      discoveryQuestion: '',
      reason: 'evidencia conflitante sem criterio seguro de desempate'
    };
  }

  if (draftAnswer.grounded && String(draftAnswer.text || '').trim()) {
    return {
      action: 'send',
      confidence: draftAnswer.confidence || 'medium',
      finalAnswer: draftAnswer.text,
      product_cards: draftAnswer.product_cards || [],
      clarificationQuestion: '',
      discoveryQuestion: '',
      reason: 'resposta sustentada por evidencias recuperadas'
    };
  }

  const question = questionForMissingInfo(draftAnswer.missingInfo, route);
  const action = draftAnswer.missingInfo ? 'clarify' : 'continue_discovery';
  return {
    action,
    confidence: 'low',
    finalAnswer: '',
    clarificationQuestion: action === 'clarify' ? question : '',
    discoveryQuestion: action === 'continue_discovery' ? question : '',
    reason: 'evidencia insuficiente; continuar investigando sem handoff automatico'
  };
}

module.exports = {
  validate,
  questionForMissingInfo
};
