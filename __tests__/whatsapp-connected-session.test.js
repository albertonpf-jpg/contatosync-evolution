const {
  resolveConnectedWhatsAppSession,
  buildNoConnectedSessionError
} = require('../src/services/whatsappConnectedSession');

describe('WhatsApp connected session resolver', () => {
  test('selects only an open or connected Baileys session', () => {
    const service = {
      getSessionStatus: jest.fn((name) => {
        if (name === 'evo_closed') return { state: 'close', status: 'disconnected' };
        if (name === 'evo_open') return { state: 'open', status: 'connected' };
        return { state: 'connecting', status: 'qr_ready' };
      })
    };

    const selected = resolveConnectedWhatsAppSession([
      { session_name: 'evo_closed' },
      { session_name: 'evo_open' }
    ], service);

    expect(selected.sessionName).toBe('evo_open');
  });

  test('does not fall back to a disconnected session', () => {
    const selected = resolveConnectedWhatsAppSession([
      { session_name: 'evo_closed' },
      { session_name: 'evo_qr' }
    ], {
      getSessionStatus: () => ({ state: 'close', status: 'disconnected' })
    });

    expect(selected).toBeNull();
    expect(buildNoConnectedSessionError([{ session_name: 'evo_closed' }])).toMatchObject({
      statusCode: 409,
      code: 'WHATSAPP_SESSION_NOT_CONNECTED'
    });
  });
});
