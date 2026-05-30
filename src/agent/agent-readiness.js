const { normalizeDepartmentConfig } = require('./department-config');

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function hasText(value) {
  return String(value || '').trim().length > 0;
}

function pushIssue(issues, severity, code, message) {
  issues.push({ severity, code, message });
}

function buildDepartmentContractReadiness(id, department = {}) {
  const issues = [];

  if (department.enabled === false) {
    return {
      id,
      name: department.name || id,
      enabled: false,
      ready: true,
      score: 100,
      counts: {
        intents: list(department.intents).length,
        activationExamples: list(department.activationExamples).length,
        boundaryRules: list(department.boundaryRules).length,
        exclusionExamples: list(department.exclusionExamples).length,
        allowedSources: list(department.allowedSources).length,
        sourceUseRules: list(department.sourceUseRules).length,
        responseRules: list(department.responseRules).length
      },
      issues: [],
      summary: 'Agente inativo.'
    };
  }

  const activationExamples = list(department.activationExamples);
  const exclusionExamples = list(department.exclusionExamples);
  const boundaryRules = list(department.boundaryRules);
  const allowedSources = list(department.allowedSources);
  const sourceUseRules = list(department.sourceUseRules);
  const responseRules = list(department.responseRules);
  const intents = list(department.intents);

  if (!hasText(department.semanticDescription)) {
    pushIssue(issues, 'error', 'missing_semantic_description', 'Defina quando este agente deve ser acionado em linguagem natural.');
  }
  if (!intents.length) {
    pushIssue(issues, 'error', 'missing_intents', 'Ligue pelo menos uma intencao a este agente.');
  }
  if (activationExamples.length < 3) {
    pushIssue(issues, 'warning', 'few_activation_examples', 'Inclua pelo menos 3 exemplos reais de mensagens deste setor.');
  }
  if (exclusionExamples.length < 2) {
    pushIssue(issues, 'warning', 'few_exclusion_examples', 'Inclua exemplos parecidos que pertencem a outros setores para evitar confusao.');
  }
  if (boundaryRules.length < 2) {
    pushIssue(issues, 'warning', 'few_boundary_rules', 'Inclua limites claros sobre o que este agente nao deve resolver.');
  }
  if (!hasText(department.systemPrompt)) {
    pushIssue(issues, 'error', 'missing_system_prompt', 'Defina o prompt system separado deste agente.');
  }
  if (!allowedSources.length) {
    pushIssue(issues, 'error', 'missing_allowed_sources', 'Escolha quais fontes este agente pode consultar.');
  }
  if (!sourceUseRules.length) {
    pushIssue(issues, 'warning', 'missing_source_use_rules', 'Explique quando este agente deve usar API, URLs, arquivos, catalogo ou memoria.');
  }
  if (!responseRules.length) {
    pushIssue(issues, 'warning', 'missing_response_rules', 'Defina regras de resposta para evitar invencao e mistura entre setores.');
  }

  const errors = issues.filter(issue => issue.severity === 'error').length;
  const warnings = issues.filter(issue => issue.severity === 'warning').length;
  const score = Math.max(0, 100 - (errors * 25) - (warnings * 8));

  return {
    id,
    name: department.name || id,
    enabled: true,
    ready: errors === 0,
    score,
    counts: {
      intents: intents.length,
      activationExamples: activationExamples.length,
      boundaryRules: boundaryRules.length,
      exclusionExamples: exclusionExamples.length,
      allowedSources: allowedSources.length,
      sourceUseRules: sourceUseRules.length,
      responseRules: responseRules.length
    },
    issues,
    summary: errors
      ? `${errors} erro(s) bloqueiam o contrato semantico deste agente.`
      : (warnings ? `${warnings} alerta(s) para melhorar a separacao semantica.` : 'Contrato semantico completo para roteamento por intencao.')
  };
}

function buildAIAgentReadiness(config = {}) {
  const departments = normalizeDepartmentConfig(config);
  const departmentReadiness = {};
  const allIssues = [];

  for (const [id, department] of Object.entries(departments)) {
    const readiness = buildDepartmentContractReadiness(id, department);
    departmentReadiness[id] = readiness;
    allIssues.push(...readiness.issues.map(issue => ({
      ...issue,
      departmentId: id,
      departmentName: readiness.name
    })));
  }

  const errors = allIssues.filter(issue => issue.severity === 'error').length;
  const warnings = allIssues.filter(issue => issue.severity === 'warning').length;
  const enabledDepartments = Object.values(departmentReadiness).filter(item => item.enabled);
  const averageScore = enabledDepartments.length
    ? Math.round(enabledDepartments.reduce((sum, item) => sum + item.score, 0) / enabledDepartments.length)
    : 100;

  return {
    ready: errors === 0,
    score: averageScore,
    departments: departmentReadiness,
    issues: allIssues,
    summary: {
      errors,
      warnings,
      enabledDepartments: enabledDepartments.length
    },
    message: errors
      ? `${errors} erro(s) impedem agentes totalmente configurados.`
      : (warnings ? `${warnings} alerta(s) de qualidade no contrato semantico.` : 'Todos os agentes ativos tem contrato semantico completo.')
  };
}

module.exports = {
  buildAIAgentReadiness,
  buildDepartmentContractReadiness
};
