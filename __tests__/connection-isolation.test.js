const { buildConnectionIsolation } = require('../src/services/connectionIsolationService');

describe('Connection isolation service', () => {
  test('defaults to shared worker group', () => {
    const isolation = buildConnectionIsolation({ clientId: 'client-1', sessionName: 'evo_main' });

    expect(isolation.mode).toBe('shared');
    expect(isolation.status).toBe('ready');
    expect(isolation.workerGroup).toBe('shared-baileys');
  });

  test('marks dedicated mode pending until egress infra exists', () => {
    const isolation = buildConnectionIsolation({
      clientId: 'client-1',
      sessionName: 'evo_main',
      config: { isolation_settings: { mode: 'dedicated' } }
    });

    expect(isolation.isolated).toBe(true);
    expect(isolation.status).toBe('pending_infra');
    expect(isolation.workerGroup).toBe('client-client-1');
  });

  test('accepts proxy or egress assignment as ready isolation', () => {
    const isolation = buildConnectionIsolation({
      clientId: 'client-1',
      sessionName: 'evo_main',
      config: { isolation_settings: { mode: 'proxy', proxy_url: 'http://proxy.local:8080', egress_ip: '203.0.113.10' } }
    });

    expect(isolation.status).toBe('ready');
    expect(isolation.proxyConfigured).toBe(true);
    expect(isolation.egressIp).toBe('203.0.113.10');
  });
});
