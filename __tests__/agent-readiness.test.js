const { buildAIAgentReadiness } = require('../src/agent/agent-readiness');

describe('AI agent semantic contract readiness', () => {
  test('marks default department agents as semantically ready', () => {
    const readiness = buildAIAgentReadiness({});

    expect(readiness.ready).toBe(true);
    expect(readiness.summary.errors).toBe(0);
    expect(readiness.summary.enabledDepartments).toBeGreaterThan(0);
    expect(readiness.departments.sales.counts.activationExamples).toBeGreaterThanOrEqual(3);
    expect(readiness.departments.billing.counts.allowedSources).toBeGreaterThan(0);
  });

  test('reports weak example boundaries per department', () => {
    const readiness = buildAIAgentReadiness({
      department_agent_config: {
        sales: {
          activationExamples: ['quero ver produto'],
          exclusionExamples: [],
          boundaryRules: [],
          sourceUseRules: [],
          responseRules: []
        }
      }
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.departments.sales.ready).toBe(true);
    expect(readiness.summary.warnings).toBeGreaterThan(0);
    expect(readiness.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'few_activation_examples',
      'few_exclusion_examples',
      'few_boundary_rules',
      'missing_source_use_rules',
      'missing_response_rules'
    ]));
  });
});
