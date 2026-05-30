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

  test('does not expose raw customer records for order status without order data', async () => {
    const result = await answerComposer.compose({
      message: { text: 'Ja paguei no pix, meu pedido foi liberado?' },
      route: { intent: 'order_status' },
      evidence: {
        topEvidence: [{
          sourceType: 'api',
          content: [
            'Informacoes operacionais coletadas das integracoes:',
            '- data: cliente: nome: Maria Teste',
            '- data: cliente: whatsapp: 11999999999',
            '- data: cliente: whatsapp_e164: +5511999999999'
          ].join('\n'),
          score: 0.85
        }],
        departmentSettings: { systemPrompt: 'Agente financeiro' }
      }
    });

    expect(result.text).toBe('');
    expect(result.missingInfo).toBe('order_number');
    expect(result.grounded).toBe(false);
  });

  test('summarizes safe order status fields without customer PII', async () => {
    const result = await answerComposer.compose({
      message: { text: 'Meu pedido 123 foi liberado?' },
      route: { intent: 'order_status' },
      evidence: {
        topEvidence: [{
          sourceType: 'api',
          content: [
            '- codigo: 123',
            '- cliente: nome: Maria Teste',
            '- total: 129,90',
            '- pagamentos: status: pago',
            '- status_pago: true',
            '- status_em_separacao: true'
          ].join('\n'),
          score: 0.85
        }],
        departmentSettings: { systemPrompt: 'Agente financeiro' }
      }
    });

    expect(result.text).toMatch(/pedido 123/i);
    expect(result.text).toMatch(/pagamento/i);
    expect(result.text).not.toMatch(/Maria Teste/);
    expect(result.grounded).toBe(true);
  });

  test('blocks order status when API phone does not match WhatsApp contact and no order number was provided', async () => {
    const result = await answerComposer.compose({
      message: {
        text: 'Ja paguei no pix, meu pedido foi liberado?',
        customerPhone: '5599999999999'
      },
      route: { intent: 'order_status' },
      evidence: {
        topEvidence: [{
          sourceType: 'api',
          content: [
            '- cliente: whatsapp_e164: +5511965169866',
            '- status_pago: true',
            '- status_em_separacao: true'
          ].join('\n'),
          score: 0.85
        }],
        departmentSettings: { systemPrompt: 'Agente financeiro' }
      }
    });

    expect(result.text).toBe('');
    expect(result.missingInfo).toBe('order_number');
    expect(result.grounded).toBe(false);
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
