const {
  buildAIRouteDiagnosis,
  buildAISourceReadiness,
  runAIRouteDiagnosticsSuite
} = require('../src/services/aiRouteDiagnostics');

describe('AI route diagnostics', () => {
  test('explains semantic intent, selected agent and allowed sources', async () => {
    const diagnosis = await buildAIRouteDiagnosis({
      message: 'Ja mandei o comprovante ontem, consegue liberar meu pedido?',
      config: {
        semantic_intent_enabled: true,
        intent_confidence_threshold: 0.7,
        _intentRuntimeContext: {
          classifyIntent: async () => ({
            intent: 'billing',
            confidence: 0.91,
            reason: 'comprovante e liberacao de pedido dependem do financeiro'
          })
        },
        department_agent_config: {
          billing: {
            name: 'Financeiro',
            allowedSources: ['api', 'file'],
            allowedIntegrationTypes: ['crm'],
            allowedIntegrationIds: ['pedidos-api'],
            sourcePriority: ['api', 'file'],
            responseRules: ['pedir numero do pedido quando faltar']
          }
        }
      }
    });

    expect(diagnosis.route.intent).toBe('billing');
    expect(diagnosis.route.routerMode).toBe('semantic');
    expect(diagnosis.department.id).toBe('billing');
    expect(diagnosis.retrievalPlan.executeSources[0]).toBe('api');
    expect(diagnosis.sourceBindings.allowedSources).toEqual(['api', 'file']);
    expect(diagnosis.sourceBindings.allowedIntegrationTypes).toEqual(['crm']);
    expect(diagnosis.sourceBindings.allowedIntegrationIds).toEqual(['pedidos-api']);
    expect(diagnosis.safety.willHandoff).toBe(false);
  });

  test('preserves explicit human handoff rule in diagnostics', async () => {
    const diagnosis = await buildAIRouteDiagnosis({
      message: 'Quero falar com uma pessoa agora',
      config: { semantic_intent_enabled: true }
    });

    expect(diagnosis.route.intent).toBe('human_request');
    expect(diagnosis.department.id).toBe('handoff');
    expect(diagnosis.safety.willHandoff).toBe(true);
  });

  test('runs a route diagnostics suite with intent, agent and source checks', async () => {
    const suite = await runAIRouteDiagnosticsSuite({
      scenarios: [
        {
          id: 'billing-api',
          label: 'Financeiro usa API',
          message: 'Paguei no pix, ja liberou?',
          expectedIntents: ['billing'],
          expectedDepartments: ['billing'],
          requiredSources: ['api'],
          expectHandoff: false,
          minConfidence: 0.8
        },
        {
          id: 'human',
          label: 'Humano explicito',
          message: 'Quero falar com uma pessoa',
          expectedIntents: ['human_request'],
          expectedDepartments: ['handoff'],
          expectHandoff: true,
          minConfidence: 0.8
        }
      ],
      config: {
        semantic_intent_enabled: true,
        _intentRuntimeContext: {
          classifyIntent: async ({ message }) => {
            if (/pix|liberou/i.test(message.text)) {
              return { intent: 'billing', confidence: 0.9, reason: 'pagamento e liberacao' };
            }
            return { intent: 'support', confidence: 0.6, reason: 'fallback de teste' };
          }
        },
        department_agent_config: {
          billing: {
            allowedSources: ['api', 'file'],
            sourcePriority: ['api', 'file']
          }
        }
      }
    });

    expect(suite.total).toBe(2);
    expect(suite.passed).toBe(2);
    expect(suite.failed).toBe(0);
    expect(suite.score).toBe(100);
    expect(suite.results[0].diagnosis.department.id).toBe('billing');
    expect(suite.results[0].checks.every(check => check.passed)).toBe(true);
  });

  test('reports missing operational sources per configured agent', () => {
    const readiness = buildAISourceReadiness({
      department_agent_config: {
        billing: {
          name: 'Financeiro',
          allowedSources: ['api', 'file'],
          sourcePriority: ['api', 'file']
        }
      }
    });

    expect(readiness.summary.errors).toBeGreaterThanOrEqual(1);
    expect(readiness.departments.billing.issues[0]).toMatchObject({
      severity: 'error',
      source: 'api'
    });
  });

  test('accepts API source when an enabled integration is configured', () => {
    const readiness = buildAISourceReadiness({
      product_integrations: [
        {
          id: 'facilzap-main',
          integration_type: 'facilzap',
          api_endpoint: 'https://api.facilzap.app.br',
          enabled: true
        }
      ],
      department_agent_config: {
        billing: {
          name: 'Financeiro',
          allowedSources: ['api'],
          sourcePriority: ['api']
        }
      }
    });

    expect(readiness.departments.billing.issues).toEqual([]);
    expect(readiness.availability.api.ready).toBe(true);
  });

  test('reports API source missing when agent is bound to unmatched integration id', () => {
    const readiness = buildAISourceReadiness({
      product_integrations: [
        {
          id: 'pedidos-api',
          integration_type: 'facilzap',
          api_endpoint: 'https://api.example.com',
          enabled: true
        }
      ],
      department_agent_config: {
        billing: {
          name: 'Financeiro',
          allowedSources: ['api'],
          sourcePriority: ['api'],
          allowedIntegrationIds: ['erp-inexistente']
        }
      }
    });

    expect(readiness.availability.api.ready).toBe(true);
    expect(readiness.departments.billing.availability.api.ready).toBe(false);
    expect(readiness.departments.billing.issues[0]).toMatchObject({
      severity: 'error',
      source: 'api'
    });
  });

  test('accepts API source when agent binding matches integration id and type', () => {
    const readiness = buildAISourceReadiness({
      product_integrations: [
        {
          id: 'pedidos-api',
          integration_type: 'facilzap',
          api_endpoint: 'https://api.example.com',
          enabled: true
        }
      ],
      department_agent_config: {
        billing: {
          name: 'Financeiro',
          allowedSources: ['api'],
          sourcePriority: ['api'],
          allowedIntegrationIds: ['pedidos-api'],
          allowedIntegrationTypes: ['facilzap']
        }
      }
    });

    expect(readiness.availability.api.ready).toBe(true);
    expect(readiness.departments.billing.availability.api.ready).toBe(true);
    expect(readiness.departments.billing.issues).toEqual([]);
  });

  test('includes selected agent source readiness in route diagnosis', async () => {
    const diagnosis = await buildAIRouteDiagnosis({
      message: 'Ja paguei no pix, meu pedido foi liberado?',
      config: {
        semantic_intent_enabled: true,
        _intentRuntimeContext: {
          classifyIntent: async () => ({
            intent: 'billing',
            departmentId: 'billing',
            confidence: 0.92,
            reason: 'pagamento e liberacao de pedido'
          })
        },
        department_agent_config: {
          billing: {
            name: 'Financeiro',
            allowedSources: ['api'],
            sourcePriority: ['api']
          }
        }
      }
    });

    expect(diagnosis.department.id).toBe('billing');
    expect(diagnosis.sourceReadiness.department.id).toBe('billing');
    expect(diagnosis.sourceReadiness.issues[0]).toMatchObject({
      severity: 'error',
      source: 'api'
    });
  });

  test('reports semantic classifier readiness when API key is missing', async () => {
    const diagnosis = await buildAIRouteDiagnosis({
      message: 'Quero algo bonito para presente',
      config: {
        semantic_intent_enabled: true,
        intent_classifier_model: 'gpt-4o-mini'
      },
      client: {}
    });

    expect(diagnosis.semanticReadiness.ready).toBe(false);
    expect(diagnosis.semanticReadiness.mode).toBe('local_fallback_only');
    expect(diagnosis.semanticReadiness.issues[0]).toMatchObject({
      severity: 'error',
      code: 'semantic_classifier_missing_openai_key'
    });
    expect(diagnosis.safety.willUseSemanticClassifier).toBe(false);
  });

  test('accepts Claude semantic classifier readiness when Claude key is configured', async () => {
    const diagnosis = await buildAIRouteDiagnosis({
      message: 'Ja enviei o comprovante, meu pedido liberou?',
      config: {
        semantic_intent_enabled: true,
        intent_classifier_model: 'claude-3-haiku',
        _intentRuntimeContext: {
          classifyIntent: async () => ({
            intent: 'billing',
            departmentId: 'billing',
            confidence: 0.9,
            reason: 'pagamento e liberacao'
          })
        }
      },
      client: { claude_api_key: 'test-claude-key' }
    });

    expect(diagnosis.semanticReadiness.ready).toBe(true);
    expect(diagnosis.semanticReadiness.provider).toBe('custom');
    expect(diagnosis.route.routerMode).toBe('semantic');
    expect(diagnosis.safety.willUseSemanticClassifier).toBe(true);
  });
});
