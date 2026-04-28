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
 * Criar nova sessão WhatsApp — REGRA: 1 cliente = 1 sessão ativa.
 * Encerra e remove qualquer sessão anterior antes de criar a nova.
 */
router.post('/sessions', asyncHandler(async (req, res) => {
  const { session_name } = req.body;

  if (!session_name) {
    return error(res, 'Nome da sessão é obrigatório', 400);
  }

  // client_id SEMPRE vem do token autenticado — nunca do body
  const clientId = req.user.id;
  const evolutionSessionName = `evo_${session_name}`;

  // ── REGRA 1 CLIENTE = 1 SESSÃO ──────────────────────────────
  // Buscar TODAS as sessões existentes desse client (não filtra por nome)
  const { data: existingSessions } = await executeWithRLS(clientId, (client) =>
    client
      .from('evolution_sessions')
      .select('id, session_name, status')
      .eq('client_id', clientId)
  );

  if (existingSessions && existingSessions.length > 0) {
    console.log(`[SESSION] Cliente ${clientId} já tem ${existingSessions.length} sessão(ões). Encerrando antes de criar nova.`);

    for (const sess of existingSessions) {
      try {
        await baileysService.deleteSession(sess.session_name);
        console.log(`[SESSION] Baileys encerrado: ${sess.session_name}`);
      } catch (e) {
        console.warn(`[SESSION] Baileys já encerrado ou erro ao encerrar ${sess.session_name}: ${e.message}`);
      }
    }

    const { error: delError } = await executeWithRLS(clientId, (client) =>
      client
        .from('evolution_sessions')
        .delete()
        .eq('client_id', clientId)
    );

    if (delError) {
      console.error('[SESSION] Erro ao remover sessões antigas:', delError);
      return error(res, 'Erro ao encerrar sessões anteriores', 500);
    }

    console.log(`[SESSION] ${existingSessions.length} sessão(ões) removida(s) para client ${clientId}`);
  }

  const webhookUrl = `${process.env.FRONTEND_URL || 'http://localhost:3003'}/api/webhooks/evolution`;

  const sessionData = {
    id: uuidv4(),
    client_id: clientId,          // garantido pelo token
    session_name: evolutionSessionName,
    status: 'qr_pending',
    webhook_url: webhookUrl,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { data: newSession, error: createError } = await executeWithRLS(clientId, (client) =>
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
    console.log(`[SESSION] Baileys criado: ${evolutionSessionName} → client: ${clientId}`);
  } catch (baileysError) {
    console.error('❌ Erro ao criar sessão Baileys:', baileysError);
    // Remover do banco se Baileys falhou
    await executeWithRLS(clientId, (client) =>
      client.from('evolution_sessions').delete().eq('id', newSession.id)
    );
    return error(res, 'Erro ao criar sessão WhatsApp', 500, { baileys_error: baileysError.message });
  }

  await executeWithRLS(clientId, (client) =>
    client
      .from('evolution_activities')
      .insert([{
        id: uuidv4(),
        client_id: clientId,
        ...formatActivity('whatsapp_session_created', `Sessão WhatsApp criada: ${session_name}`)
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
    let qrCodeData = await baileysService.getQRCode(evolutionSessionName);

    // Se QR nao foi gerado (sessao em estado invalido), reiniciar e aguardar
    if (!qrCodeData.base64) {
      const currentStatus = qrCodeData?.status;
      if (currentStatus === 'disconnected' || currentStatus === 'error' || currentStatus === 'not_found') {
        console.log('Sessao em estado ' + currentStatus + ', reiniciando: ' + evolutionSessionName);
        await baileysService.createSession(evolutionSessionName, session.webhook_url);
        qrCodeData = await baileysService.getQRCode(evolutionSessionName);
      }
    }

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
