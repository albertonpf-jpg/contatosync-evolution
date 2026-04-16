const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const authRoutes = require('./src/routes/auth');
const clientsRoutes = require('./src/routes/clients');
const contactsRoutes = require('./src/routes/contacts');
const conversationsRoutes = require('./src/routes/conversations');
const messagesRoutes = require('./src/routes/messages');
const aiRoutes = require('./src/routes/ai');
const activitiesRoutes = require('./src/routes/activities');
const integrationsRoutes = require('./src/routes/integrations');
const sessionsRoutes = require('./src/routes/sessions');
const whatsappRoutes = require('./src/routes/whatsapp');
const webhooksRoutes = require('./src/routes/webhooks');

const { auth } = require('./src/middleware/auth');
const socketAuth = require('./src/middleware/socketAuth');
const { initializeSocket } = require('./src/services/socketService');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3003;

// Socket.IO com CORS
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Middleware básico - SEM RATE LIMITING
app.use(cors({
  origin: "*",
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

console.log('🚀 ContatoSync com BAILEYS na porta', PORT);
console.log('✅ WhatsApp direto, sem Evolution API');
console.log('📱 QR Codes nativos do Baileys');
console.log('🔓 Rate limiting REMOVIDO');

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    message: 'ContatoSync com Baileys - Completo',
    service: 'Baileys WhatsApp'
  });
});

// Rotas públicas
app.use('/api/auth', authRoutes);
app.use('/api/webhooks', webhooksRoutes);

// Rotas protegidas (todas com auth)
app.use('/api/clients', auth, clientsRoutes);
app.use('/api/contacts', auth, contactsRoutes);
app.use('/api/conversations', auth, conversationsRoutes);
app.use('/api/messages', auth, messagesRoutes);
app.use('/api/ai', auth, aiRoutes);
app.use('/api/activities', auth, activitiesRoutes);
app.use('/api/integrations', auth, integrationsRoutes);
app.use('/api/sessions', auth, sessionsRoutes);
app.use('/api/whatsapp', auth, whatsappRoutes);

// Socket.IO auth + init
io.use(socketAuth);
initializeSocket(io);

// Error handler
app.use((err, req, res, next) => {
  console.error('Erro:', err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado' });
});

server.listen(PORT, () => {
  console.log(`🌟 Servidor Baileys COMPLETO em http://localhost:${PORT}`);
  console.log('📡 WebSocket ativo');
  console.log('📱 Baileys ready para WhatsApp!');
});

module.exports = { app, server, io };