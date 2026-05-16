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
      if (item.sourceType === 'conversation_memory') return true;
      if (route.intent === 'product' && item.sourceType === 'catalog') return true;
      if (route.intent === 'order_status' && item.sourceType === 'api') return true;
      if (item.metadata?.error) return true;
      return item.metadata?.overlap > 0 || item.score >= 0.45;
    })
    .sort((a, b) => b.score - a.score);

  const conflicts = detectConflicts(ranked);
  return {
    evidence: ranked,
    topEvidence: ranked.slice(0, 8),
    conflicts,
    sourcesUsed: evidenceBundle.sourcesUsed || [...new Set(ranked.map(item => item.sourceType))]
  };
}

function detectConflicts(evidence = []) {
  const content = evidence.map(item => normalize(item.content)).join('\n');
  const hasNo = /\b(nao|sem|indisponivel|nao existe)\b/.test(content);
  const hasYes = /\b(sim|aceita|existe|disponivel|fazemos|temos)\b/.test(content);
  if (hasNo && hasYes) {
    return [{ reason: 'evidencias podem apontar respostas diferentes', severity: 'medium' }];
  }
  return [];
}

module.exports = {
  rank,
  lexicalOverlap,
  detectConflicts
};
