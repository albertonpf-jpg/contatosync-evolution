const lightweightRouter = require('../src/router/lightweight-router');
const { normalizeDepartmentConfig } = require('../src/agent/department-config');
const { selectDepartmentAgent } = require('../src/agent/departments');

describe('Semantic intent router', () => {
  test('uses semantic classifier before keyword fallback when confidence is high', async () => {
    const route = await lightweightRouter.route({
      text: 'Ja mandei o comprovante ontem, consegue ver se liberou?',
      effectiveConfig: {
        semantic_intent_enabled: true,
        intent_confidence_threshold: 0.68,
        _intentRuntimeContext: {
          classifyIntent: async () => ({
            intent: 'billing',
            departmentId: 'billing',
            confidence: 0.87,
            reason: 'cliente fala sobre comprovante e liberacao de pagamento'
          })
        }
      }
    });

    expect(route.intent).toBe('billing');
    expect(route.routerMode).toBe('semantic');
    expect(route.semanticDepartmentId).toBe('billing');
    expect(route.needsApi).toBe(true);
  });

  test('falls back to rules when semantic confidence is low', async () => {
    const route = await lightweightRouter.route({
      text: 'Tem vestido azul tamanho 4?',
      effectiveConfig: {
        semantic_intent_enabled: true,
        intent_confidence_threshold: 0.8,
        _intentRuntimeContext: {
          classifyIntent: async () => ({
            intent: 'faq',
            confidence: 0.41,
            reason: 'baixa confianca'
          })
        }
      }
    });

    expect(route.intent).toBe('product');
    expect(route.routerMode).toBe('rules_after_low_confidence_semantic');
  });

  test('normalizes per-agent semantic contract fields', () => {
    const departments = normalizeDepartmentConfig({
      department_agent_config: {
        sales: {
          semanticDescription: 'mensagens de compra',
          activationExamples: 'quero comprar, me mostra opcoes',
          allowedSources: 'catalog, api',
          allowedIntegrationTypes: 'facilzap, ecommerce',
          allowedIntegrationIds: 'catalogo-principal',
          allowedSourceUrls: 'https://loja.example.com/catalogo',
          allowedKnowledgeFileIds: 'politicas-venda.pdf',
          sourceUseRules: 'catalog para produtos\napi para estoque',
          systemPrompt: 'agente de vendas',
          model: 'gpt-4o-mini',
          temperature: 0.3
        }
      }
    });

    expect(departments.sales.semanticDescription).toBe('mensagens de compra');
    expect(departments.sales.activationExamples).toEqual(['quero comprar', 'me mostra opcoes']);
    expect(departments.sales.allowedSources).toEqual(['catalog', 'api']);
    expect(departments.sales.allowedIntegrationTypes).toEqual(['facilzap', 'ecommerce']);
    expect(departments.sales.allowedIntegrationIds).toEqual(['catalogo-principal']);
    expect(departments.sales.allowedSourceUrls).toEqual(['https://loja.example.com/catalogo']);
    expect(departments.sales.allowedKnowledgeFileIds).toEqual(['politicas-venda.pdf']);
    expect(departments.sales.sourceUseRules).toEqual(['catalog para produtos', 'api para estoque']);
    expect(departments.sales.systemPrompt).toBe('agente de vendas');
    expect(departments.sales.model).toBe('gpt-4o-mini');
    expect(departments.sales.temperature).toBe(0.3);
  });

  test('department plan only executes allowed sources', async () => {
    const agent = selectDepartmentAgent({ intent: 'product' }, {
      department_agent_config: {
        sales: {
          allowedSources: ['catalog'],
          sourcePriority: ['api', 'catalog', 'rag']
        }
      }
    });

    const plan = await agent.buildRetrievalPlan({
      message: { text: 'Quero opcoes para festa infantil' },
      route: {
        intent: 'product',
        needsCatalog: true,
        needsApi: true,
        needsRag: true,
        needsSite: true,
        needsFiles: true,
        needsConversationMemory: true,
        blockedSources: []
      }
    });

    expect(plan.executeSources).toEqual(['catalog']);
    expect(plan.skippedSources).toEqual(expect.arrayContaining(['api', 'rag']));
  });

  test('selects departments from saved agent intent configuration', async () => {
    const config = {
      department_agent_config: {
        sales: { intents: [] },
        support: { intents: ['product', 'faq', 'policy', 'support', 'unknown'] }
      }
    };
    const route = await lightweightRouter.route({
      text: 'Quero opcoes para festa infantil',
      effectiveConfig: {
        ...config,
        semantic_intent_enabled: true,
        _intentRuntimeContext: {
          classifyIntent: async () => ({
            intent: 'product',
            departmentId: 'support',
            confidence: 0.92,
            reason: 'configuracao direciona produto para atendimento'
          })
        }
      }
    });
    const agent = selectDepartmentAgent(route, config);

    expect(route.intent).toBe('product');
    expect(route.semanticDepartmentId).toBe('support');
    expect(agent.id).toBe('support');
  });
});
