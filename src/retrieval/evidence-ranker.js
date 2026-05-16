const PRIORITY = {
  api: 100,
  catalog: 90,
  policy: 80,
  file: 70,
  rag: 65,
  site: 60,
  faq: 55,
  conversation_memory: 30
};

function normalize(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function tokens(value = '') {
  return normalize(value)
    .split(/[^a-z0-9]+/i)
    .filter(token => token.length > 2);
}

function lexicalOverlap(question = '', content = '') {
  const q = new Set(tokens(question));
  if (q.size === 0) return 0;
  const c = new Set(tokens(content));
  let hits = 0;
  for (const token of q) {
    if (c.has(token)) hits += 1;
  }
  return hits / q.size;
}

function isConversationTranscript(content = '') {
  return /(^|\n)\s*(cliente|ia|assistente|atendente)\s*:/i.test(String(content || ''));
}

function hasPolicyTerm(question = '', content = '') {
  const q = normalize(question);
  const c = normalize(content);
  const policyGroups = [
    ['varejo', 'atacado', 'pedido minimo', 'compra minima', 'quantidade', 'unidade', 'venda', 'vende', 'vendem', 'vendemos'],
    ['pix', 'cartao', 'cartao', 'pagamento', 'pagar', 'pago', 'aceita', 'aceitamos'],
    ['frete', 'entrega', 'envio', 'retirada', 'retirar'],
    ['cnpj', 'cpf'],
    ['troca', 'devolucao', 'garantia'],
    ['horario', 'atendimento']
  ];
  return policyGroups.some(group => group.some(term => q.includes(term)) && group.some(term => c.includes(term)));
}

function isRelevantForRoute(item = {}, route = {}, question = '') {
  if (item.metadata?.error) return true;
  if (item.sourceType === 'conversation_memory') return false;
  if (isConversationTranscript(item.content)) return false;
  if (route.intent === 'product') return item.sourceType === 'catalog' || item.sourceType === 'rag';
  if (route.intent === 'order_status') return item.sourceType === 'api';
  if (['policy', 'faq', 'billing', 'scheduling', 'support'].includes(route.intent)) {
    if (/(catalog|api|product)/i.test(item.sourceType)) return false;
    return hasPolicyTerm(question, item.content) || item.metadata?.overlap >= 0.35 || item.score >= 0.7;
  }
  return true;
}

async function rank({ message = {}, route = {}, evidenceBundle = {} } = {}) {
  const question = message.text || '';
  const seen = new Set();
  const ranked = (evidenceBundle.evidence || [])
    .map(item => {
      const overlap = lexicalOverlap(question, item.content);
      const priority = PRIORITY[item.sourceType] || 10;
      const score = (Number(item.score || 0) * 0.45) + (overlap * 0.35) + (priority / 100 * 0.2);
      return { ...item, score, metadata: { ...(item.metadata || {}), overlap } };
    })
    .filter(item => {
      const key = `${item.sourceType}|${normalize(item.sourceName)}|${normalize(item.content).slice(0, 180)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      if (route.intent === 'product' && item.sourceType === 'catalog') return true;
      if (route.intent === 'order_status' && item.sourceType === 'api') return true;
      if (item.metadata?.error) return true;
      if (!isRelevantForRoute(item, route, question)) return false;
      return item.metadata?.overlap > 0 || item.score >= 0.45;
    })
    .sort((a, b) => b.score - a.score);

  const conflicts = detectConflicts(ranked, question, route);
  return {
    evidence: ranked,
    topEvidence: ranked.slice(0, 8),
    conflicts,
    sourcesUsed: evidenceBundle.sourcesUsed || [...new Set(ranked.map(item => item.sourceType))]
  };
}

function detectConflicts(evidence = [], question = '', route = {}) {
  if (['policy', 'faq', 'billing', 'scheduling', 'support'].includes(route.intent)) {
    return detectPolicyConflicts(evidence, question);
  }
  const content = evidence.map(item => normalize(item.content)).join('\n');
  const hasNo = /\b(nao|sem|indisponivel|nao existe)\b/.test(content);
  const hasYes = /\b(sim|aceita|existe|disponivel|fazemos|temos)\b/.test(content);
  if (hasNo && hasYes) {
    return [{ reason: 'evidencias podem apontar respostas diferentes', severity: 'medium' }];
  }
  return [];
}

function detectPolicyConflicts(evidence = [], question = '') {
  const q = normalize(question);
  const content = evidence.map(item => normalize(item.content)).join('\n');
  const checks = [];
  if (/\b(pix|pagamento|pagar|cartao)\b/.test(q)) {
    checks.push({
      yes: /\b(aceita|aceitamos|pagamento.*pix|pix|cartao)\b/,
      no: /\b(nao aceita pix|sem pix|nao trabalhamos com pix|nao.*cartao|sem cartao)\b/
    });
  }
  if (/\b(varejo|atacado|vende|vendem|venda)\b/.test(q)) {
    checks.push({
      yes: /\b(varejo|atacado|vendemos|vende|venda)\b/,
      no: /\b(nao.*varejo|nao.*atacado|somente atacado|apenas atacado|somente varejo|apenas varejo)\b/
    });
  }
  if (/\b(frete|entrega|envio|retirada)\b/.test(q)) {
    checks.push({
      yes: /\b(entrega|envio|frete|retirada|enviamos|retirar)\b/,
      no: /\b(nao.*entrega|nao.*envia|sem entrega|sem frete|nao.*retirada)\b/
    });
  }
  return checks.some(check => check.yes.test(content) && check.no.test(content))
    ? [{ reason: 'evidencias oficiais podem apontar respostas diferentes para a pergunta', severity: 'medium' }]
    : [];
}

module.exports = {
  rank,
  lexicalOverlap,
  detectConflicts,
  isRelevantForRoute,
  isConversationTranscript,
  hasPolicyTerm,
  detectPolicyConflicts
};
