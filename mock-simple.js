const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 8081;

app.use(cors());
app.use(express.json());

const instances = {};

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'Evolution API Mock' });
});

// Create instance
app.post('/instance/create', (req, res) => {
  const { instanceName } = req.body;
  console.log(`📱 Criando instância: ${instanceName}`);

  instances[instanceName] = {
    instanceName,
    status: 'created',
    state: 'close',
    createdAt: new Date().toISOString()
  };

  res.json({
    instance: instances[instanceName],
    hash: 'mock-hash-' + instanceName,
    status: 'created'
  });
});

// Get QR Code - SEMPRE RETORNA QR VISÍVEL
app.get('/instance/connect/:instanceName', (req, res) => {
  const { instanceName } = req.params;

  console.log(`📱 QR Code solicitado: ${instanceName}`);

  if (!instances[instanceName]) {
    return res.status(404).json({ error: 'Instance not found' });
  }

  // SVG QR Code simples e visível
  const svgQR = `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
    <rect width="200" height="200" fill="#f0f0f0" stroke="#333" stroke-width="2"/>
    <rect x="20" y="20" width="25" height="25" fill="black"/>
    <rect x="55" y="20" width="25" height="25" fill="white"/>
    <rect x="90" y="20" width="25" height="25" fill="black"/>
    <rect x="125" y="20" width="25" height="25" fill="white"/>
    <rect x="160" y="20" width="25" height="25" fill="black"/>

    <rect x="20" y="55" width="25" height="25" fill="white"/>
    <rect x="55" y="55" width="25" height="25" fill="black"/>
    <rect x="90" y="55" width="25" height="25" fill="white"/>
    <rect x="125" y="55" width="25" height="25" fill="black"/>
    <rect x="160" y="55" width="25" height="25" fill="white"/>

    <text x="100" y="120" font-family="Arial,sans-serif" font-size="14" text-anchor="middle" fill="black">MOCK QR CODE</text>
    <text x="100" y="140" font-family="Arial,sans-serif" font-size="10" text-anchor="middle" fill="gray">${instanceName}</text>
    <text x="100" y="160" font-family="Arial,sans-serif" font-size="10" text-anchor="middle" fill="gray">Escaneie para teste</text>
  </svg>`;

  const base64SVG = 'data:image/svg+xml;base64,' + Buffer.from(svgQR).toString('base64');

  console.log(`✅ QR Code gerado: ${instanceName}`);

  res.json({
    base64: base64SVG,
    qr: base64SVG,
    qrcode: base64SVG,
    code: base64SVG,
    instance: instances[instanceName]
  });
});

// Connection status
app.get('/instance/connectionState/:instanceName', (req, res) => {
  const { instanceName } = req.params;

  if (!instances[instanceName]) {
    return res.status(404).json({ error: 'Instance not found' });
  }

  res.json({
    instance: {
      state: 'close',
      status: 'disconnected'
    }
  });
});

// Send message
app.post('/message/sendText/:instanceName', (req, res) => {
  const { instanceName } = req.params;
  console.log(`📨 Enviando mensagem via ${instanceName}`);

  res.json({
    key: { id: 'mock-message-id' },
    status: 'success',
    message: 'Message sent successfully'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Mock Evolution API rodando na porta ${PORT}`);
  console.log(`📱 Pronto para gerar QR Codes visíveis!`);
});