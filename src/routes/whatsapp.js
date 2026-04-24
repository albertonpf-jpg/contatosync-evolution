const express = require('express');
const { v4: uuidv4 } = require('uuid');
const baileysService = require('../services/baileysService');
const { executeWithRLS } = require('../config/supabase');
const { success, error, notFound, asyncHandler, handleSupabaseError } = require('../utils/response');
const { formatActivity } = require('../utils/helpers');

const router = express.Router();

// Helper para converter nome display para nome interno
const getEvolutionSessionName = (displayName) => `evo_${displayName}`;
const getDisplayName = (evolutionSessionName) => evolutionSessionName.replace(/^evo_/, '');

/**
 * GET /api/whatsapp/sessions
 * Listar sessões WhatsApp do cliente
 */
router.get('/sessions', asyncHandler(async (req, res) => {
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

  const sessionsWithStatus = await Promise.all(
    sessions.map(async (session) => {
      try {
        const status = baileysService.getSessionStatus(session.session_name);
        return {
          ...session,
          session_name: getDisplayName(session.session_name), // Retorna nome display
          baileys_status: status?.state || 'disconnected'
        };
      } catch (err) {
        return {
          ...session,
          session_name: getDisplayName(session.session_name),
          baileys_status: 'error'
        };
      }
    })
  );

  success(res, sessionsWithStatus, 'Sessões recuperadas com sucesso');
}));

/**
 * POST /api/whatsapp/sessions
 * Criar nova sessão WhatsApp
 */
router.post('/sessions', asyncHandler(async (req, res) => {
  const { session_name } = req.body;

  if (!session_name) {
    return error(res, 'Nome da sessão é obrigatório', 400);
  }

  // Adicionar prefixo para evitar conflito com ContatoSync antigo
  const evolutionSessionName = `evo_${session_name}`;

  const { data: existingSession } = await executeWithRLS(req.user.id, (client) =>
    client
      .from('evolution_sessions')
      .select('id')
      .eq('client_id', req.user.id)
      .eq('session_name', evolutionSessionName)
      .single()
  );

  if (existingSession) {
    return error(res, 'Sessão já existe com este nome', 409);
  }

  const webhookUrl = `${process.env.FRONTEND_URL || 'http://localhost:3003'}/api/webhooks/evolution`;

  const sessionData = {
    id: uuidv4(),
    client_id: req.user.id,
    session_name: evolutionSessionName,
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

  let baileysResponse = null;
  try {
    baileysResponse = await baileysService.createSession(evolutionSessionName, webhookUrl);
    console.log('✅ Baileys sessão criada:', baileysResponse);
  } catch (baileysError) {
    console.error('❌ Erro ao criar sessão Baileys:', baileysError);
    return error(res, 'Erro ao criar sessão WhatsApp', 500, { baileys_error: baileysError.message });
  }

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

  success(res, { session: newSession, baileys_response: baileysResponse }, 'Sessão criada com sucesso', 201);
}));

/**
 * GET /api/whatsapp/sessions/:sessionName/qrcode
 */
router.get('/sessions/:sessionName/qrcode', asyncHandler(async (req, res) => {
  const { sessionName } = req.params;
  const evolutionSessionName = getEvolutionSessionName(sessionName);

  const { data: session } = await executeWithRLS(req.user.id, (client) =>
    client
      .from('evolution_sessions')
      .select('*')
      .eq('client_id', req.user.id)
      .eq('session_name', evolutionSessionName)
      .single()
  );

  if (!session) {
    return notFound(res, 'Sessão não encontrada');
  }

  try {
    // Auto-recuperar sessao se nao estiver em memoria (ex: apos reinicio do servidor)
    const sessionInMemory = baileysService.sessions.has(evolutionSessionName);
    if (!sessionInMemory) {
      console.log('Sessao nao esta em memoria, reiniciando: ' + evolutionSessionName);
      await baileysService.createSession(evolutionSessionName, session.webhook_url);
    }
    const qrCodeData = await baileysService.getQRCode(evolutionSessionName);
    if (!qrCodeData.base64) {
      return error(res, 'QR Code ainda nao foi gerado. Aguarde alguns segundos e tente novamente.', 202);
    }
    success(res, qrCodeData, 'QR Code obtido com sucesso');
  } catch (baileysError) {
    console.error('Erro ao obter QR Code:', baileysError);
    return error(res, 'Erro ao obter QR Code', 500, { baileys_error: baileysError.message });
  }
}));

/**
 * GET /api/whatsapp/sessions/:sessionName/status
 */
router.get('/sessions/:sessionName/status', asyncHandler(async (req, res) => {
  const { sessionName } = req.params;
  const evolutionSessionName = getEvolutionSessionName(sessionName);

  const { data: session } = await executeWithRLS(req.user.id, (client) =>
    client
      .from('evolution_sessions')
      .select('*')
      .eq('client_id', req.user.id)
      .eq('session_name', evolutionSessionName)
      .single()
  );

  if (!session) {
    return notFound(res, 'Sessão não encontrada');
  }

  try {
    const status = baileysService.getSessionStatus(evolutionSessionName);
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
    return error(res, 'Erro ao verificar status', 500, { baileys_error: baileysError.message });
  }
}));

/**
 * DELETE /api/whatsapp/sessions/:sessionName
 */
router.delete('/sessions/:sessionName', asyncHandler(async (req, res) => {
  const { sessionName } = req.params;
  const evolutionSessionName = getEvolutionSessionName(sessionName);

  // Tentar encontrar sessão com prefixo (nova) ou sem prefixo (antiga)
  let session = null;
  let sessionNameToDelete = null;

  // Primeiro: tentar com prefixo (novo padrão)
  const { data: newSession } = await executeWithRLS(req.user.id, (client) =>
    client
      .from('evolution_sessions')
      .select('*')
      .eq('client_id', req.user.id)
      .eq('session_name', evolutionSessionName)
      .single()
  );

  if (newSession) {
    session = newSession;
    sessionNameToDelete = evolutionSessionName;
  } else {
    // Segundo: tentar sem prefixo (sessão antiga)
    const { data: oldSession } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .select('*')
        .eq('client_id', req.user.id)
        .eq('session_name', sessionName)
        .single()
    );

    if (oldSession) {
      session = oldSession;
      sessionNameToDelete = sessionName;
    }
  }

  if (!session) {
    return notFound(res, `Sessão '${sessionName}' não encontrada (tentou: '${evolutionSessionName}' e '${sessionName}')`);
  }

  console.log(`🗑️ Deletando sessão: ${sessionNameToDelete} (original: ${sessionName})`);

  try {
    await baileysService.deleteSession(sessionNameToDelete);

    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .delete()
        .eq('id', session.id)
    );

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
    return error(res, 'Erro ao deletar sessão', 500, { baileys_error: baileysError.message });
  }
}));

/**
 * POST /api/whatsapp/send-message
 * Enviar mensagem via WhatsApp — CORRIGIDO: popula contact_name, phone, jid, sent_at
 */
router.post('/send-message', asyncHandler(async (req, res) => {
  const { session_name, phone, message, contact_id } = req.body;

  if (!session_name || !phone || !message) {
    return error(res, 'Session, telefone e mensagem são obrigatórios', 400);
  }

  const evolutionSessionName = getEvolutionSessionName(session_name);

  const { data: session } = await executeWithRLS(req.user.id, (client) =>
    client
      .from('evolution_sessions')
      .select('*')
      .eq('client_id', req.user.id)
      .eq('session_name', evolutionSessionName)
      .single()
  );

  if (!session) {
    return notFound(res, 'Sessão não encontrada');
  }

  try {
    const sendResult = await baileysService.sendTextMessage(evolutionSessionName, phone, message);
    const now = new Date().toISOString();
    const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;

    if (contact_id) {
      // Buscar contato pra pegar nome
      const { data: contactData } = await executeWithRLS(req.user.id, (client) =>
        client
          .from('evolution_contacts')
          .select('name, phone')
          .eq('id', contact_id)
          .single()
      );

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
        // Atualizar conversa
        const newTotal = (conversation.total_messages || 0) + 1;
        await executeWithRLS(req.user.id, (client) =>
          client
            .from('evolution_conversations')
            .update({
              last_message_at: now,
              total_messages: newTotal,
              contact_name: contactData?.name || conversation.contact_name,
              phone: contactData?.phone || phone,
              jid: jid,
              updated_at: now
            })
            .eq('id', conversation.id)
        );
      } else {
        const { data: newConv } = await executeWithRLS(req.user.id, (client) =>
          client
            .from('evolution_conversations')
            .insert([{
              id: uuidv4(),
              client_id: req.user.id,
              contact_id: contact_id,
              jid: jid,
              phone: contactData?.phone || phone,
              contact_name: contactData?.name || `Contato ${phone}`,
              status: 'active',
              priority: 'normal',
              lead_stage: 'new',
              last_message_at: now,
              unread_count: 0,
              total_messages: 1,
              created_at: now,
              updated_at: now
            }])
            .select('*')
            .single()
        );
        conversation = newConv;
      }

      // Salvar mensagem com sent_at
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
            is_from_ai: false,
            whatsapp_message_id: sendResult?.messageId || sendResult?.key?.id,
            sent_at: now,
            created_at: now
          }])
      );
    }

    success(res, sendResult, 'Mensagem enviada com sucesso');
  } catch (baileysError) {
    return error(res, 'Erro ao enviar mensagem', 500, { baileys_error: baileysError.message });
  }
}));

module.exports = router;
