const { buildAIRouteDiagnosis } = require('../src/services/aiRouteDiagnostics');

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
});
