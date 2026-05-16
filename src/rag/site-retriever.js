async function retrieveSiteEvidence({ query = '', adapter } = {}) {
  if (typeof adapter !== 'function') return [];
  return adapter({ query });
}

module.exports = {
  retrieveSiteEvidence
};
