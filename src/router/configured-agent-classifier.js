const { normalizeDepartmentConfig } = require('../agent/department-config');

const STOPWORDS = new Set([
  'a', 'o', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das',
  'e', 'ou', 'para', 'pra', 'por', 'com', 'sem', 'em', 'no', 'na', 'nos', 'nas',
  'eu', 'me', 'meu', 'minha', 'voce', 'voces', 'vc', 'quero', 'queria', 'preciso',
  'pode', 'posso', 'tem', 'sobre', 'saber', 'ver', 'alguma', 'algum'
]);

function normalize(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value = '') {
  return normalize(value)
    .split(' ')
    .filter(token => token.length >= 3 && !STOPWORDS.has(token));
}

function tokenSet(value = '') {
  return new Set(tokenize(value));
}

function overlapScore(messageTokens, profileTokens) {
  if (!messageTokens.size || !profileTokens.size) return 0;
  let hits = 0;
  for (const token of messageTokens) {
    if (profileTokens.has(token)) hits += 1;
  }
  return hits / Math.max(3, messageTokens.size);
}

function phraseScore(message = '', profileText = '') {
  const messageText = normalize(message);
  const profile = normalize(profileText);
  if (!messageText || !profile) return 0;
  const messageTerms = tokenize(messageText);
  let hits = 0;
  for (const term of messageTerms) {
    if (profile.includes(term)) hits += 1;
  }
  return hits / Math.max(4, messageTerms.length);
}

function getDepartmentProfileText(id, department = {}) {
  return [
    id,
    department.name,
    department.objective,
    department.semanticDescription,
    ...(department.activationExamples || []),
    ...(department.intents || []),
    ...(department.sourceUseRules || []),
    ...(department.responseRules || [])
  ].filter(Boolean).join(' ');
}

function getDepartmentExclusionText(department = {}) {
  return [
    ...(department.boundaryRules || []),
    ...(department.exclusionExamples || [])
  ].filter(Boolean).join(' ');
}

function chooseIntentForDepartment(department = {}, fallbackIntent = 'unknown') {
  const intents = Array.isArray(department.intents) ? department.intents.filter(Boolean) : [];
  if (intents.includes(fallbackIntent)) return fallbackIntent;
  return intents.find(intent => intent !== 'unknown') || fallbackIntent || 'unknown';
}

function classifyByConfiguredAgents({ text = '', config = {}, fallbackIntent = 'unknown' } = {}) {
  const messageTokens = tokenSet(text);
  if (!messageTokens.size) {
    return {
      intent: 'unknown',
      departmentId: 'support',
      confidence: 0.3,
      reason: 'Mensagem sem conteudo suficiente para comparar com os agentes configurados.',
      ambiguity: 'mensagem_vazia',
      scores: []
    };
  }

  const departments = normalizeDepartmentConfig(config);
  const scores = Object.entries(departments)
    .filter(([, department]) => department.enabled !== false)
    .map(([id, department]) => {
      const profile = getDepartmentProfileText(id, department);
      const profileTokens = tokenSet(profile);
      const exclusionText = getDepartmentExclusionText(department);
      const exclusionTokens = tokenSet(exclusionText);
      const positiveScore = (overlapScore(messageTokens, profileTokens) * 0.7) + (phraseScore(text, profile) * 0.3);
      const exclusionScore = (overlapScore(messageTokens, exclusionTokens) * 0.75) + (phraseScore(text, exclusionText) * 0.25);
      const score = Math.max(0, positiveScore - (exclusionScore * 0.9));
      return {
        id,
        intent: chooseIntentForDepartment(department, fallbackIntent),
        score,
        exclusionScore,
        name: department.name || id
      };
    })
    .sort((a, b) => b.score - a.score);

  const top = scores[0] || { id: 'support', intent: 'unknown', score: 0 };
  const second = scores[1] || { id: '', score: 0 };
  const minScore = Number(config.configured_intent_min_score || 0.18);
  const minMargin = Number(config.configured_intent_min_margin || 0.08);
  const margin = top.score - second.score;

  if (top.score < minScore) {
    return {
      intent: 'unknown',
      departmentId: 'support',
      confidence: Math.max(0.42, Math.min(0.54, top.score + 0.35)),
      reason: 'Nenhum agente configurado teve similaridade suficiente com a mensagem.',
      ambiguity: 'sem_agente_confiavel',
      nextBestDepartments: scores.slice(0, 3).map(item => item.id),
      scores
    };
  }

  if (second.id && margin < minMargin) {
    return {
      intent: 'unknown',
      departmentId: 'support',
      confidence: Math.max(0.45, Math.min(0.58, top.score + 0.35)),
      reason: `Mensagem ficou ambigua entre ${top.name} e ${second.name}.`,
      ambiguity: `ambigua_entre_${top.id}_e_${second.id}`,
      nextBestDepartments: scores.slice(0, 3).map(item => item.id),
      scores
    };
  }

  return {
    intent: top.intent,
    departmentId: top.id,
    confidence: Math.max(0.56, Math.min(0.86, top.score + 0.45)),
    reason: `Mensagem combinou melhor com o agente configurado ${top.name}.`,
    ambiguity: '',
    nextBestDepartments: scores.slice(1, 4).map(item => item.id),
    scores
  };
}

module.exports = {
  classifyByConfiguredAgents,
  normalize,
  tokenize
};
