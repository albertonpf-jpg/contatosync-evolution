const { normalizeAIQueueSettings } = require('../src/services/aiAutoReplyQueueSettings');

describe('AI auto reply queue settings', () => {
  test('uses safe defaults when no queue settings are configured', () => {
    expect(normalizeAIQueueSettings()).toEqual({
      max_parallel_per_client: 1,
      max_parallel_per_session: 1,
      idle_collapse_seconds: 8
    });
  });

  test('uses reply delay as idle collapse fallback', () => {
    expect(normalizeAIQueueSettings({}, 12).idle_collapse_seconds).toBe(12);
  });

  test('clamps concurrency and idle collapse limits', () => {
    expect(normalizeAIQueueSettings({
      max_parallel_per_client: 99,
      max_parallel_per_session: 99,
      idle_collapse_seconds: 0
    }, 6)).toEqual({
      max_parallel_per_client: 5,
      max_parallel_per_session: 3,
      idle_collapse_seconds: 1
    });
  });
});
