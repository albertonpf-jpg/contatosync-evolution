async function retrieveCatalogEvidence({ query = '', adapter } = {}) {
  if (typeof adapter !== 'function') return [];
  return adapter({ query });
}

module.exports = {
  retrieveCatalogEvidence
};
