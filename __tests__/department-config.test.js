const { normalizeDepartmentConfig, getDepartmentSettings } = require('../src/agent/department-config');

describe('Department config', () => {
  test('returns defaults when client has no custom department config', () => {
    const config = normalizeDepartmentConfig({});

    expect(config.sales.enabled).toBe(true);
    expect(config.support.name).toBe('Atendimento');
    expect(config.billing.maxEvidence).toBeGreaterThan(0);
  });

  test('normalizes custom department objectives and keyword lists', () => {
    const config = normalizeDepartmentConfig({
      department_agent_config: {
        sales: {
          enabled: false,
          name: 'Vendas consultivas',
          objective: 'Priorizar catalogo e conversao.',
          boundaryRules: 'nao tratar pedidos pagos\nnao resolver cobranca',
          exclusionExamples: 'meu pedido saiu?, paguei no pix',
          handoffKeywords: 'desconto, gerente',
          maxEvidence: 99
        }
      }
    });

    expect(config.sales.enabled).toBe(false);
    expect(config.sales.name).toBe('Vendas consultivas');
    expect(config.sales.boundaryRules).toEqual(['nao tratar pedidos pagos', 'nao resolver cobranca']);
    expect(config.sales.exclusionExamples).toEqual(['meu pedido saiu?', 'paguei no pix']);
    expect(config.sales.handoffKeywords).toEqual(['desconto', 'gerente']);
    expect(config.sales.maxEvidence).toBe(10);
    expect(config.sales.sourcePriority).toContain('catalog');
    expect(config.sales.responseRules.length).toBeGreaterThan(0);
  });

  test('drops invalid intents and sources from custom department config', () => {
    const config = normalizeDepartmentConfig({
      department_agent_config: {
        billing: {
          intents: ['billing', 'delete_everything'],
          allowedSources: ['api', 'unknown_tool', 'files'],
          sourcePriority: ['unknown_tool', 'api', 'file']
        }
      }
    });

    expect(config.billing.intents).toEqual(['billing']);
    expect(config.billing.allowedSources).toEqual(['api', 'file']);
    expect(config.billing.sourcePriority).toEqual(['api', 'file']);
  });

  test('gets one department settings with fallback to support', () => {
    expect(getDepartmentSettings({}, 'missing').name).toBe('Atendimento');
  });
});
