function getIsolationMode(config = {}) {
  const settings = config.isolation_settings || config.isolationSettings || {};
  return String(settings.mode || process.env.WHATSAPP_ISOLATION_MODE || 'shared').trim().toLowerCase();
}

function buildConnectionIsolation({ clientId, sessionName, config = {} } = {}) {
  const settings = config.isolation_settings || config.isolationSettings || {};
  const mode = getIsolationMode(config);
  const explicitProxy = String(settings.proxy_url || settings.proxyUrl || '').trim();
  const egressIp = String(settings.egress_ip || settings.egressIp || '').trim();
  const workerGroup = String(settings.worker_group || settings.workerGroup || '').trim();

  return {
    mode,
    clientId,
    sessionName,
    isolated: mode !== 'shared',
    egressIp: egressIp || null,
    proxyConfigured: Boolean(explicitProxy),
    workerGroup: workerGroup || (mode === 'shared' ? 'shared-baileys' : `client-${clientId}`),
    status: mode === 'dedicated' && !explicitProxy && !egressIp ? 'pending_infra' : 'ready',
    updatedAt: new Date().toISOString()
  };
}

module.exports = {
  buildConnectionIsolation,
  getIsolationMode
};
