const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../config/supabase');

const socketAuth = async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;

    console.log('[SocketAuth] Tentativa de conexão | token presente:', !!token);

    if (!token) {
      console.warn('[SocketAuth] ❌ Rejeitado: sem token');
      return next(new Error('Token de acesso requerido'));
    }

    // Verificar JWT
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtErr) {
      console.error('[SocketAuth] ❌ JWT inválido:', jwtErr.message);
      return next(new Error('Token inválido'));
    }

    console.log('[SocketAuth] JWT válido | sub:', decoded.sub);

    // Buscar cliente no banco
    const { data: client, error } = await supabaseAdmin
      .from('evolution_clients')
      .select('id, email, name, plan, status')
      .eq('id', decoded.sub)
      .single();

    if (error) {
      console.error('[SocketAuth] ❌ Erro Supabase:', error.message);
      return next(new Error('Erro ao verificar usuário'));
    }

    if (!client) {
      console.error('[SocketAuth] ❌ Cliente não encontrado | id:', decoded.sub);
      return next(new Error('Usuário não encontrado'));
    }

    console.log('[SocketAuth] Cliente encontrado:', client.email, '| status:', client.status);

    // Só bloqueia se explicitamente inativo — null/undefined = aceitar
    if (client.status && client.status !== 'active') {
      console.error('[SocketAuth] ❌ Conta não ativa:', client.status);
      return next(new Error('Conta inativa'));
    }

    // Atribuir dados ao socket
    socket.userId    = client.id;
    socket.userEmail = client.email;
    socket.userName  = client.name;
    socket.userPlan  = client.plan;

    // Entrar na room do cliente
    socket.join(`client_${client.id}`);

    console.log('[SocketAuth] ✅ Conexão aceita | email:', client.email, '| room: client_' + client.id);

    next();

  } catch (err) {
    console.error('[SocketAuth] ❌ Erro interno:', err.message);
    next(new Error('Erro interno de autenticação'));
  }
};

module.exports = socketAuth;
