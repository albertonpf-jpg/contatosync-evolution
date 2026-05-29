const { resolveAIEngine } = require('../src/services/aiEngineSelector');

describe('AI engine selector', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AI_ENGINE;
    delete process.env.AI_AGENT_ENGINE;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('defaults to the internal local multi-agent engine', () => {
    const decision = resolveAIEngine({ config: {}, difyConfig: { enabled: false } });

    expect(decision.engine).toBe('local_multi_agent');
    expect(decision.useDify).toBe(false);
  });

  test('lets ContatoSync enable Dify internally for one client', () => {
    const decision = resolveAIEngine({
      config: { ai_engine: 'dify' },
      difyConfig: {
        enabled: true,
        endpoint: 'https://dify.example.com/v1/chat-messages',
        apiKey: 'app-client',
        failoverToLocal: true
      }
    });

    expect(decision.engine).toBe('dify');
    expect(decision.useDify).toBe(true);
    expect(decision.allowLocalFallback).toBe(true);
  });

  test('keeps existing Dify clients active when ai_engine was not migrated yet', () => {
    const decision = resolveAIEngine({
      config: {},
      difyConfig: {
        enabled: true,
        endpoint: 'https://dify.example.com/v1/chat-messages',
        apiKey: 'app-client'
      }
    });

    expect(decision.engine).toBe('dify');
    expect(decision.useDify).toBe(true);
  });

  test('local multi-agent setting overrides Dify credentials', () => {
    const decision = resolveAIEngine({
      config: { ai_engine: 'local_multi_agent' },
      difyConfig: {
        enabled: true,
        endpoint: 'https://dify.example.com/v1/chat-messages',
        apiKey: 'app-client'
      }
    });

    expect(decision.engine).toBe('local_multi_agent');
    expect(decision.useDify).toBe(false);
  });
});
