function createEvidence(overrides = {}) {
  return {
    sourceType: 'rag',
    sourceName: 'fonte',
    content: '',
    score: 0,
    metadata: {},
    isDynamic: false,
    ...overrides
  };
}

module.exports = {
  createEvidence
};
