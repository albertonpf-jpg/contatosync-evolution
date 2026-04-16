const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
// const rateLimit = require('express-rate-limit'); // REMOVIDO
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const clientsRoutes = require('./routes/clients');
const contactsRoutes = require('./routes/contacts');
const conversationsRoutes = require('./routes/conversations');
const messagesRoutes = require('./routes/messages');
const aiRoutes = require('./routes/ai');
const activitiesRoutes = require('./routes/activities');
const integrationsRoutes = require('./routes/integrations');
const sessionsRoutes = require('./routes/sessions');
const whatsappRoutes = require('./routes/whatsapp');
const webhooksRoutes = require('./routes/webhooks');

const { auth } = require('./middleware/auth');
const socketAuth = require('./middleware/socketAuth');
const { initializeSocket } = require('./services/socketService');

const app = express();
const server = http.createServer(app);

// Socket.IO com CORS
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Rate limiting - COMPLETAMENTE REMOVIDO
/*
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10000,
  message: {
    error: 'Muitas tentativas. Tente novamente em 1 minuto.'
  },
  skip: (req) => {
    return process.env.NODE_ENV === 'development';
  }
});
*/

// Middleware global
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// RATE LIMITING REMOVIDO - SEM LIMITAÇÕES
console.log('✅ Servidor iniciado SEM rate limiting');

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    version: require('../package.json').version
  });
});

// Rotas públicas
app.use('/api/auth', authRoutes);
app.use('/api/webhooks', webhooksRoutes); // Webhooks sem autenticação

// Middleware de autenticação para rotas protegidas
app.use('/api', auth);

// Rotas protegidas
app.use('/api/clients', clientsRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/activities', activitiesRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/sessions', sessionsRoutes);
app.use('/api/whatsapp', whatsappRoutes);

// Middleware de autenticação para Socket.IO
io.use(socketAuth);

// Inicializar serviços WebSocket
initializeSocket(io);

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Dados inválidos',
      details: err.message
    });
  }

  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({
      error: 'Não autorizado'
    });
  }

  res.status(500).json({
    error: 'Erro interno do servidor'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint não encontrado'
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 ContatoSync Evolution API rodando na porta ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/health`);
  console.log(`🌍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = { app, server, io };