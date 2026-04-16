const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 8080;

// Middleware
app.use(cors());
app.use(express.json());

// Mock data storage - limpar cache
const instances = {};
const qrcodes = {};

// Limpar dados antigos
console.log('🔥 Mock Evolution API inicializado - cache limpo');

// Health check
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

  // QR Code será gerado no endpoint, não aqui
  console.log(`📱 Instância ${instanceName} criada - QR será gerado no endpoint`);

  res.json({
    instance: instances[instanceName],
    hash: 'mock-hash-' + instanceName,
    status: 'created'
  });
});

// Get QR Code
app.get('/instance/connect/:instanceName', (req, res) => {
  const { instanceName } = req.params;

  console.log(`📱 Solicitando QR Code: ${instanceName}`);

  if (!instances[instanceName]) {
    return res.status(404).json({ error: 'Instance not found' });
  }

  // QR Code teste simples que sempre funciona
  const qrCode = 'data:image/svg+xml;charset=utf-8,%3Csvg width="200" height="200" xmlns="http://www.w3.org/2000/svg"%3E%3Crect width="200" height="200" fill="white" stroke="black" stroke-width="2"/%3E%3Crect x="20" y="20" width="30" height="30" fill="black"/%3E%3Crect x="60" y="20" width="30" height="30" fill="white"/%3E%3Crect x="100" y="20" width="30" height="30" fill="black"/%3E%3Ctext x="100" y="120" font-family="Arial" font-size="16" text-anchor="middle" fill="black"%3EMOCK QR%3C/text%3E%3C/svg%3E';

  console.log(`📱 QR Code gerado para: ${instanceName}`);

  res.json({
    base64: qrCode,
    code: qrCode,
    qr: qrCode,
    qrcode: qrCode,
    instance: instances[instanceName]
  });
});

// Get connection status
app.get('/instance/connectionState/:instanceName', (req, res) => {
  const { instanceName } = req.params;

  if (!instances[instanceName]) {
    return res.status(404).json({ error: 'Instance not found' });
  }

  res.json({
    instance: {
      instanceName,
      state: instances[instanceName].state || 'close'
    }
  });
});

// Send message
app.post('/message/sendText/:instanceName', (req, res) => {
  const { instanceName } = req.params;
  const { number, textMessage } = req.body;

  console.log(`📤 Enviando mensagem via ${instanceName} para ${number}: ${textMessage.text}`);

  if (!instances[instanceName]) {
    return res.status(404).json({ error: 'Instance not found' });
  }

  res.json({
    key: {
      remoteJid: number + '@s.whatsapp.net',
      fromMe: true,
      id: 'mock-message-' + Date.now()
    },
    message: {
      conversation: textMessage.text
    },
    messageTimestamp: Math.floor(Date.now() / 1000),
    status: 'PENDING'
  });
});

// List instances
app.get('/instance/fetchInstances', (req, res) => {
  res.json(Object.values(instances));
});

// Delete instance
app.delete('/instance/delete/:instanceName', (req, res) => {
  const { instanceName } = req.params;

  console.log(`🗑️ Deletando instância: ${instanceName}`);

  delete instances[instanceName];
  delete qrcodes[instanceName];

  res.json({ message: 'Instance deleted successfully' });
});

// Simulate connection after QR scan (mock)
app.post('/mock/connect/:instanceName', (req, res) => {
  const { instanceName } = req.params;

  if (instances[instanceName]) {
    instances[instanceName].state = 'open';
    console.log(`✅ Instância conectada (mock): ${instanceName}`);

    // Simulate webhook call
    setTimeout(() => {
      console.log(`📞 Enviando webhook de conexão para: ${instanceName}`);
      // Here we would call the webhook URL
    }, 1000);
  }

  res.json({ status: 'connected' });
});

app.listen(PORT, () => {
  console.log(`🚀 Evolution API Mock rodando na porta ${PORT}`);
  console.log(`📖 Endpoints disponíveis:`);
  console.log(`   GET  /health`);
  console.log(`   POST /instance/create`);
  console.log(`   GET  /instance/connect/:instanceName`);
  console.log(`   GET  /instance/connectionState/:instanceName`);
  console.log(`   POST /message/sendText/:instanceName`);
  console.log(`   GET  /instance/fetchInstances`);
  console.log(`   DELETE /instance/delete/:instanceName`);
  console.log(`   POST /mock/connect/:instanceName (para simular conexão)`);
});