const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../config/supabase');

/**
 * Middleware de autenticação JWT
 * Verifica se o token é válido e adiciona dados do usuário à request
 */
const auth = async (req, res, next) => {
  try {
    // Extrair token do header Authorization
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        error: 'Token de acesso requerido'
      });
    }

    // Verificar e decodificar token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      return res.status(401).json({
        error: 'Token inválido'
      });
    }

    // Buscar dados do cliente no Supabase
    const { data: client, error } = await supabaseAdmin
      .from('evolution_clients')
      .select('*')
      .eq('id', decoded.sub)
      .single();

    if (error || !client) {
      return res.status(401).json({
        error: 'Usuário não encontrado'
      });
    }

    // Verificar se cliente está ativo
    if (client.status !== 'active') {
      return res.status(401).json({
        error: 'Conta inativa'
      });
    }

    // Adicionar dados do cliente à request
    req.user = {
      id: client.id,
      email: client.email,
      name: client.name,
      plan: client.plan,
      status: client.status
    };

    req.token = token;

    next();

  } catch (error) {
    console.error('Erro no middleware de auth:', error);
    res.status(500).json({
      error: 'Erro interno de autenticação'
    });
  }
};

/**
 * Middleware para verificar plano do cliente
 * @param {Array} allowedPlans - Planos permitidos
 */
const requirePlan = (allowedPlans = []) => {
  return (req, res, next) => {
    if (!allowedPlans.includes(req.user.plan)) {
      return res.status(403).json({
        error: 'Plano insuficiente',
        required: allowedPlans,
        current: req.user.plan
      });
    }
    next();
  };
};

/**
 * Middleware opcional de auth (não bloqueia se não houver token)
 */
const optionalAuth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { data: client, error } = await supabaseAdmin
      .from('evolution_clients')
      .select('*')
      .eq('id', decoded.sub)
      .single();

    if (!error && client && client.status === 'active') {
      req.user = {
        id: client.id,
        email: client.email,
        name: client.name,
        plan: client.plan,
        status: client.status
      };
      req.token = token;
    }

    next();

  } catch (error) {
    // Em caso de erro, continua sem autenticação
    next();
  }
};

module.exports = {
  auth,
  requirePlan,
  optionalAuth
};