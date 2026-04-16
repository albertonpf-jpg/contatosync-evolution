const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../config/supabase');
const { authSchemas, validate } = require('../utils/validation');
const { hashPassword, comparePassword, formatActivity } = require('../utils/helpers');
const { success, error, conflict, unauthorized, notFound, asyncHandler, handleSupabaseError } = require('../utils/response');

const router = express.Router();

/**
 * POST /api/auth/register
 * Registrar novo cliente
 */
router.post('/register',
  validate(authSchemas.register),
  asyncHandler(async (req, res) => {
    const { email, password, name, company_name, phone, plan } = req.body;

    // Verificar se email já existe
    const { data: existingClient } = await supabaseAdmin
      .from('evolution_clients')
      .select('email')
      .eq('email', email.toLowerCase())
      .single();

    if (existingClient) {
      return conflict(res, 'E-mail já está em uso');
    }

    // Hash da senha
    const passwordHash = await hashPassword(password);

    // Criar cliente
    const clientData = {
      id: uuidv4(),
      email: email.toLowerCase(),
      password_hash: passwordHash,
      name,
      company_name: company_name || null,
      phone: phone || null,
      plan: plan || 'basic',
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: newClient, error: createError } = await supabaseAdmin
      .from('evolution_clients')
      .insert([clientData])
      .select('id, email, name, company_name, phone, plan, status, created_at')
      .single();

    if (createError) {
      return handleSupabaseError(res, createError, 'Erro ao criar conta');
    }

    // Criar configuração de IA padrão
    const aiConfigData = {
      id: uuidv4(),
      client_id: newClient.id,
      provider: 'openai',
      model: 'gpt-3.5-turbo',
      temperature: 0.7,
      max_tokens: 150,
      system_prompt: 'Você é um assistente virtual amigável e prestativo.',
      auto_reply_enabled: false,
      reply_delay_seconds: 5,
      business_hours_only: true,
      business_hours_start: '09:00:00',
      business_hours_end: '18:00:00',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    await supabaseAdmin
      .from('evolution_ai_config')
      .insert([aiConfigData]);

    // Log da atividade
    await supabaseAdmin
      .from('evolution_activities')
      .insert([{
        id: uuidv4(),
        client_id: newClient.id,
        ...formatActivity('account_created', 'Conta criada com sucesso', {
          plan: newClient.plan,
          method: 'register'
        })
      }]);

    // Gerar JWT
    const token = jwt.sign(
      { sub: newClient.id, email: newClient.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
    );

    success(res, {
      client: newClient,
      token,
      expiresIn: process.env.JWT_EXPIRES_IN || '30d'
    }, 'Conta criada com sucesso', 201);
  })
);

/**
 * POST /api/auth/login
 * Autenticar cliente
 */
router.post('/login',
  validate(authSchemas.login),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    // Buscar cliente por email
    const { data: client, error: findError } = await supabaseAdmin
      .from('evolution_clients')
      .select('id, email, password_hash, name, company_name, phone, plan, status')
      .eq('email', email.toLowerCase())
      .single();

    if (findError || !client) {
      return unauthorized(res, 'E-mail ou senha inválidos');
    }

    // Verificar status da conta
    if (client.status !== 'active') {
      return unauthorized(res, 'Conta inativa');
    }

    // Verificar senha
    const isValidPassword = await comparePassword(password, client.password_hash);

    if (!isValidPassword) {
      return unauthorized(res, 'E-mail ou senha inválidos');
    }

    // Atualizar último login
    await supabaseAdmin
      .from('evolution_clients')
      .update({
        last_login: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', client.id);

    // Log da atividade
    await supabaseAdmin
      .from('evolution_activities')
      .insert([{
        id: uuidv4(),
        client_id: client.id,
        ...formatActivity('login', 'Login realizado', {
          method: 'email',
          ip: req.ip,
          userAgent: req.get('User-Agent')
        })
      }]);

    // Gerar JWT
    const token = jwt.sign(
      { sub: client.id, email: client.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
    );

    // Remover dados sensíveis
    delete client.password_hash;

    success(res, {
      client,
      token,
      expiresIn: process.env.JWT_EXPIRES_IN || '30d'
    }, 'Login realizado com sucesso');
  })
);

/**
 * POST /api/auth/refresh
 * Renovar token JWT
 */
router.post('/refresh',
  asyncHandler(async (req, res) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      return unauthorized(res, 'Token requerido');
    }

    try {
      // Verificar token (mesmo que expirado)
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });

      // Verificar se cliente ainda existe e está ativo
      const { data: client, error } = await supabaseAdmin
        .from('evolution_clients')
        .select('id, email, name, status')
        .eq('id', decoded.sub)
        .single();

      if (error || !client || client.status !== 'active') {
        return unauthorized(res, 'Cliente não encontrado ou inativo');
      }

      // Gerar novo token
      const newToken = jwt.sign(
        { sub: client.id, email: client.email },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
      );

      success(res, {
        token: newToken,
        expiresIn: process.env.JWT_EXPIRES_IN || '30d'
      }, 'Token renovado com sucesso');

    } catch (error) {
      return unauthorized(res, 'Token inválido');
    }
  })
);

/**
 * POST /api/auth/logout
 * Fazer logout (invalidar sessão se existir)
 */
router.post('/logout',
  asyncHandler(async (req, res) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Invalidar sessões ativas no banco
        await supabaseAdmin
          .from('evolution_sessions')
          .update({
            status: 'disconnected',
            updated_at: new Date().toISOString()
          })
          .eq('client_id', decoded.sub)
          .eq('status', 'connected');

        // Log da atividade
        await supabaseAdmin
          .from('evolution_activities')
          .insert([{
            id: uuidv4(),
            client_id: decoded.sub,
            ...formatActivity('logout', 'Logout realizado')
          }]);

      } catch (error) {
        // Token inválido, mas ainda assim responder sucesso
      }
    }

    success(res, null, 'Logout realizado com sucesso');
  })
);

/**
 * GET /api/auth/me
 * Obter dados do cliente autenticado
 */
router.get('/me',
  require('../middleware/auth').auth,
  asyncHandler(async (req, res) => {
    const { data: client, error } = await supabaseAdmin
      .from('evolution_clients')
      .select(`
        id, email, name, company_name, phone, plan, status,
        total_contacts_saved, total_messages_sent, total_ai_responses,
        created_at, updated_at
      `)
      .eq('id', req.user.id)
      .single();

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao buscar dados do cliente');
    }

    success(res, client, 'Dados do cliente recuperados');
  })
);

/**
 * POST /api/auth/forgot-password
 * Solicitar reset de senha (placeholder - implementar com email)
 */
router.post('/forgot-password',
  asyncHandler(async (req, res) => {
    const { email } = req.body;

    if (!email) {
      return error(res, 'E-mail é obrigatório', 400);
    }

    // Verificar se email existe
    const { data: client } = await supabaseAdmin
      .from('evolution_clients')
      .select('id, email, name')
      .eq('email', email.toLowerCase())
      .single();

    // Sempre retornar sucesso por segurança
    success(res, null, 'Se o e-mail existir, você receberá instruções de reset');

    // TODO: Implementar envio de email de reset
    if (client) {
      console.log(`Reset password requested for: ${client.email}`);
    }
  })
);

module.exports = router;