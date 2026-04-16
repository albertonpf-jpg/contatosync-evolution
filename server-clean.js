const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./src/routes/auth');
const contactsRoutes = require('./src/routes/contacts');
const whatsappRoutes = require('./src/routes/whatsapp');

const { auth } = require('./src/middleware/auth');

const app = express();
const PORT = 3002; // Nova porta

// Middleware básico - SEM RATE LIMITING
app.use(cors({
  origin: "*",
  credentials: true
}));
app.use(express.json());

console.log('🚀 Servidor LIMPO iniciado na porta', PORT);
console.log('✅ SEM rate limiting, SEM limitações');

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    message: 'Servidor limpo sem rate limiting'
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/contacts', auth, contactsRoutes);
app.use('/api/whatsapp', auth, whatsappRoutes);

// Error handler simples
app.use((err, req, res, next) => {
  console.error('Erro:', err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

app.listen(PORT, () => {
  console.log(`🌟 Servidor rodando em http://localhost:${PORT}`);
  console.log('🔓 Rate limiting REMOVIDO');
});

module.exports = app;