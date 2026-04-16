const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../config/supabase');

/**
 * Middleware de autenticação para Socket.IO
 * Autentica o usuário antes de permitir conexão WebSocket
 */
const socketAuth = async (socket, next) => {
  try {
    // Extrair token do handshake
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;

    if (!token) {
      return next(new Error('Token de acesso requerido'));
    }

    // Verificar e decodificar token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      return next(new Error('Token inválido'));
    }

    // Buscar dados do cliente no Supabase
    const { data: client, error } = await supabaseAdmin
      .from('evolution_clients')
      .select('id, email, name, plan, status')
      .eq('id', decoded.sub)
      .single();

    if (error || !client) {
      return next(new Error('Usuário não encontrado'));
    }

    // Verificar se cliente está ativo
    if (client.status !== 'active') {
      return next(new Error('Conta inativa'));
    }

    // Adicionar dados do cliente ao socket
    socket.userId = client.id;
    socket.userEmail = client.email;
    socket.userName = client.name;
    socket.userPlan = client.plan;

    // Criar room específico do cliente para mensagens privadas
    socket.join(`client_${client.id}`);

    console.log(`✅ Cliente conectado via WebSocket: ${client.email} (${client.id})`);

    next();

  } catch (error) {
    console.error('Erro no middleware de auth WebSocket:', error);
    next(new Error('Erro interno de autenticação'));
  }
};

module.exports = socketAuth;