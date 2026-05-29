const { waitForSendSlot, getSendPolicySnapshot } = require('../src/services/whatsappSendPolicy');

describe('WhatsApp send policy', () => {
  test('tracks sends per client session', async () => {
    const result = await waitForSendSlot({
      clientId: 'client-policy-1',
      sessionName: 'evo_main',
      policy: { minIntervalMs: 0, burstLimit: 3, dailyLimit: 3 },
      source: 'test'
    });

    expect(result.sessionName).toBe('evo_main');
    expect(result.dayCount).toBeGreaterThanOrEqual(1);

    const snapshot = getSendPolicySnapshot();
    expect(snapshot.sessions.some(session => session.key === 'client-policy-1:evo_main')).toBe(true);
  });

  test('blocks when burst limit is exceeded', async () => {
    const policy = { minIntervalMs: 0, burstLimit: 1, burstWindowMs: 60_000, dailyLimit: 10 };

    await waitForSendSlot({
      clientId: 'client-policy-2',
      sessionName: 'evo_main',
      policy,
      source: 'test'
    });

    await expect(waitForSendSlot({
      clientId: 'client-policy-2',
      sessionName: 'evo_main',
      policy,
      source: 'test'
    })).rejects.toMatchObject({ code: 'WHATSAPP_BURST_LIMIT' });
  });

  test('serializes concurrent sends for the same session', async () => {
    const startedAt = Date.now();

    await Promise.all([
      waitForSendSlot({
        clientId: 'client-policy-3',
        sessionName: 'evo_main',
        policy: { minIntervalMs: 20, burstLimit: 5, dailyLimit: 5 },
        source: 'test'
      }),
      waitForSendSlot({
        clientId: 'client-policy-3',
        sessionName: 'evo_main',
        policy: { minIntervalMs: 20, burstLimit: 5, dailyLimit: 5 },
        source: 'test'
      })
    ]);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
  });
});
