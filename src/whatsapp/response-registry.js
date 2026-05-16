const DEFAULT_RESPONSE_REGISTRY_TTL_MS = 30 * 60 * 1000;

function createResponseRegistry({ ttlMs = DEFAULT_RESPONSE_REGISTRY_TTL_MS } = {}) {
  const registry = new Map();

  function cleanup(now = Date.now()) {
    for (const [key, entry] of registry.entries()) {
      if (now - Number(entry.createdAt || 0) > ttlMs) registry.delete(key);
    }
  }

  function canSendResponse(messageId) {
    const key = String(messageId || '').trim();
    if (!key) return { allowed: true, sendCountForMessage: 1 };
    const now = Date.now();
    cleanup(now);
    const entry = registry.get(key);
    if (entry) {
      entry.attempts = Number(entry.attempts || 1) + 1;
      registry.set(key, entry);
      return { allowed: false, sendCountForMessage: entry.attempts };
    }
    registry.set(key, { createdAt: now, attempts: 1 });
    return { allowed: true, sendCountForMessage: 1 };
  }

  return {
    canSendResponse,
    cleanup,
    registry
  };
}

module.exports = {
  createResponseRegistry,
  DEFAULT_RESPONSE_REGISTRY_TTL_MS
};
