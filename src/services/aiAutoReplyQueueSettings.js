const DEFAULT_AI_QUEUE_SETTINGS = {
  max_parallel_per_client: 1,
  max_parallel_per_session: 1,
  idle_collapse_seconds: 8
};

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function normalizeAIQueueSettings(rawSettings = {}, replyDelaySeconds = DEFAULT_AI_QUEUE_SETTINGS.idle_collapse_seconds) {
  const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
  const fallbackDelay = clampInteger(replyDelaySeconds, DEFAULT_AI_QUEUE_SETTINGS.idle_collapse_seconds, 1, 60);

  return {
    max_parallel_per_client: clampInteger(
      source.max_parallel_per_client,
      DEFAULT_AI_QUEUE_SETTINGS.max_parallel_per_client,
      1,
      5
    ),
    max_parallel_per_session: clampInteger(
      source.max_parallel_per_session,
      DEFAULT_AI_QUEUE_SETTINGS.max_parallel_per_session,
      1,
      3
    ),
    idle_collapse_seconds: clampInteger(
      source.idle_collapse_seconds,
      fallbackDelay,
      1,
      60
    )
  };
}

module.exports = {
  DEFAULT_AI_QUEUE_SETTINGS,
  normalizeAIQueueSettings
};
