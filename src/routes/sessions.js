const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { executeWithRLS } = require('../config/supabase');
const { formatActivity } = require('../utils/helpers');
const { success, error, notFound, asyncHandler, handleSupabaseError } = require('../utils/response');
const { emitWhatsAppStatus, emitQRCode } = require('../services/socketService');

const router = express.Router();

/**
 * GET /api/sessions
 * Listar sessões do cliente
 */
router.get('/',
  asyncHandler(async (req, res) => {
    const { active_only = false } = req.query;

    let query = executeWithRLS(req.user.id, (client) => {
      let baseQuery = client
        .from('evolution_sessions')
        .select('id, token, user_agent, ip_address, whatsapp_connected, created_at, last_activity, expires_at')
        .eq('client_id', req.user.id)
        .order('last_activity', { ascending: false });

      if (active_only === 'true') {
        baseQuery = baseQuery.gt('expires_at', new Date().toISOString());
      }

      return baseQuery;
    });

    const { data: sessions, error } = await query;

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao buscar sessões');
    }

    // Remover dados sensíveis (manter apenas primeiros 8 caracteres do token)
    const sanitizedSessions = sessions?.map(session => ({
      ...session,
      token: session.token.substring(0, 8) + '...'
    })) || [];

    success(res, sanitizedSessions, 'Sessões recuperadas com sucesso');
  })
);

/**
 * GET /api/sessions/current
 * Obter sessão atual
 */
router.get('/current',
  asyncHandler(async (req, res) => {
    const token = req.token; // Vem do middleware de auth

    const { data: session, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .select('*')
        .eq('client_id', req.user.id)
        .eq('token', token)
        .single()
    );

    if (error || !session) {
      return notFound(res, 'Sessão não encontrada');
    }

    // Sanitizar dados sensíveis
    const sanitizedSession = {
      ...session,
      token: session.token.substring(0, 8) + '...',
      whatsapp_session_data: session.whatsapp_session_data ? 'configurado' : null
    };

    success(res, sanitizedSession, 'Sessão atual recuperada');
  })
);

/**
 * POST /api/sessions/whatsapp/connect
 * Iniciar conexão WhatsApp
 */
router.post('/whatsapp/connect',
  asyncHandler(async (req, res) => {
    const token = req.token;

    // Buscar ou criar sessão
    let { data: session, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .select('*')
        .eq('client_id', req.user.id)
        .eq('token', token)
        .single()
    );

    if (error || !session) {
      // Criar nova sessão
      const sessionData = {
        id: uuidv4(),
        client_id: req.user.id,
        token,
        user_agent: req.get('User-Agent'),
        ip_address: req.ip,
        whatsapp_connected: false,
        created_at: new Date().toISOString(),
        last_activity: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 dias
      };

      const { data: newSession, error: createError } = await executeWithRLS(req.user.id, (client) =>
        client
          .from('evolution_sessions')
          .insert([sessionData])
          .select('*')
          .single()
      );

      if (createError) {
        return handleSupabaseError(res, createError, 'Erro ao criar sessão');
      }

      session = newSession;
    }

    // TODO: Implementar lógica real de conexão WhatsApp
    // Por agora, simular processo de conexão

    // Gerar QR Code simulado
    const qrCode = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==`;

    // Atualizar sessão com QR Code
    const { data: updatedSession, error: updateError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .update({
          whatsapp_qr_code: qrCode,
          whatsapp_connected: false,
          last_activity: new Date().toISOString()
        })
        .eq('id', session.id)
        .select('*')
        .single()
    );

    if (updateError) {
      return handleSupabaseError(res, updateError, 'Erro ao atualizar sessão');
    }

    // Emitir QR Code via WebSocket
    emitQRCode(req.user.id, qrCode);

    // Log da atividade
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .insert([{
          id: uuidv4(),
          client_id: req.user.id,
          ...formatActivity('whatsapp_connection_started', 'Conexão WhatsApp iniciada')
        }])
    );

    success(res, {
      qrCode,
      sessionId: session.id,
      status: 'waiting_qr_scan'
    }, 'Conexão WhatsApp iniciada. Escaneie o QR Code.');
  })
);

/**
 * POST /api/sessions/whatsapp/simulate-connect
 * Simular conexão WhatsApp bem-sucedida (para desenvolvimento)
 */
router.post('/whatsapp/simulate-connect',
  asyncHandler(async (req, res) => {
    const token = req.token;

    const { data: session, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .select('*')
        .eq('client_id', req.user.id)
        .eq('token', token)
        .single()
    );

    if (error || !session) {
      return notFound(res, 'Sessão não encontrada');
    }

    // Simular dados de sessão WhatsApp
    const whatsappSessionData = {
      number: '+5511999999999',
      name: req.user.name,
      connectedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString()
    };

    // Atualizar sessão como conectada
    const { data: updatedSession, error: updateError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .update({
          whatsapp_connected: true,
          whatsapp_qr_code: null,
          whatsapp_session_data: whatsappSessionData,
          last_activity: new Date().toISOString()
        })
        .eq('id', session.id)
        .select('*')
        .single()
    );

    if (updateError) {
      return handleSupabaseError(res, updateError, 'Erro ao atualizar sessão');
    }

    // Emitir status via WebSocket
    emitWhatsAppStatus(req.user.id, {
      connected: true,
      number: whatsappSessionData.number,
      name: whatsappSessionData.name
    });

    // Log da atividade
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .insert([{
          id: uuidv4(),
          client_id: req.user.id,
          ...formatActivity('whatsapp_connected', 'WhatsApp conectado com sucesso', {
            number: whatsappSessionData.number
          })
        }])
    );

    success(res, {
      connected: true,
      number: whatsappSessionData.number,
      name: whatsappSessionData.name
    }, 'WhatsApp conectado com sucesso');
  })
);

/**
 * POST /api/sessions/whatsapp/disconnect
 * Desconectar WhatsApp
 */
router.post('/whatsapp/disconnect',
  asyncHandler(async (req, res) => {
    const token = req.token;

    const { data: session, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .select('*')
        .eq('client_id', req.user.id)
        .eq('token', token)
        .single()
    );

    if (error || !session) {
      return notFound(res, 'Sessão não encontrada');
    }

    // TODO: Implementar lógica real de desconexão WhatsApp

    // Atualizar sessão como desconectada
    const { data: updatedSession, error: updateError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .update({
          whatsapp_connected: false,
          whatsapp_qr_code: null,
          whatsapp_session_data: null,
          last_activity: new Date().toISOString()
        })
        .eq('id', session.id)
        .select('*')
        .single()
    );

    if (updateError) {
      return handleSupabaseError(res, updateError, 'Erro ao desconectar WhatsApp');
    }

    // Emitir status via WebSocket
    emitWhatsAppStatus(req.user.id, {
      connected: false
    });

    // Log da atividade
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .insert([{
          id: uuidv4(),
          client_id: req.user.id,
          ...formatActivity('whatsapp_disconnected', 'WhatsApp desconectado')
        }])
    );

    success(res, {
      connected: false
    }, 'WhatsApp desconectado com sucesso');
  })
);

/**
 * GET /api/sessions/whatsapp/status
 * Obter status da conexão WhatsApp
 */
router.get('/whatsapp/status',
  asyncHandler(async (req, res) => {
    const token = req.token;

    const { data: session, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .select('whatsapp_connected, whatsapp_session_data, whatsapp_qr_code')
        .eq('client_id', req.user.id)
        .eq('token', token)
        .single()
    );

    if (error || !session) {
      return success(res, {
        connected: false,
        status: 'no_session'
      }, 'Nenhuma sessão encontrada');
    }

    let status = {
      connected: session.whatsapp_connected,
      qrCode: session.whatsapp_qr_code
    };

    if (session.whatsapp_connected && session.whatsapp_session_data) {
      status = {
        ...status,
        number: session.whatsapp_session_data.number,
        name: session.whatsapp_session_data.name,
        lastSeen: session.whatsapp_session_data.lastSeen
      };
    }

    success(res, status, 'Status WhatsApp recuperado');
  })
);

/**
 * DELETE /api/sessions/:id
 * Excluir sessão específica
 */
router.delete('/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .delete()
        .eq('client_id', req.user.id)
        .eq('id', id)
    );

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao excluir sessão');
    }

    success(res, null, 'Sessão excluída com sucesso');
  })
);

/**
 * POST /api/sessions/cleanup
 * Limpar sessões expiradas
 */
router.post('/cleanup',
  asyncHandler(async (req, res) => {
    const { error, count } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .delete({ count: 'exact' })
        .eq('client_id', req.user.id)
        .lt('expires_at', new Date().toISOString())
    );

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao limpar sessões');
    }

    success(res, {
      deletedSessions: count
    }, `${count} sessões expiradas foram removidas`);
  })
);

/**
 * PUT /api/sessions/current/activity
 * Atualizar atividade da sessão atual
 */
router.put('/current/activity',
  asyncHandler(async (req, res) => {
    const token = req.token;

    const { error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .update({
          last_activity: new Date().toISOString()
        })
        .eq('client_id', req.user.id)
        .eq('token', token)
    );

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao atualizar atividade');
    }

    success(res, null, 'Atividade da sessão atualizada');
  })
);

module.exports = router;