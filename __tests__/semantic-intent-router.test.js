const lightweightRouter = require('../src/router/lightweight-router');
const { normalizeDepartmentConfig } = require('../src/agent/department-config');
const { selectDepartmentAgent } = require('../src/agent/departments');
const { buildClassifierPrompt, buildSemanticIntentReadiness, classifyIntentSemantically } = require('../src/router/semantic-intent-classifier');

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

  test('falls back to configured agent profile when semantic confidence is low', async () => {
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
    expect(route.routerMode).toBe('configured_after_low_confidence_semantic');
    expect(route.configuredDepartmentId).toBe('sales');
  });

  test('strict semantic mode keeps high-confidence local intent when semantic confidence is low', async () => {
    const route = await lightweightRouter.route({
      text: 'Tem vestido azul tamanho 4?',
      effectiveConfig: {
        semantic_intent_enabled: true,
        require_semantic_intent_classifier: true,
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
    expect(route.needsCatalog).toBe(true);
  });

  test('strict semantic mode keeps product intent for contextual model follow-up', async () => {
    const route = await lightweightRouter.route({
      text: 'Esses sao os mesmos, nao tem modelos diferentes?',
      conversationHistory: [
        { direction: 'in', content: 'Tem mais modelos de tenis?' },
        { direction: 'out', content: 'Encontrei este modelo no catalogo: Tenis adidas samba hello kitty.' }
      ],
      effectiveConfig: {
        semantic_intent_enabled: true,
        require_semantic_intent_classifier: true,
        intent_confidence_threshold: 0.8,
        _intentRuntimeContext: {
          classifyIntent: async () => ({
            intent: 'unknown',
            confidence: 0.3,
            reason: 'baixa confianca'
          })
        }
      }
    });

    expect(route.intent).toBe('product');
    expect(route.routerMode).toBe('rules_after_low_confidence_semantic');
    expect(route.needsCatalog).toBe(true);
  });

  test('strict semantic mode still asks clarification for vague low-confidence messages', async () => {
    const route = await lightweightRouter.route({
      text: 'Oi, preciso resolver uma coisa',
      effectiveConfig: {
        semantic_intent_enabled: true,
        require_semantic_intent_classifier: true,
        intent_confidence_threshold: 0.8,
        _intentRuntimeContext: {
          classifyIntent: async () => ({
            intent: 'unknown',
            confidence: 0.3,
            reason: 'baixa confianca'
          })
        }
      }
    });

    expect(route.intent).toBe('unknown');
    expect(route.routerMode).toBe('clarify_after_low_confidence_semantic');
    expect(route.configured.ambiguity).toBe('semantic_classifier_required');
  });

  test('uses configured agent examples when semantic classifier is unavailable', async () => {
    const route = await lightweightRouter.route({
      text: 'Estou procurando algo para presente de menina de 2 anos',
      effectiveConfig: {
        semantic_intent_enabled: true
      }
    });

    expect(route.intent).toBe('product');
    expect(route.routerMode).toBe('configured_after_semantic_skipped');
    expect(route.configuredDepartmentId).toBe('sales');
    expect(route.needsCatalog).toBe(true);
  });

  test('configured fallback respects per-agent exclusion examples', async () => {
    const route = await lightweightRouter.route({
      text: 'meu pedido ja saiu?',
      effectiveConfig: {
        semantic_intent_enabled: true,
        require_semantic_intent_classifier: false,
        department_agent_config: {
          sales: {
            semanticDescription: 'mensagens sobre pedido do cliente',
            activationExamples: ['meu pedido ja saiu?'],
            exclusionExamples: ['meu pedido ja saiu?', 'rastreio do meu pedido'],
            intents: ['product']
          },
          billing: {
            semanticDescription: 'status, rastreio e pedido ja feito',
            activationExamples: ['meu pedido ja saiu?', 'cade meu rastreio?'],
            intents: ['order_status', 'billing']
          }
        }
      }
    });

    expect(route.intent).toBe('order_status');
    expect(route.configuredDepartmentId).toBe('billing');
    expect(route.configured.scores.find(score => score.id === 'sales').exclusionScore).toBeGreaterThan(0);
  });

  test('strict semantic mode does not route by configured token fallback when classifier is unavailable', async () => {
    const route = await lightweightRouter.route({
      text: 'Estou procurando algo para presente de menina de 2 anos',
      effectiveConfig: {
        semantic_intent_enabled: true,
        require_semantic_intent_classifier: true
      }
    });

    expect(route.intent).toBe('unknown');
    expect(route.routerMode).toBe('clarify_after_semantic_skipped');
    expect(route.configuredDepartmentId).toBe('support');
    expect(route.configured.ambiguity).toBe('semantic_classifier_required');
    expect(route.configured.reason).toMatch(/indisponivel/i);
    expect(route.needsCatalog).toBe(false);
  });

  test('asks for clarification when configured fallback cannot separate departments', async () => {
    const route = await lightweightRouter.route({
      text: 'preciso resolver uma situacao',
      effectiveConfig: {
        semantic_intent_enabled: true,
        department_agent_config: {
          sales: {
            semanticDescription: 'resolver situacao do cliente',
            activationExamples: ['preciso resolver uma situacao']
          },
          support: {
            semanticDescription: 'resolver situacao do cliente',
            activationExamples: ['preciso resolver uma situacao']
          }
        }
      }
    });

    expect(route.intent).toBe('unknown');
    expect(route.routerMode).toBe('clarify_after_semantic_skipped');
    expect(route.configured.ambiguity).toContain('ambigua');
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
    expect(departments.sales.boundaryRules.length).toBeGreaterThan(0);
    expect(departments.sales.exclusionExamples.length).toBeGreaterThan(0);
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

  test('semantic classifier prompt includes per-agent boundary contract', () => {
    const prompt = buildClassifierPrompt({
      message: { text: 'paguei no pix e nao confirmou' },
      config: {
        department_agent_config: {
          sales: {
            boundaryRules: ['nao tratar pagamento'],
            exclusionExamples: ['paguei no pix e nao confirmou']
          }
        }
      }
    });

    expect(prompt).toMatch(/Nao acionar quando: nao tratar pagamento/);
    expect(prompt).toMatch(/Exemplos que pertencem a outro setor: paguei no pix e nao confirmou/);
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

  test('marks Claude classifier as ready when Claude key is configured', () => {
    const readiness = buildSemanticIntentReadiness(
      { semantic_intent_enabled: true, intent_classifier_model: 'claude-3-haiku' },
      { claude_api_key: 'test-claude-key' }
    );

    expect(readiness.ready).toBe(true);
    expect(readiness.provider).toBe('claude');
    expect(readiness.mode).toBe('semantic_llm');
  });

  test('uses Claude semantic classifier when Claude model is selected', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [{
          text: JSON.stringify({
            intent: 'billing',
            departmentId: 'billing',
            confidence: 0.91,
            reason: 'cliente fala de pagamento e pedido'
          })
        }]
      })
    }));

    try {
      const result = await classifyIntentSemantically({
        text: 'O comprovante ja foi enviado, liberou?',
        effectiveConfig: {
          semantic_intent_enabled: true,
          intent_classifier_model: 'claude-3-haiku',
          _intentRuntimeContext: { claudeApiKey: 'test-claude-key' }
        }
      });

      expect(result.skipped).toBe(false);
      expect(result.classification).toMatchObject({
        intent: 'billing',
        departmentId: 'billing'
      });
      expect(global.fetch).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.any(Object));
    } finally {
      global.fetch = originalFetch;
    }
  });
});
