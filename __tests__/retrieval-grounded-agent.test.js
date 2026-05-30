const fs = require('fs');
const path = require('path');
const orchestrator = require('../src/agent/whatsapp-agent.orchestrator');
const lightweightRouter = require('../src/router/lightweight-router');
const sourceDecision = require('../src/router/source-decision');
const guardrail = require('../src/agent/confidence-guardrail');
const { createResponseRegistry } = require('../src/whatsapp/response-registry');

function logger() {
  return { lines: [], log(line) { this.lines.push(String(line)); } };
}

async function run(text, adapters = {}, history = [], config = {}) {
  const testLogger = logger();
  const result = await orchestrator.handleIncomingWhatsAppMessage({
    clientId: 'client-1',
    conversation: { id: 'conv-1', phone: '5511999999999' },
    contact: { name: 'Cliente', phone: '5511999999999' },
    text,
    conversationHistory: history,
    config
  }, { adapters, logger: testLogger });
  return { result, logs: testLogger.lines };
}

describe('Retrieval-Grounded WhatsApp Agent', () => {
  const bannedHumanSuggestion = /\b(humano|atendente|transferir|chamar alguem|chamar alguém|falar com uma pessoa)\b/i;

  test('FAQ simples responde somente depois de recuperar evidencia', async () => {
    const { result, logs } = await run('Qual o horario de atendimento?', {
      rag: async () => [{ sourceType: 'rag', sourceName: 'FAQ', content: 'Horario de atendimento: segunda a sexta, das 9h as 18h.', score: 0.9 }],
      site: async () => [],
      file: async () => []
    });

    expect(['clarify', 'continue_discovery', 'send']).toContain(result.action);
    expect(result.response).toContain('Horario de atendimento');
    expect(logs.join('\n')).toMatch(/\[LIGHTWEIGHT ROUTER\]/);
    expect(logs.join('\n')).toMatch(/\[RETRIEVAL STARTED\]/);
    expect(logs.join('\n')).toMatch(/\[ANSWER COMPOSER\]/);
  });

  test('pergunta de politica nao cria topico rigido antes do RAG', async () => {
    const route = await lightweightRouter.route({ text: 'Voces fazem retirada?' });
    expect(route.intent).toBe('policy');
    expect(route).not.toHaveProperty('policyTopic');
    expect(route).not.toHaveProperty('selectedCategory');

    const { result } = await run('Voces fazem retirada?', {
      rag: async () => [{ sourceType: 'rag', sourceName: 'Politica', content: 'A retirada e feita somente com agendamento.', score: 0.88 }],
      site: async () => [],
      file: async () => []
    });
    expect(['clarify', 'continue_discovery', 'send']).toContain(result.action);
    expect(result.response).toContain('retirada');
  });

  test('pergunta sem evidencia nao inventa e nao chama humano', async () => {
    const { result } = await run('Voces entregam em Marte?', {
      rag: async () => [],
      site: async () => [],
      file: async () => []
    });
    expect(['clarify', 'continue_discovery']).toContain(result.action);
    expect(result.action).not.toBe('handoff');
    expect(result.response).toMatch(/detalhe|cidade|ajudar/i);
  });

  test('evidencia de outro assunto bloqueia resposta falsa', async () => {
    const { result } = await run('Voces aceitam pix?', {
      rag: async () => [{ sourceType: 'rag', sourceName: 'Site', content: 'Frete por motoboy para Sao Paulo.', score: 0.4 }],
      site: async () => [],
      file: async () => []
    });
    expect(result.action).not.toBe('handoff');
    expect(result.response).not.toMatch(/pix/i);
  });

  test('evidencias conflitantes nao viram certeza falsa nem handoff', async () => {
    const validation = await guardrail.validate({
      route: { explicitHumanRequest: false, intent: 'policy' },
      evidence: { conflicts: [{ reason: 'conflito' }] },
      draftAnswer: { text: 'O prazo e 3 dias.', confidence: 'medium', grounded: true }
    });
    expect(validation.action).toBe('clarify');
    expect(validation.action).not.toBe('handoff');
  });

  test('status de pedido com numero consulta API e usa dado dinamico', async () => {
    const { result } = await run('Meu pedido 12345 chegou?', {
      api: async () => [{ sourceType: 'api', sourceName: 'Pedidos', content: 'Pedido 12345: saiu para entrega hoje.', score: 0.95, isDynamic: true }],
      rag: async () => [],
      site: async () => [],
      file: async () => []
    }, [], {
      product_integrations: [{ id: 'pedidos-api', api_endpoint: 'https://api.example.com', enabled: true }]
    });
    expect(result.action).toBe('send');
    expect(result.response).toContain('12345');
  });

  test('status de pedido sem numero pede numero do pedido', async () => {
    const { result } = await run('Meu pedido chegou?', {
      api: async () => { throw new Error('api_nao_deveria_ser_chamada'); }
    });
    expect(result.action).toBe('clarify');
    expect(result.response).toMatch(/numero do pedido/i);
  });

  test('produto monta cards apenas com dados reais do catalogo', async () => {
    const { result } = await run('Tem camiseta preta tamanho M?', {
      catalog: async () => [{
        sourceType: 'catalog',
        sourceName: 'Catalogo',
        content: 'Titulo: Camiseta preta\nPreco: R$ 39,90\nTamanhos com estoque: M',
        score: 0.95,
        isDynamic: true,
        metadata: {
          lookupAttempted: true,
          productsFound: true,
          productCards: [{ title: 'Camiseta preta', description: 'R$ 39,90', imageUrl: 'https://example.com/a.jpg', url: 'https://example.com/p' }]
        }
      }],
      rag: async () => [],
      site: async () => []
    });
    expect(result.action).toBe('send');
    expect(result.product_cards).toHaveLength(1);
  });

  test('produto por tamanho gera uma unica decisao final sem sugerir humano', async () => {
    const { result } = await run('Voce tem pecas no tamanho 6?', {
      catalog: async () => [{
        sourceType: 'catalog',
        sourceName: 'Catalogo',
        content: 'Titulo: Conjunto tamanho 6\nTamanhos com estoque: 6',
        score: 0.95,
        metadata: {
          lookupAttempted: true,
          productsFound: true,
          productCards: [{ title: 'Conjunto tamanho 6', description: 'Tam 6', imageUrl: 'https://example.com/6.jpg', url: 'https://example.com/6' }]
        }
      }],
      rag: async () => [],
      site: async () => []
    });
    expect(result.action).toBe('send');
    expect(result.product_cards).toHaveLength(1);
    expect(result.response).not.toMatch(bannedHumanSuggestion);
  });

  test('produto nao encontrado pergunta refinamento sem inventar e sem handoff', async () => {
    const { result } = await run('Tem camiseta preta tamanho M?', {
      catalog: async () => [{ sourceType: 'catalog', sourceName: 'Catalogo', content: '', score: 0.2, metadata: { lookupAttempted: true, productsFound: false } }],
      rag: async () => [],
      site: async () => []
    });
    expect(['clarify', 'continue_discovery', 'send']).toContain(result.action);
    expect(result.response).toMatch(/outro tamanho|cor|modelo/i);
    expect(result.action).not.toBe('handoff');
  });

  test('preco sem contexto pergunta qual produto', async () => {
    const { result } = await run('Quanto custa?');
    expect(result.action).toBe('clarify');
    expect(result.response).toMatch(/qual produto/i);
  });

  test('pedido explicito de humano executa handoff', async () => {
    const { result } = await run('Quero falar com um atendente');
    expect(result.action).toBe('handoff');
    expect(result.route.explicitHumanRequest).toBe(true);
    expect(result.route.needsHuman).toBe(true);
  });

  test('cliente confuso nao dispara handoff automatico', async () => {
    const { result } = await run('Nao entendi, como funciona?', {
      rag: async () => [{ sourceType: 'rag', sourceName: 'FAQ', content: 'Para comprar, escolha o produto e envie seus dados.', score: 0.8 }],
      site: async () => [],
      file: async () => []
    });
    expect(result.action).not.toBe('handoff');
  });

  test('varejo ou atacado usa fonte ou pergunta modo de compra sem humano', async () => {
    const withSource = await run('Voce vende no varejo ou no atacado?', {
      rag: async () => [{ sourceType: 'rag', sourceName: 'Politica comercial', content: 'Vendemos no varejo e no atacado.', score: 0.92 }],
      site: async () => [],
      file: async () => []
    });
    expect(withSource.result.action).toBe('send');
    expect(withSource.result.response).toMatch(/varejo|atacado/i);
    expect(withSource.result.response).not.toMatch(bannedHumanSuggestion);

    const withoutSource = await run('Voce vende no varejo ou no atacado?', {
      rag: async () => [],
      site: async () => [],
      file: async () => []
    });
    expect(withoutSource.result.action).not.toBe('handoff');
    expect(withoutSource.result.response).toMatch(/uso proprio|quantidade/i);
    expect(withoutSource.result.response).not.toMatch(bannedHumanSuggestion);
  });

  test('mais opcoes usa historico quando existe e nao manda fallback antes dos cards', async () => {
    const history = [{ direction: 'in', content: 'Tem roupa da Hello Kitty tamanho 4?' }];
    const { result, logs } = await run('Me de mais opcoes.', {
      catalog: async () => [{
        sourceType: 'catalog',
        sourceName: 'Catalogo',
        content: 'Titulo: Baby look Hello Kitty\nTamanhos com estoque: 4',
        score: 0.95,
        metadata: {
          lookupAttempted: true,
          productsFound: true,
          productCards: [{ title: 'Baby look Hello Kitty', description: 'Tam 4', imageUrl: 'https://example.com/hk.jpg', url: 'https://example.com/hk' }]
        }
      }],
      rag: async () => [],
      site: async () => []
    }, history);
    expect(result.action).toBe('send');
    expect(result.product_cards).toHaveLength(1);
    expect(logs.join('\n')).not.toMatch(/nao encontrei|seguranca|atendente|humano/i);
  });

  test('mais opcoes sem historico pergunta contexto sem humano', async () => {
    const { result } = await run('Me de mais opcoes.');
    expect(result.action).toBe('clarify');
    expect(result.response).toMatch(/qual produto|categoria|tamanho|cor/i);
    expect(result.response).not.toMatch(bannedHumanSuggestion);
  });

  test('pergunta ambigua pede esclarecimento', async () => {
    const { result } = await run('Tem disponivel?');
    expect(result.action).toBe('clarify');
    expect(result.response).toMatch(/qual produto/i);
  });

  test('ambiguidade entre agentes bloqueia resposta mesmo com evidencia', async () => {
    const { result } = await run('preciso resolver uma situacao', {
      rag: async () => [{ sourceType: 'rag', sourceName: 'FAQ', content: 'A retirada e feita somente com agendamento.', score: 0.9 }],
      site: async () => [],
      file: async () => []
    }, [], {
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
    });

    expect(result.action).toBe('clarify');
    expect(result.response).toMatch(/produto|pedido|pagamento|agendamento|duvida geral/i);
    expect(result.response).not.toMatch(/retirada.*agendamento/i);
  });

  test('falha de API nao inventa e nao chama humano', async () => {
    const { result } = await run('Qual o status do meu pedido 12345?', {
      api: async () => { throw new Error('timeout'); },
      rag: async () => [],
      site: async () => [],
      file: async () => []
    }, [], {
      product_integrations: [{ id: 'pedidos-api', api_endpoint: 'https://api.example.com', enabled: true }]
    });
    expect(result.action).not.toBe('handoff');
    expect(result.response).toMatch(/nao consegui consultar|numero do pedido/i);
  });

  test('agente financeiro nao responde com politica generica quando API critica nao esta configurada', async () => {
    const { result } = await run('Ja paguei no Pix, meu pedido foi liberado?', {
      rag: async () => [{ sourceType: 'rag', sourceName: 'Politica', content: 'O pagamento pode ser feito por Pix ou cartao.', score: 0.92 }],
      site: async () => [],
      file: async () => []
    });

    expect(result.action).toBe('clarify');
    expect(result.response).toMatch(/numero do pedido/i);
    expect(result.response).not.toMatch(/pagamento pode ser feito|Pix ou cartao/i);
    expect(result.validation.reason).toMatch(/fonte critica.*api/i);
  });

  test('fluxo nao emite planner antes de retrieval', async () => {
    const { logs } = await run('Voces aceitam pix?', {
      rag: async () => [{ sourceType: 'rag', sourceName: 'Politica', content: 'O pagamento e por Pix ou cartao.', score: 0.9 }],
      site: async () => [],
      file: async () => []
    });
    const joined = logs.join('\n');
    expect(joined).not.toMatch(/PLANNER|planner_semantic_evidence/i);
    expect(joined.indexOf('[RETRIEVAL STARTED]')).toBeGreaterThan(joined.indexOf('[SOURCE DECISION]'));
    expect(joined.indexOf('[ANSWER COMPOSER]')).toBeGreaterThan(joined.indexOf('[RETRIEVAL STARTED]'));
  });

  test('generateAIResponse retorna pelo novo agente antes do fluxo legado', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/aiService.js'), 'utf8');
    const groundedCall = source.indexOf('const groundedResult = await runRetrievalGroundedAgent');
    const groundedReturn = source.indexOf('return groundedResult;', groundedCall);
    expect(groundedCall).toBeGreaterThan(-1);
    expect(groundedReturn).toBeGreaterThan(groundedCall);
    const generateStart = source.indexOf('async function generateAIResponse');
    const generateEnd = source.indexOf('module.exports =', generateStart);
    const generateBody = source.slice(generateStart, generateEnd);
    expect(generateBody).not.toMatch(/answerPlannerShadowMode|resolveStorePolicyWithPlanner|classifyCustomerIntent\(|callOpenAI\(|callClaude\(|plannerShadowResult/);
  });

  test('media-only nao responde por LLM direto fora do novo agente', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/aiService.js'), 'utf8');
    const mediaStart = source.indexOf('if (mediaOnlyMessage)');
    const groundedStart = source.indexOf('const groundedResult = await runRetrievalGroundedAgent', mediaStart);
    const mediaSegment = source.slice(mediaStart, groundedStart);
    expect(mediaSegment).not.toMatch(/callOpenAI\(|callClaude\(/);
    expect(mediaSegment).toMatch(/transcribeOpenAIMedia/);
    expect(source).toMatch(/midia\|m.dia\|media/);
    expect(mediaSegment).toMatch(/skipped:\s*true/);
  });

  test('placeholder de midia sem transcricao nao vira busca nem ecoa historico', async () => {
    const history = [
      { direction: 'in', content: '[Audio]' },
      { direction: 'out', content: 'Ok, vou separar todos os produtos Adidas disponiveis no tamanho 8 para voce.' },
      { direction: 'in', content: '[Midia]' }
    ];
    const { result } = await run('[Midia]', {
      rag: async () => [],
      site: async () => [],
      file: async () => []
    }, history);
    expect(result.action).not.toBe('send');
    expect(result.response).not.toMatch(/Cliente:|IA:|vou separar|Adidas disponiveis/i);
  });

  test('historico da conversa nao pode ser usado como resposta final', async () => {
    const history = [
      { direction: 'in', content: 'Vende no atacado e no varejo?' },
      { direction: 'out', content: 'Confirmando: vendemos no varejo e atacado, sem pedido minimo.' }
    ];
    const { result } = await run('Vende no atacado e no varejo?', {
      rag: async () => [],
      site: async () => [],
      file: async () => []
    }, history);
    expect(result.action).not.toBe('send');
    expect(result.response).toMatch(/uso proprio|quantidade/i);
    expect(result.response).not.toMatch(/Confirmando|Cliente:|IA:/i);
  });

  test('politica simples usa evidencia oficial configurada sem pedir esclarecimento', async () => {
    const officialConfig = 'Prompt/configuracao do cliente:\nVendemos no varejo e no atacado. Nao existe pedido minimo. O pagamento e por Pix ou cartao.';
    const wholesale = await run('Voces vendem no varejo e atacado?', {
      rag: async () => [],
      file: async () => [{ sourceType: 'file', sourceName: 'prompt configurado', content: officialConfig, score: 0.9, metadata: { officialConfig: true } }],
      site: async () => []
    });
    expect(wholesale.result.action).toBe('send');
    expect(wholesale.result.response).toMatch(/varejo|atacado/i);
    expect(wholesale.result.response).not.toMatch(/qual situacao|misturar informacoes|uso proprio|quantidade/i);

    const pix = await run('Voce aceita Pix?', {
      rag: async () => [],
      file: async () => [{ sourceType: 'file', sourceName: 'prompt configurado', content: officialConfig, score: 0.9, metadata: { officialConfig: true } }],
      site: async () => []
    });
    expect(pix.result.action).toBe('send');
    expect(pix.result.response).toMatch(/Pix|cartao/i);
    expect(pix.result.response).not.toMatch(/qual situacao|misturar informacoes/i);
  });

  test('logs nao contem nomes proibidos de planner/handoff automatico', () => {
    const root = path.resolve(__dirname, '..');
    const files = [
      'src/agent/whatsapp-agent.orchestrator.js',
      'src/logs/structured-logger.js',
      'src/services/aiService.js'
    ].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    expect(files).not.toMatch(/PLANNER ACTIVE ANSWER|planner_semantic_evidence|POLICY TOPIC SELECTED|CATEGORY POLICY ROUTE|LOW CONFIDENCE HANDOFF|AUTO HUMAN HANDOFF|PRODUCT PLANNER ANSWER|PRE RAG ANSWER/);
  });

  test('router avalia tudo, mas source decision nao consulta API nem catalogo sem necessidade', async () => {
    const route = await lightweightRouter.route({ text: 'Voces aceitam Pix?' });
    expect(route).toEqual(expect.objectContaining({
      needsRag: true,
      needsApi: false,
      needsCatalog: false,
      needsSite: true,
      needsFiles: true,
      needsConversationMemory: true,
      needsHuman: false,
      explicitHumanRequest: false
    }));
    const plan = sourceDecision.build({ message: { text: 'Voces aceitam Pix?' }, route });
    expect(plan.executeSources).not.toContain('api');
    expect(plan.executeSources).not.toContain('catalog');
  });

  test('router nao executa fontes diretamente', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/router/lightweight-router.js'), 'utf8');
    expect(source).not.toMatch(/ragService|apiToolExecutor|catalogTool|fileRetriever|siteRetriever|retrieve\(/);
  });

  test('baixa confianca nao chama humano', async () => {
    const { result } = await run('Voces fazem entrega especial nesse caso?', {
      rag: async () => [],
      site: async () => [],
      file: async () => []
    });
    expect(result.action).not.toBe('handoff');
  });

  test('ausencia de cidade gera pergunta objetiva', async () => {
    const { result } = await run('Isso vale para minha cidade?', {
      rag: async () => [],
      site: async () => [],
      file: async () => []
    });
    expect(result.action).toBe('clarify');
    expect(result.response).toMatch(/cidade/i);
  });

  test('needsHuman so e true com pedido explicito', async () => {
    const route = await lightweightRouter.route({ text: 'Nao achei o que eu queria' });
    expect(route.explicitHumanRequest).toBe(false);
    expect(route.needsHuman).toBe(false);
  });

  test('handoff so com pedido explicito', async () => {
    const { result } = await run('Nao achei o que eu queria');
    expect(result.action).not.toBe('handoff');
  });

  test('pedido explicito de humano prevalece imediatamente', async () => {
    const { result } = await run('Nao quero falar com robo, quero uma pessoa');
    expect(result.action).toBe('handoff');
  });

  test('trava de duplicidade permite apenas o primeiro envio por messageId', () => {
    const registry = createResponseRegistry();
    const first = registry.canSendResponse('msg-1');
    const second = registry.canSendResponse('msg-1');
    expect(first).toEqual({ allowed: true, sendCountForMessage: 1 });
    expect(second.allowed).toBe(false);
    expect(second.sendCountForMessage).toBe(2);
  });

  test('sendAIAutoReply nao faz fallback de album nem texto separado depois de cards', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../server-baileys.js'), 'utf8');
    const start = source.indexOf('async function sendAIAutoReply');
    const end = source.indexOf('async function getAIReplyDelayMs', start);
    const body = source.slice(start, end);
    expect(body).toMatch(/canSendResponse/);
    expect(body).toMatch(/\[WHATSAPP SEND\]/);
    expect(body).toMatch(/\[BLOCKED DUPLICATE SEND\]/);
    expect(body).not.toMatch(/sendRemoteImageMessage/);
    expect(body.match(/sendTextMessage/g) || []).toHaveLength(2);
    expect(body.match(/sendCarouselMessage/g) || []).toHaveLength(1);
  });

  test('respostas nao sugerem humano exceto quando ha pedido explicito', async () => {
    const cases = [
      await run('Voces entregam em Marte?', { rag: async () => [], site: async () => [], file: async () => [] }),
      await run('Me de mais opcoes.'),
      await run('Voce vende no varejo ou no atacado?', { rag: async () => [], site: async () => [], file: async () => [] }),
      await run('Tem disponivel?')
    ];
    for (const item of cases) {
      expect(item.result.route.explicitHumanRequest).toBe(false);
      expect(item.result.response).not.toMatch(bannedHumanSuggestion);
    }
  });
});
