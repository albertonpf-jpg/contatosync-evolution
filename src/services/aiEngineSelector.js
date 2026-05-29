const LOCAL_MULTI_AGENT_ENGINE = 'local_multi_agent';
const DIFY_ENGINE = 'dify';
const HYBRID_ENGINE = 'hybrid';

const ENGINE_ALIASES = {
  local: LOCAL_MULTI_AGENT_ENGINE,
  grounded: LOCAL_MULTI_AGENT_ENGINE,
  grounded_agent: LOCAL_MULTI_AGENT_ENGINE,
  retrieval_grounded: LOCAL_MULTI_AGENT_ENGINE,
  multi_agent: LOCAL_MULTI_AGENT_ENGINE,
  multiagent: LOCAL_MULTI_AGENT_ENGINE,
  local_multi_agent: LOCAL_MULTI_AGENT_ENGINE,
  dify: DIFY_ENGINE,
  hybrid: HYBRID_ENGINE
};

function normalizeAIEngine(value = '') {
  const key = String(value || '').trim().toLowerCase();
  return ENGINE_ALIASES[key] || '';
}

function getConfiguredEngine(config = {}) {
  return normalizeAIEngine(
    config.ai_engine
    || config.agent_engine
    || config.engine
    || process.env.AI_ENGINE
    || process.env.AI_AGENT_ENGINE
    || ''
  );
}

function resolveAIEngine({ config = {}, difyConfig = {} } = {}) {
  const configured = getConfiguredEngine(config);
  const difyIsProvisioned = Boolean(difyConfig.enabled && difyConfig.endpoint && difyConfig.apiKey);

  if (configured === LOCAL_MULTI_AGENT_ENGINE) {
    return {
      engine: LOCAL_MULTI_AGENT_ENGINE,
      useDify: false,
      allowLocalFallback: true,
      reason: 'cliente configurado internamente para multiagente local'
    };
  }

  if (configured === HYBRID_ENGINE) {
    return {
      engine: HYBRID_ENGINE,
      useDify: difyIsProvisioned,
      allowLocalFallback: true,
      reason: difyIsProvisioned
        ? 'cliente configurado internamente para modo hibrido com Dify provisionado'
        : 'cliente configurado internamente para modo hibrido sem Dify provisionado'
    };
  }

  if (configured === DIFY_ENGINE) {
    return {
      engine: DIFY_ENGINE,
      useDify: true,
      allowLocalFallback: difyConfig.failoverToLocal !== false,
      reason: 'cliente configurado internamente para Dify'
    };
  }

  if (difyConfig.enabled) {
    return {
      engine: DIFY_ENGINE,
      useDify: true,
      allowLocalFallback: difyConfig.failoverToLocal !== false,
      reason: 'compatibilidade: configuracao Dify existente continua ativa'
    };
  }

  return {
    engine: LOCAL_MULTI_AGENT_ENGINE,
    useDify: false,
    allowLocalFallback: true,
    reason: 'padrao interno do ContatoSync'
  };
}

module.exports = {
  LOCAL_MULTI_AGENT_ENGINE,
  DIFY_ENGINE,
  HYBRID_ENGINE,
  normalizeAIEngine,
  resolveAIEngine
};
