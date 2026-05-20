const { getDifyConfig } = require('../src/services/difyService');

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
