const queryRewriter = require('../src/retrieval/query-rewriter');

describe('Query rewriter', () => {
  test('uses semantic planner search query before local context heuristics', async () => {
    const rewritten = await queryRewriter.rewrite({
      message: {
        text: 'Esses sao os mesmos, nao tem modelos diferentes?',
        conversationHistory: [
          { direction: 'in', content: 'Tem mais modelos de tenis?' }
        ]
      },
      route: {
        intent: 'product',
        routerMode: 'semantic',
        semantic: {
          searchQuery: 'modelos diferentes de tenis infantil com foto'
        }
      },
      retrievalPlan: {}
    });

    expect(rewritten).toBe('modelos diferentes de tenis infantil com foto');
  });

  test('keeps previous product topic for different-model follow-up', async () => {
    const rewritten = await queryRewriter.rewrite({
      message: {
        text: 'Esses sao os mesmos, nao tem modelos diferentes?',
        conversationHistory: [
          { direction: 'in', content: 'Tem mais modelos de tenis?' },
          { direction: 'out', content: 'Encontrei este modelo no catalogo: Tenis adidas samba hello kitty.' }
        ]
      },
      route: { intent: 'product' },
      retrievalPlan: {}
    });

    expect(rewritten).toContain('Tem mais modelos de tenis?');
    expect(rewritten).toContain('Esses sao os mesmos');
  });
});
