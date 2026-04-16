const express = require('express');
const { v4: uuidv4 } = require('uuid');
const baileysService = require('../services/baileysService');
const { executeWithRLS } = require('../config/supabase');
const { success, error, notFound, asyncHandler, handleSupabaseError } = require('../utils/response');
const { formatActivity } = require('../utils/helpers');

const router = express.Router();

/**
 * GET /api/whatsapp/sessions
 * Listar sessões WhatsApp do cliente
 */
router.get('/sessions',
  asyncHandler(async (req, res) => {
    const { data: sessions, error: queryError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .select('*')
        .eq('client_id', req.user.id)
        .order('created_at', { ascending: false })
    );

    if (queryError) {
      return handleSupabaseError(res, queryError, 'Erro ao buscar sessões');
    }

    // Verificar status atual de cada sessão no Baileys
    const sessionsWithStatus = await Promise.all(
      sessions.map(async (session) => {
        try {
          const status = baileysService.getSessionStatus(session.session_name);
          return {
            ...session,
            baileys_status: status?.state || 'disconnected'
          };
        } catch (err) {
          return {
            ...session,
            baileys_status: 'error'
          };
        }
      })
    );

    success(res, sessionsWithStatus, 'Sessões recuperadas com sucesso');
  })
);

/**
 * POST /api/whatsapp/sessions
 * Criar nova sessão WhatsApp
 */
router.post('/sessions',
  asyncHandler(async (req, res) => {
    const { session_name } = req.body;

    if (!session_name) {
      return error(res, 'Nome da sessão é obrigatório', 400);
    }

    // Verificar se sessão já existe
    const { data: existingSession } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .select('id')
        .eq('client_id', req.user.id)
        .eq('session_name', session_name)
        .single()
    );

    if (existingSession) {
      return error(res, 'Sessão já existe com este nome', 409);
    }

    const webhookUrl = `${process.env.FRONTEND_URL || 'http://localhost:3003'}/api/webhooks/evolution`;

    const sessionData = {
      id: uuidv4(),
      client_id: req.user.id,
      session_name,
      status: 'qr_pending',
      webhook_url: webhookUrl,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: newSession, error: createError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .insert([sessionData])
        .select('*')
        .single()
    );

    if (createError) {
      return error(res, 'Erro ao salvar sessão no banco', 500, { db_error: createError });
    }

    // Criar sessão com Baileys
    let baileysResponse = null;
    try {
      baileysResponse = await baileysService.createSession(session_name, webhookUrl);
      console.log('✅ Baileys sessão criada:', baileysResponse);
    } catch (baileysError) {
      console.error('❌ Erro ao criar sessão Baileys:', baileysError);
      return error(res, 'Erro ao criar sessão WhatsApp', 500, {
        baileys_error: baileysError.message
      });
    }

    // Log da atividade
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .insert([{
          id: uuidv4(),
          client_id: req.user.id,
          ...formatActivity('whatsapp_session_created', `Sessão WhatsApp criada: ${session_name}`, {
            session_name,
            baileys_response: baileysResponse
          })
        }])
    );

    success(res, {
      session: newSession,
      baileys_response: baileysResponse
    }, 'Sessão criada com sucesso', 201);
  })
);

/**
 * GET /api/whatsapp/sessions/:sessionName/qrcode
 * Obter QR Code para conexão
 */
router.get('/sessions/:sessionName/qrcode',
  asyncHandler(async (req, res) => {
    const { sessionName } = req.params;

    // Verificar se sessão pertence ao usuário
    const { data: session } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .select('*')
        .eq('client_id', req.user.id)
        .eq('session_name', sessionName)
        .single()
    );

    if (!session) {
      return notFound(res, 'Sessão não encontrada');
    }

    try {
      const qrCodeData = await baileysService.getQRCode(sessionName);

      if (!qrCodeData.base64) {
        return error(res, 'QR Code ainda não foi gerado. Aguarde alguns segundos e tente novamente.', 202);
      }

      success(res, qrCodeData, 'QR Code obtido com sucesso');
    } catch (baileysError) {
      console.error('Erro ao obter QR Code:', baileysError);
      return error(res, 'Erro ao obter QR Code', 500, {
        baileys_error: baileysError.message
      });
    }
  })
);

/**
 * GET /api/whatsapp/sessions/:sessionName/status
 * Verificar status da conexão
 */
router.get('/sessions/:sessionName/status',
  asyncHandler(async (req, res) => {
    const { sessionName } = req.params;

    const { data: session } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .select('*')
        .eq('client_id', req.user.id)
        .eq('session_name', sessionName)
        .single()
    );

    if (!session) {
      return notFound(res, 'Sessão não encontrada');
    }

    try {
      const status = baileysService.getSessionStatus(sessionName);

      const newStatus = status?.state || 'disconnected';
      if (session.status !== newStatus) {
        await executeWithRLS(req.user.id, (client) =>
          client
            .from('evolution_sessions')
            .update({
              status: newStatus,
              last_seen: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('id', session.id)
        );
      }

      success(res, status, 'Status verificado com sucesso');
    } catch (baileysError) {
      return error(res, 'Erro ao verificar status', 500, {
        baileys_error: baileysError.message
      });
    }
  })
);

/**
 * DELETE /api/whatsapp/sessions/:sessionName
 * Deletar sessão WhatsApp — CORRIGIDO: usa baileysService
 */
router.delete('/sessions/:sessionName',
  asyncHandler(async (req, res) => {
    const { sessionName } = req.params;

    const { data: session } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .select('*')
        .eq('client_id', req.user.id)
        .eq('session_name', sessionName)
        .single()
    );

    if (!session) {
      return notFound(res, 'Sessão não encontrada');
    }

    try {
      // CORRIGIDO: usa baileysService em vez de evolutionService
      await baileysService.deleteSession(sessionName);

      // Deletar do banco
      await executeWithRLS(req.user.id, (client) =>
        client
          .from('evolution_sessions')
          .delete()
          .eq('id', session.id)
      );

      // Log da atividade
      await executeWithRLS(req.user.id, (client) =>
        client
          .from('evolution_activities')
          .insert([{
            id: uuidv4(),
            client_id: req.user.id,
            ...formatActivity('whatsapp_session_deleted', `Sessão WhatsApp deletada: ${sessionName}`)
          }])
      );

      success(res, null, 'Sessão deletada com sucesso');
    } catch (baileysError) {
      return error(res, 'Erro ao deletar sessão', 500, {
        baileys_error: baileysError.message
      });
    }
  })
);

/**
 * POST /api/whatsapp/send-message
 * Enviar mensagem via WhatsApp
 */
router.post('/send-message',
  asyncHandler(async (req, res) => {
    const { session_name, phone, message, contact_id } = req.body;

    if (!session_name || !phone || !message) {
      return error(res, 'Session, telefone e mensagem são obrigatórios', 400);
    }

    const { data: session } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .select('*')
        .eq('client_id', req.user.id)
        .eq('session_name', session_name)
        .single()
    );

    if (!session) {
      return notFound(res, 'Sessão não encontrada');
    }

    try {
      const sendResult = await baileysService.sendTextMessage(session_name, phone, message);

      // Salvar mensagem no banco (se contact_id fornecido)
      if (contact_id) {
        let conversation;
        const { data: existingConv } = await executeWithRLS(req.user.id, (client) =>
          client
            .from('evolution_conversations')
            .select('*')
            .eq('client_id', req.user.id)
            .eq('contact_id', contact_id)
            .single()
        );

        if (existingConv) {
          conversation = existingConv;
        } else {
          const { data: newConv } = await executeWithRLS(req.user.id, (client) =>
            client
              .from('evolution_conversations')
              .insert([{
                id: uuidv4(),
                client_id: req.user.id,
                contact_id: contact_id,
                status: 'active',
                last_message_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              }])
              .select('*')
              .single()
          );
          conversation = newConv;
        }

        // Salvar mensagem
        await executeWithRLS(req.user.id, (client) =>
          client
            .from('evolution_messages')
            .insert([{
              id: uuidv4(),
              conversation_id: conversation.id,
              client_id: req.user.id,
              contact_id: contact_id,
              content: message,
              message_type: 'text',
              direction: 'out',
              status: 'sent',
              whatsapp_message_id: sendResult?.key?.id,
              created_at: new Date().toISOString()
            }])
        );
      }

      success(res, sendResult, 'Mensagem enviada com sucesso');
    } catch (baileysError) {
      return error(res, 'Erro ao enviar mensagem', 500, {
        baileys_error: baileysError.message
      });
    }
  })
);

module.exports = router;