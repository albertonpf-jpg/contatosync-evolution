const { buildAIRouteDiagnosis, runAIRouteDiagnosticsSuite } = require('../src/services/aiRouteDiagnostics');

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
});
