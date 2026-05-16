async function retrieveFileEvidence({ query = '', adapter } = {}) {
  if (typeof adapter !== 'function') return [];
  return adapter({ query });
}

module.exports = {
  retrieveFileEvidence
};
