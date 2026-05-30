const evidenceRanker = require('../src/retrieval/evidence-ranker');

describe('Evidence ranker', () => {
  test('keeps product_api evidence for product questions', async () => {
    const result = await evidenceRanker.rank({
      message: { text: 'Quero conjunto tamanho 6' },
      route: { intent: 'product' },
      evidenceBundle: {
        evidence: [
          {
            sourceType: 'catalog',
            sourceName: 'catalogo',
            content: '',
            score: 0.35,
            metadata: { lookupAttempted: true, productsFound: false }
          },
          {
            sourceType: 'product_api',
            sourceName: 'RAG produto',
            content: 'Produto: Conjunto babadinho\nTamanhos: 6, 8, 10',
            score: 0.75
          }
        ],
        sourcesUsed: ['catalog', 'product_api']
      }
    });

    expect(result.topEvidence.map(item => item.sourceType)).toContain('product_api');
  });
});
