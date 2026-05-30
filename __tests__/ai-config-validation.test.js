const { aiConfigSchemas } = require('../src/utils/validation');

describe('AI config validation', () => {
  test('accepts complete department agent settings used by IA Config', () => {
    const payload = {
      ai_engine: 'local_multi_agent',
      semantic_intent_enabled: true,
      intent_classifier_model: 'gpt-4o-mini',
      intent_confidence_threshold: 0.72,
      department_agent_config: {
        billing: {
          enabled: true,
          name: 'Financeiro',
          intents: ['billing', 'order_status'],
          semanticDescription: 'Pedido, pagamento e rastreio',
          activationExamples: ['Paguei no pix', 'Meu pedido saiu?'],
          systemPrompt: 'Consulte pedidos antes de responder.',
          model: 'gpt-4o-mini',
          temperature: 0.2,
          allowedSources: ['api', 'rag', 'file'],
          allowedIntegrationTypes: ['facilzap'],
          allowedIntegrationIds: ['pedidos-api'],
          allowedSourceUrls: ['https://example.com/politicas'],
          allowedKnowledgeFileIds: ['politicas.pdf'],
          sourceUseRules: ['use API para pedido'],
          sourcePriority: ['api', 'rag'],
          responseRules: ['peca numero do pedido quando faltar'],
          handoffKeywords: ['chargeback'],
          maxEvidence: 4
        }
      }
    };

    const { error, value } = aiConfigSchemas.update.validate(payload, { abortEarly: false, stripUnknown: true });

    expect(error).toBeUndefined();
    expect(value.department_agent_config.billing.allowedSources).toEqual(['api', 'rag', 'file']);
    expect(value.department_agent_config.billing.maxEvidence).toBe(4);
  });

  test('rejects invalid department source and intent values', () => {
    const { error } = aiConfigSchemas.update.validate({
      department_agent_config: {
        sales: {
          intents: ['product', 'admin_override'],
          allowedSources: ['catalog', 'sql_shell']
        }
      }
    }, { abortEarly: false, stripUnknown: true });

    const fields = (error?.details || []).map(detail => detail.path.join('.'));
    expect(fields).toContain('department_agent_config.sales.intents.1');
    expect(fields).toContain('department_agent_config.sales.allowedSources.1');
  });
});
