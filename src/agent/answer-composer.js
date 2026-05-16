function firstUsefulEvidence(evidence = [], preferred = []) {
  const byPreferred = evidence.find(item => preferred.includes(item.sourceType) && String(item.content || '').trim());
  return byPreferred || evidence.find(item => String(item.content || '').trim());
}

function cleanEvidenceText(text = '') {
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^(Fonte|Nome da fonte|Titulo da pagina|Produto\/link)\b/i.test(line))
    .slice(0, 6)
    .join('\n')
    .replace(/^Informacoes (gerais|coletadas|operacionais).*?:\s*/i, '')
    .trim();
}

function getCatalogCards(evidence = []) {
  const cards = [];
  for (const item of evidence) {
    if (Array.isArray(item.metadata?.productCards)) cards.push(...item.metadata.productCards);
  }
  return cards;
}

async function compose({ message = {}, route = {}, evidence = {} } = {}) {
  const ranked = evidence.topEvidence || evidence.evidence || [];
  const productCards = getCatalogCards(ranked);

  if (route.explicitHumanRequest) {
    return {
      text: 'Certo, vou te encaminhar para um atendente.',
      confidence: 'high',
      grounded: true,
      product_cards: []
    };
  }

  if (route.intent === 'product') {
    const catalogEvidence = ranked.find(item => item.sourceType === 'catalog') || firstUsefulEvidence(ranked, ['catalog']);
    if (productCards.length > 0) {
      return {
        text: 'Encontrei essas opcoes no catalogo. Enviei as fotos acima; posso verificar tamanho, cor ou disponibilidade desse produto.',
        confidence: 'high',
        grounded: true,
        product_cards: productCards
      };
    }
    if (catalogEvidence?.metadata?.lookupAttempted && catalogEvidence?.metadata?.productsFound === false) {
      return {
        text: 'Nao encontrei com esses detalhes. Voce quer procurar por outro tamanho, cor ou modelo?',
        confidence: 'medium',
        grounded: true,
        product_cards: []
      };
    }
    return {
      text: '',
      confidence: 'low',
      grounded: false,
      missingInfo: 'product',
      product_cards: []
    };
  }

  if (route.intent === 'order_status') {
    const apiEvidence = firstUsefulEvidence(ranked, ['api']);
    if (apiEvidence && !apiEvidence.metadata?.error) {
      const text = cleanEvidenceText(apiEvidence.content);
      return {
        text: text || 'Encontrei dados do pedido na integracao configurada.',
        confidence: 'high',
        grounded: true,
        product_cards: []
      };
    }
    if (apiEvidence?.metadata?.error) {
      return {
        text: 'Nao consegui consultar o pedido neste momento. Me envia o numero do pedido para eu tentar verificar com mais precisao?',
        confidence: 'low',
        grounded: false,
        missingInfo: 'order_number',
        product_cards: []
      };
    }
    return {
      text: '',
      confidence: 'low',
      grounded: false,
      missingInfo: 'order_number',
      product_cards: []
    };
  }

  const groundedEvidence = firstUsefulEvidence(ranked, ['rag', 'file', 'site', 'api', 'catalog']);
  if (!groundedEvidence) {
    return {
      text: '',
      confidence: 'low',
      grounded: false,
      missingInfo: inferMissingInfo(message, route),
      product_cards: []
    };
  }

  const text = cleanEvidenceText(groundedEvidence.content);
  return {
    text: text || 'Encontrei essa informacao nas fontes configuradas.',
    confidence: groundedEvidence.score >= 0.65 ? 'high' : 'medium',
    grounded: Boolean(text),
    product_cards: []
  };
}

function inferMissingInfo(message = {}, route = {}) {
  const text = String(message.text || '');
  if (route.intent === 'product') return 'product';
  if (route.intent === 'order_status') return 'order_number';
  if (/\b(varejo|atacado|quantidade|unidade)\b/i.test(text)) return 'purchase_mode';
  if (/\bcidade\b|minha cidade|isso vale/i.test(text)) return 'city';
  return 'details';
}

module.exports = {
  compose,
  cleanEvidenceText,
  getCatalogCards
};
