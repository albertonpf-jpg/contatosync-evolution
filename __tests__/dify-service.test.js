const { getDifyConfig, parseDifyDecision } = require('../src/services/difyService');

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.AI_PROVIDER;
  delete process.env.AI_AGENT_PROVIDER;
  delete process.env.DIFY_ENABLED;
  delete process.env.DIFY_GLOBAL_ENABLED;
  delete process.env.DIFY_ALLOW_GLOBAL_APP_FALLBACK;
  delete process.env.DIFY_API_URL;
  delete process.env.DIFY_BASE_URL;
  delete process.env.DIFY_API_KEY;
  delete process.env.DIFY_TIMEOUT_MS;
  delete process.env.DIFY_FAILOVER_TO_LOCAL;
  delete process.env.DIFY_KEEP_CONVERSATION;
}

describe('Dify service configuration', () => {
  beforeEach(resetEnv);
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('stays disabled when neither platform nor client Dify config exists', () => {
    const config = getDifyConfig({});

    expect(config.enabled).toBe(false);
    expect(config.providerIsDify).toBe(false);
    expect(config.apiKey).toBe('');
  });

  test('uses hidden per-client Dify app credentials when provisioned', () => {
    process.env.DIFY_API_URL = 'https://dify.example.com';

    const config = getDifyConfig({
      dify_enabled: true,
      dify_api_key: 'app-client',
      dify_app_id: 'app-id',
      dify_provision_status: 'ready'
    });

    expect(config.enabled).toBe(true);
    expect(config.providerIsDify).toBe(true);
    expect(config.endpoint).toBe('https://dify.example.com/v1/chat-messages');
    expect(config.apiKey).toBe('app-client');
    expect(config.appId).toBe('app-id');
    expect(config.provisionStatus).toBe('ready');
  });

  test('does not use the shared platform app key unless fallback is explicitly allowed', () => {
    process.env.DIFY_API_URL = 'https://dify.example.com';
    process.env.DIFY_API_KEY = 'app-global';

    const blocked = getDifyConfig({});
    expect(blocked.enabled).toBe(true);
    expect(blocked.endpoint).toBe('https://dify.example.com/v1/chat-messages');
    expect(blocked.apiKey).toBe('');

    process.env.DIFY_ALLOW_GLOBAL_APP_FALLBACK = 'true';
    const allowed = getDifyConfig({});
    expect(allowed.apiKey).toBe('app-global');
  });
});

describe('Dify service decision parsing', () => {
  test('parses structured card decision from Dify', () => {
    const decision = parseDifyDecision(JSON.stringify({
      answer: 'Separei algumas opcoes para voce.',
      send_cards: true,
      card_policy: 'send_found_cards',
      cards: [
        {
          title: 'Moletom exemplo',
          description: 'Tamanho 4',
          url: 'https://loja.test/produto',
          imageUrl: 'https://loja.test/foto.jpg'
        }
      ],
      confidence: 'high'
    }));

    expect(decision.response).toBe('Separei algumas opcoes para voce.');
    expect(decision.sendCards).toBe(true);
    expect(decision.cardPolicy).toBe('send_found_cards');
    expect(decision.cards).toHaveLength(1);
  });

  test('keeps stock or policy answers as text-only when Dify does not request cards', () => {
    const decision = parseDifyDecision(JSON.stringify({
      answer: 'Esse modelo tem 2 unidades na cor nude.',
      send_cards: false,
      card_policy: 'none',
      cards: [],
      confidence: 'high'
    }));

    expect(decision.response).toBe('Esse modelo tem 2 unidades na cor nude.');
    expect(decision.sendCards).toBe(false);
    expect(decision.cardPolicy).toBe('none');
    expect(decision.cards).toEqual([]);
  });
});
