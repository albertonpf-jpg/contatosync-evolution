const { normalizeDepartmentConfig } = require('./department-config');

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

function normalizeScopeSet(values) {
  const items = list(values).map(item => String(item || '').trim().toLowerCase()).filter(Boolean);
  return items.length > 0 ? new Set(items) : null;
}

function sourceUrlKey(value = '') {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function integrationScopeKey(integration = {}) {
  return String(integration.id || integration.integration_id || integration.integration_name || '').trim().toLowerCase();
}

function knowledgeFileScopeKey(file = {}) {
  return String(file.id || file.path || file.originalName || file.fileName || '').trim().toLowerCase();
}

function scopeConfigForDepartmentReadiness(config = {}, department = {}) {
  if (!department || typeof department !== 'object') return config;

  const integrationTypes = normalizeScopeSet(department.allowedIntegrationTypes);
  const integrationIds = normalizeScopeSet(department.allowedIntegrationIds);
  const sourceUrls = normalizeScopeSet(list(department.allowedSourceUrls).map(sourceUrlKey));
  const knowledgeFileIds = normalizeScopeSet(department.allowedKnowledgeFileIds);

  if (!integrationTypes && !integrationIds && !sourceUrls && !knowledgeFileIds) return config;

  const scoped = { ...config };

  if (Array.isArray(config.product_integrations) && (integrationTypes || integrationIds)) {
    scoped.product_integrations = config.product_integrations.filter(integration => {
      const type = String(integration.integration_type || integration.type || '').trim().toLowerCase();
      const id = integrationScopeKey(integration);
      return (!integrationTypes || integrationTypes.has(type))
        && (!integrationIds || integrationIds.has(id));
    });
  }

  if (sourceUrls) {
    const keepUrl = value => sourceUrls.has(sourceUrlKey(value));
    scoped.product_source_urls = Array.isArray(config.product_source_urls) ? config.product_source_urls.filter(keepUrl) : [];
    scoped.site_urls = Array.isArray(config.site_urls) ? config.site_urls.filter(keepUrl) : [];
    scoped.knowledge_source_urls = Array.isArray(config.knowledge_source_urls) ? config.knowledge_source_urls.filter(keepUrl) : [];
    scoped.source_urls = Array.isArray(config.source_urls) ? config.source_urls.filter(keepUrl) : [];
    if (config.product_catalog_url && !keepUrl(config.product_catalog_url)) scoped.product_catalog_url = '';
    if (config.site_url && !keepUrl(config.site_url)) scoped.site_url = '';
    if (config.store_url && !keepUrl(config.store_url)) scoped.store_url = '';
    if (config.knowledge_base_url && !keepUrl(config.knowledge_base_url)) scoped.knowledge_base_url = '';
  }

  if (Array.isArray(config.knowledge_files) && knowledgeFileIds) {
    scoped.knowledge_files = config.knowledge_files.filter(file => knowledgeFileIds.has(knowledgeFileScopeKey(file)));
  }

  return scoped;
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
    const departmentAvailability = buildSourceAvailability(scopeConfigForDepartmentReadiness(config, department));
    const issues = [];

    if (department.enabled !== false) sources.forEach((source, index) => {
      const normalizedSource = source === 'files' ? 'file' : source;
      const sourceAvailability = departmentAvailability[normalizedSource];
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
      availability: departmentAvailability,
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

module.exports = {
  buildAISourceReadiness,
  buildSourceAvailability
};
