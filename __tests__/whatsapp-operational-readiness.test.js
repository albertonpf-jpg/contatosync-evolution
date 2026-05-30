const { buildWhatsAppOperationalReadiness } = require('../src/services/whatsappOperationalReadiness');

describe('WhatsApp operational readiness', () => {
  test('marks ready when Baileys runtime has an open session', () => {
    const readiness = buildWhatsAppOperationalReadiness([
      { id: '1', session_name: 'evo_main', status: 'close' }
    ], {
      getSessionStatus: () => ({ state: 'open' })
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.status).toBe('ready');
    expect(readiness.counts.connected).toBe(1);
  });

  test('reports QR scan required before WhatsApp can serve production', () => {
    const readiness = buildWhatsAppOperationalReadiness([
      { id: '1', session_name: 'evo_main', status: 'qr_pending' }
    ], {
      getSessionStatus: () => ({ state: 'qr_pending', hasQR: true })
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.status).toBe('needs_qr_scan');
    expect(readiness.counts.pending).toBe(1);
  });

  test('reports no session when client has no WhatsApp session rows', () => {
    const readiness = buildWhatsAppOperationalReadiness([], {
      getSessionStatus: () => ({ state: 'open' })
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.status).toBe('no_session');
    expect(readiness.counts.total).toBe(0);
  });
});
