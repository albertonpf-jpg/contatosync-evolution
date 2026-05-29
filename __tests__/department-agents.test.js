const { selectDepartmentAgent } = require('../src/agent/departments');

describe('Department agents', () => {
  test.each([
    ['product', 'sales'],
    ['policy', 'support'],
    ['faq', 'support'],
    ['billing', 'billing'],
    ['order_status', 'billing'],
    ['scheduling', 'scheduling'],
    ['human_request', 'handoff'],
    ['unknown', 'support']
  ])('routes %s intent to %s department', (intent, expectedDepartment) => {
    expect(selectDepartmentAgent({ intent }).id).toBe(expectedDepartment);
  });

  test('sales department keeps catalog before static knowledge', () => {
    const agent = selectDepartmentAgent({
      intent: 'product',
      needsCatalog: true,
      needsRag: true,
      needsSite: true,
      needsFiles: false,
      needsConversationMemory: true,
      blockedSources: []
    });

    const plan = agent.buildRetrievalPlan({
      message: { text: 'Tem vestido vermelho?' },
      route: {
        intent: 'product',
        needsCatalog: true,
        needsRag: true,
        needsSite: true,
        needsFiles: false,
        needsConversationMemory: true,
        blockedSources: []
      }
    });

    expect(plan.executeSources[0]).toBe('catalog');
    expect(plan.departmentReason).toMatch(/vendas/i);
  });
});
