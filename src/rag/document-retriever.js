async function retrieveDocumentEvidence({ query = '', adapter } = {}) {
  if (typeof adapter !== 'function') return [];
  return adapter({ query });
}

module.exports = {
  retrieveDocumentEvidence
};
