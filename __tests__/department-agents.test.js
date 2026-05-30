const { getDepartmentRoutingMap, selectDepartmentAgent } = require('../src/agent/departments');

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

  test('falls back to support when selected department is disabled', () => {
    const agent = selectDepartmentAgent({ intent: 'product' }, {
      department_agent_config: {
        sales: { enabled: false }
      }
    });

    expect(agent.id).toBe('support');
  });

  test('sales department keeps catalog before static knowledge', async () => {
    const agent = selectDepartmentAgent({
      intent: 'product',
      needsCatalog: true,
      needsRag: true,
      needsSite: true,
      needsFiles: false,
      needsConversationMemory: true,
      blockedSources: []
    });

    const plan = await agent.buildRetrievalPlan({
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

  test('department source priority can be customized per client', async () => {
    const agent = selectDepartmentAgent({ intent: 'product' }, {
      department_agent_config: {
        sales: {
          sourcePriority: ['site', 'catalog', 'rag']
        }
      }
    });

    const plan = await agent.buildRetrievalPlan({
      message: { text: 'Tem vestido vermelho?' },
      route: {
        intent: 'product',
        needsCatalog: true,
        needsRag: true,
        needsSite: true,
        needsFiles: false,
        needsConversationMemory: false,
        blockedSources: []
      }
    });

    expect(plan.executeSources[0]).toBe('site');
    expect(plan.departmentSettings.sourcePriority).toEqual(['site', 'catalog', 'rag']);
  });

  test('exposes routing metadata for the configuration panel', () => {
    const routing = getDepartmentRoutingMap();

    expect(routing.sales.intents).toContain('product');
    expect(routing.billing.triggerSummary).toMatch(/pedido/i);
    expect(routing.handoff.triggerSummary).toMatch(/humano/i);
  });
});
