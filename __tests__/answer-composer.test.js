const answerComposer = require('../src/agent/answer-composer');
const { scopeConfigForDepartment } = require('../src/services/aiService');

describe('Agent answer composer', () => {
  test('uses selected department prompt and model for grounded non-product answers', async () => {
    const calls = [];
    const result = await answerComposer.compose({
      message: {
        text: 'Vocês aceitam Pix na retirada?',
        effectiveConfig: {
          _answerRuntimeContext: {
            generateAnswer: async payload => {
              calls.push(payload);
              return {
                text: 'Sim, aceitamos Pix na retirada.',
                confidence: 'high',
                grounded: true
              };
            }
          }
        }
      },
      route: { intent: 'faq' },
      evidence: {
        topEvidence: [{
          sourceType: 'file',
          sourceName: 'Politicas',
          content: 'Pagamento: aceitamos Pix na retirada.',
          score: 0.9
        }],
        departmentSettings: {
          name: 'Atendimento',
          systemPrompt: 'Voce e o agente de atendimento.',
          model: 'gpt-4o-mini',
          temperature: 0.1,
          allowedSources: ['file'],
          responseRules: ['nao inventar formas de pagamento']
        }
      }
    });

    expect(result.text).toBe('Sim, aceitamos Pix na retirada.');
    expect(result.composer).toBe('agent_llm');
    expect(calls).toHaveLength(1);
    expect(calls[0].departmentSettings.model).toBe('gpt-4o-mini');
    expect(calls[0].prompt).toMatch(/Voce e o agente de atendimento/);
    expect(calls[0].prompt).toMatch(/Fontes autorizadas para este agente: file/);
    expect(calls[0].prompt).toMatch(/aceitamos Pix na retirada/);
  });

  test('does not call agent LLM for product card flow', async () => {
    const generateAnswer = jest.fn();
    const result = await answerComposer.compose({
      message: {
        text: 'Tem camiseta preta?',
        effectiveConfig: { _answerRuntimeContext: { generateAnswer } }
      },
      route: { intent: 'product' },
      evidence: {
        topEvidence: [{
          sourceType: 'catalog',
          content: 'Camiseta preta',
          score: 0.95,
          metadata: {
            productCards: [{ title: 'Camiseta preta', imageUrl: 'https://example.com/a.jpg' }]
          }
        }],
        departmentSettings: { systemPrompt: 'Agente de vendas' }
      }
    });

    expect(result.product_cards).toHaveLength(1);
    expect(generateAnswer).not.toHaveBeenCalled();
  });

  test('falls back to deterministic grounded answer when no answer runtime is configured', async () => {
    const result = await answerComposer.compose({
      message: { text: 'Qual o horario?' },
      route: { intent: 'faq' },
      evidence: {
        topEvidence: [{
          sourceType: 'file',
          content: 'Horario de atendimento: segunda a sexta das 9h as 18h.',
          score: 0.8
        }],
        departmentSettings: { systemPrompt: 'Agente de atendimento' }
      }
    });

    expect(result.text).toMatch(/segunda a sexta/);
    expect(result.grounded).toBe(true);
  });

  test('scopes integrations, URLs and files by department bindings', () => {
    const scoped = scopeConfigForDepartment({
      product_integrations: [
        { id: 'sales-api', integration_type: 'facilzap', integration_name: 'Catalogo' },
        { id: 'billing-api', integration_type: 'crm', integration_name: 'Pedidos' }
      ],
      product_source_urls: ['https://loja.example.com/catalogo', 'https://loja.example.com/politicas'],
      knowledge_files: [
        { id: 'politicas-venda.pdf', originalName: 'politicas-venda.pdf', extractedText: 'vendas' },
        { id: 'financeiro.pdf', originalName: 'financeiro.pdf', extractedText: 'financeiro' }
      ]
    }, {
      allowedIntegrationTypes: ['facilzap'],
      allowedIntegrationIds: ['sales-api'],
      allowedSourceUrls: ['https://loja.example.com/catalogo'],
      allowedKnowledgeFileIds: ['politicas-venda.pdf']
    });

    expect(scoped.product_integrations.map(item => item.id)).toEqual(['sales-api']);
    expect(scoped.product_source_urls).toEqual(['https://loja.example.com/catalogo']);
    expect(scoped.knowledge_files.map(item => item.id)).toEqual(['politicas-venda.pdf']);
  });

  test('calls Claude composer when department model is Claude', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async (url, options) => ({
      ok: true,
      json: async () => ({
        content: [{ text: '{"text":"Resposta via Claude","confidence":"high","missingInfo":"","grounded":true}' }]
      }),
      url,
      options
    }));

    try {
      const result = await answerComposer.compose({
        message: {
          text: 'Como funciona a troca?',
          effectiveConfig: {
            _answerRuntimeContext: { claudeApiKey: 'sk-ant-test-key' }
          }
        },
        route: { intent: 'policy' },
        evidence: {
          topEvidence: [{ sourceType: 'file', content: 'Troca em ate 7 dias.', score: 0.9 }],
          departmentSettings: {
            name: 'Atendimento',
            model: 'claude-3-haiku-20240307',
            systemPrompt: 'Agente de atendimento'
          }
        }
      });

      expect(result.text).toBe('Resposta via Claude');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({ method: 'POST' })
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});
