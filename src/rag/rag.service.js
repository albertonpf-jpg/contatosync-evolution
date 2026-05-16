async function retrieveRagEvidence({ query = '', adapter } = {}) {
  if (typeof adapter !== 'function') return [];
  return adapter({ query });
}

module.exports = {
  retrieveRagEvidence
};
