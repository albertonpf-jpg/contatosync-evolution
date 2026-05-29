const EMPTY_SNAPSHOT = {
  timers: [],
  processingQueues: [],
  clientConcurrency: [],
  metrics: {
    enqueued: 0,
    processed: 0,
    failed: 0,
    lastError: '',
    lastProcessedAt: null
  }
};

let snapshotProvider = () => EMPTY_SNAPSHOT;

function registerAIAutoReplyQueueSnapshotProvider(provider) {
  if (typeof provider === 'function') {
    snapshotProvider = provider;
  }
}

function getAIAutoReplyQueueSnapshot() {
  try {
    return snapshotProvider() || EMPTY_SNAPSHOT;
  } catch (error) {
    return {
      ...EMPTY_SNAPSHOT,
      metrics: {
        ...EMPTY_SNAPSHOT.metrics,
        lastError: String(error?.message || error).slice(0, 500)
      }
    };
  }
}

module.exports = {
  registerAIAutoReplyQueueSnapshotProvider,
  getAIAutoReplyQueueSnapshot
};
