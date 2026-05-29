const sessionState = new Map();
const sessionLocks = new Map();

const DEFAULT_MIN_INTERVAL_MS = Number(process.env.WHATSAPP_SEND_MIN_INTERVAL_MS || 2500);
const DEFAULT_BURST_WINDOW_MS = Number(process.env.WHATSAPP_SEND_BURST_WINDOW_MS || 5 * 60 * 1000);
const DEFAULT_BURST_LIMIT = Number(process.env.WHATSAPP_SEND_BURST_LIMIT || 30);
const DEFAULT_DAILY_LIMIT = Number(process.env.WHATSAPP_SEND_DAILY_LIMIT || 800);

function getDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function getKey(clientId, sessionName) {
  return [clientId || 'unknown-client', sessionName || 'unknown-session'].join(':');
}

function getState(clientId, sessionName) {
  const key = getKey(clientId, sessionName);
  if (!sessionState.has(key)) {
    sessionState.set(key, {
      key,
      clientId,
      sessionName,
      lastSentAt: 0,
      day: getDayKey(),
      dayCount: 0,
      windowStartedAt: 0,
      windowCount: 0,
      queuedWaitMs: 0,
      blocked: 0
    });
  }
  return sessionState.get(key);
}

function normalizePolicy(policy = {}) {
  return {
    minIntervalMs: Math.max(0, Number(policy.minIntervalMs || policy.min_interval_ms || DEFAULT_MIN_INTERVAL_MS)),
    burstWindowMs: Math.max(1000, Number(policy.burstWindowMs || policy.burst_window_ms || DEFAULT_BURST_WINDOW_MS)),
    burstLimit: Math.max(1, Number(policy.burstLimit || policy.burst_limit || DEFAULT_BURST_LIMIT)),
    dailyLimit: Math.max(1, Number(policy.dailyLimit || policy.daily_limit || DEFAULT_DAILY_LIMIT))
  };
}

function resetCountersIfNeeded(state, now, policy) {
  const today = getDayKey(new Date(now));
  if (state.day !== today) {
    state.day = today;
    state.dayCount = 0;
  }
  if (!state.windowStartedAt || now - state.windowStartedAt > policy.burstWindowMs) {
    state.windowStartedAt = now;
    state.windowCount = 0;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function reserveSendSlot({ clientId, sessionName, policy, source } = {}) {
  const resolvedPolicy = normalizePolicy(policy);
  const state = getState(clientId, sessionName);
  const now = Date.now();

  resetCountersIfNeeded(state, now, resolvedPolicy);

  if (state.dayCount >= resolvedPolicy.dailyLimit) {
    state.blocked += 1;
    const err = new Error('Limite diario de envio atingido para esta sessao');
    err.code = 'WHATSAPP_DAILY_LIMIT';
    throw err;
  }

  if (state.windowCount >= resolvedPolicy.burstLimit) {
    state.blocked += 1;
    const err = new Error('Limite de rajada atingido para esta sessao');
    err.code = 'WHATSAPP_BURST_LIMIT';
    throw err;
  }

  const waitMs = Math.max(0, state.lastSentAt + resolvedPolicy.minIntervalMs - now);
  if (waitMs > 0) {
    state.queuedWaitMs += waitMs;
    console.log('[SEND POLICY] aguardando ' + waitMs + 'ms | session=' + sessionName + ' | source=' + (source || 'unknown'));
    await sleep(waitMs);
  }

  const sentAt = Date.now();
  resetCountersIfNeeded(state, sentAt, resolvedPolicy);
  state.lastSentAt = sentAt;
  state.dayCount += 1;
  state.windowCount += 1;

  return {
    sessionName,
    sentAt: new Date(sentAt).toISOString(),
    dayCount: state.dayCount,
    windowCount: state.windowCount
  };
}

async function waitForSendSlot(options = {}) {
  const key = getKey(options.clientId, options.sessionName);
  const previous = sessionLocks.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => reserveSendSlot(options));
  sessionLocks.set(key, next.catch(() => {}));
  return next;
}

function getSendPolicySnapshot() {
  return {
    defaults: normalizePolicy(),
    sessions: Array.from(sessionState.values()).map(state => ({
      key: state.key,
      clientId: state.clientId,
      sessionName: state.sessionName,
      lastSentAt: state.lastSentAt ? new Date(state.lastSentAt).toISOString() : null,
      day: state.day,
      dayCount: state.dayCount,
      windowCount: state.windowCount,
      queuedWaitMs: state.queuedWaitMs,
      blocked: state.blocked
    }))
  };
}

module.exports = {
  waitForSendSlot,
  getSendPolicySnapshot,
  normalizePolicy
};
