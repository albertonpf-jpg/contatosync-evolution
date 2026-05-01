const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { executeWithRLS } = require('../config/supabase');
const { messageSchemas, validate } = require('../utils/validation');
const { getPagination, formatPaginationMeta, formatActivity, cleanJid } = require('../utils/helpers');
const { success, error, notFound, asyncHandler, handleSupabaseError, paginated } = require('../utils/response');
const { emitConversationUpdate, emitNewMessage } = require('../services/socketService');
const { createStoredFile, sanitizeFileName } = require('../utils/mediaStore');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

function normalizeOutgoingMessageType(messageType, file) {
  const requested = String(messageType || '').toLowerCase();
  const mimetype = file?.mimetype || '';
  const fileName = String(file?.originalname || '').toLowerCase();

  if (requested === 'gif') return 'gif';
  if (requested === 'sticker' || fileName.endsWith('.webp')) return 'sticker';
  if (requested === 'image' || mimetype.startsWith('image/')) return mimetype.split(';')[0].trim() === 'image/gif' ? 'gif' : 'image';
  if (requested === 'video' || mimetype.startsWith('video/')) return 'video';
  if (requested === 'audio' || mimetype.startsWith('audio/')) return 'audio';
  if (file) return 'document';
  return 'text';
}

function fallbackContentForMedia(type, originalName) {
  if (originalName) return sanitizeFileName(originalName);
  const labels = {
    image: '[Imagem]',
    audio: '[Audio]',
    video: '[Video]',
    gif: '[GIF]',
    document: '[Arquivo]',
    sticker: '[Figurinha]'
  };
  return labels[type] || '[Midia]';
}

/**
 * GET /api/messages
 * Listar mensagens do cliente com paginação e filtros
 */
router.get('/',
  asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 50,
      conversation_id,
      direction,
      message_type,
      is_ai_response,
      search,
      date_from,
      date_to
    } = req.query;

    const { page: currentPage, limit: currentLimit, offset } = getPagination(page, limit);

    let query = executeWithRLS(req.user.id, (client) => {
      let baseQuery = client
        .from('evolution_messages')
        .select(`
          *,
          evolution_conversations(contact_name, phone)
        `, { count: 'exact' })
        .eq('client_id', req.user.id)
        .order('sent_at', { ascending: false });

      // Filtros
      if (conversation_id) {
        baseQuery = baseQuery.eq('conversation_id', conversation_id);
      }

      if (direction) {
        baseQuery = baseQuery.eq('direction', direction);
      }

      if (message_type) {
        baseQuery = baseQuery.eq('message_type', message_type);
      }

      if (is_ai_response !== undefined) {
        baseQuery = baseQuery.eq('is_ai_response', is_ai_response === 'true');
      }

      if (search) {
        baseQuery = baseQuery.ilike('content', `%${search}%`);
      }

      if (date_from) {
        baseQuery = baseQuery.gte('sent_at', date_from);
      }

      if (date_to) {
        baseQuery = baseQuery.lte('sent_at', date_to);
      }

      return baseQuery.range(offset, offset + currentLimit - 1);
    });

    const { data: messages, error: queryError, count } = await query;

    if (queryError) {
      return handleSupabaseError(res, queryError, 'Erro ao buscar mensagens');
    }

    const pagination = formatPaginationMeta(count, currentPage, currentLimit);

    paginated(res, messages, pagination, 'Mensagens recuperadas com sucesso');
  })
);

/**
 * GET /api/messages/:id
 * Obter mensagem específica
 */
router.get('/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { data: message, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_messages')
        .select(`
          *,
          evolution_conversations(contact_name, phone, status)
        `)
        .eq('client_id', req.user.id)
        .eq('id', id)
        .single()
    );

    if (error || !message) {
      return notFound(res, 'Mensagem não encontrada');
    }

    success(res, message, 'Mensagem recuperada');
  })
);

/**
 * POST /api/messages
 * Criar nova mensagem
 */
router.post('/',
  validate(messageSchemas.create),
  asyncHandler(async (req, res) => {
    const {
      conversation_id,
      message_id,
      jid,
      phone,
      content,
      message_type,
      media_url,
      media_caption,
      direction,
      sender_type,
      is_ai_response,
      ai_model_used,
      ai_confidence,
      sent_at
    } = req.body;

    // Verificar se conversa existe
    const { data: conversation, error: convError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_conversations')
        .select('id, contact_name, total_messages, unread_count')
        .eq('client_id', req.user.id)
        .eq('id', conversation_id)
        .single()
    );

    if (convError || !conversation) {
      return notFound(res, 'Conversa não encontrada');
    }

    // Limpar JID
    const cleanedJid = cleanJid(jid);

    // Criar mensagem
    const messageData = {
      id: uuidv4(),
      client_id: req.user.id,
      conversation_id,
      message_id: message_id || '',
      jid: cleanedJid,
      phone,
      content: content || '',
      message_type: message_type || 'text',
      media_url: media_url || '',
      media_caption: media_caption || '',
      direction,
      sender_type: sender_type || (direction === 'incoming' ? 'contact' : 'client'),
      status: 'received',
      is_ai_response: is_ai_response || false,
      ai_model_used: ai_model_used || '',
      ai_confidence: ai_confidence || null,
      sent_at,
      created_at: new Date().toISOString()
    };

    const { data: newMessage, error: createError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_messages')
        .insert([messageData])
        .select('*')
        .single()
    );

    if (createError) {
      return handleSupabaseError(res, createError, 'Erro ao criar mensagem');
    }

    // Atualizar conversa
    const updateData = {
      last_message_at: sent_at,
      last_message_from: sender_type || (direction === 'incoming' ? 'contact' : 'client'),
      last_message_preview: content ? content.substring(0, 100) : `[${message_type}]`,
      total_messages: conversation.total_messages + 1,
      updated_at: new Date().toISOString()
    };

    // Incrementar contador de não lidas se for mensagem recebida
    if (direction === 'incoming') {
      updateData.unread_count = conversation.unread_count + 1;
    }

    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_conversations')
        .update(updateData)
        .eq('id', conversation_id)
    );

    // Atualizar estatísticas do cliente
    await executeWithRLS(req.user.id, (client) =>
      client.rpc('update_client_stats', { client_uuid: req.user.id })
    );

    // Log da atividade para respostas de IA
    if (is_ai_response) {
      await executeWithRLS(req.user.id, (client) =>
        client
          .from('evolution_activities')
          .insert([{
            id: uuidv4(),
            client_id: req.user.id,
            related_phone: phone,
            related_conversation_id: conversation_id,
            ...formatActivity('ai_response_sent', `Resposta de IA enviada para ${conversation.contact_name}`, {
              model: ai_model_used,
              confidence: ai_confidence
            })
          }])
      );
    }

    // Emitir evento via WebSocket
    emitNewMessage(req.user.id, newMessage);

    success(res, newMessage, 'Mensagem criada com sucesso', 201);
  })
);

/**
 * POST /api/messages/send
 * Enviar mensagem via WhatsApp
 */
router.post('/send',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const { conversation_id, content = '', message_type } = req.body;
    const outgoingType = normalizeOutgoingMessageType(message_type, req.file);

    if (!conversation_id || (!content.trim() && !req.file)) {
      return error(res, 'conversation_id e content ou arquivo são obrigatórios', 400);
    }

    // 1. Buscar conversa
    const { data: conversation, error: convErr } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_conversations')
        .select('*')
        .eq('id', conversation_id)
        .eq('client_id', req.user.id)
        .single()
    );

    if (convErr || !conversation) {
      return notFound(res, 'Conversa não encontrada');
    }

    // 2. Encontrar sessão conectada do cliente
    const baileysService = require('../services/baileysService');

    const { data: dbSessions } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_sessions')
        .select('session_name')
        .eq('client_id', req.user.id)
    );

    if (!dbSessions || dbSessions.length === 0) {
      return error(res, 'Nenhuma sessão WhatsApp configurada. Conecte o WhatsApp primeiro.', 404);
    }

    // Preferir sessão com estado open/connected
    let activeSessionName = null;
    for (const dbSess of dbSessions) {
      const status = baileysService.getSessionStatus(dbSess.session_name);
      if (status.state === 'open' || status.status === 'connected') {
        activeSessionName = dbSess.session_name;
        break;
      }
    }
    if (!activeSessionName) activeSessionName = dbSessions[0].session_name;

    // 3. JID da conversa (preserva @lid para contatos LID)
    const jidToSend = conversation.jid || (conversation.phone + '@s.whatsapp.net');

    try {
      const now = new Date().toISOString();
      const messageContent = content.trim();
      let storedMedia = null;
      let sendResult;

      if (req.file) {
        storedMedia = createStoredFile(req.file.buffer, {
          clientId: req.user.id,
          messageType: outgoingType,
          mimetype: req.file.mimetype,
          originalName: req.file.originalname
        });
        sendResult = await baileysService.sendMediaMessage(activeSessionName, jidToSend, {
          path: storedMedia.path,
          mimetype: storedMedia.mimetype,
          originalName: storedMedia.originalName,
          fileName: storedMedia.originalName,
          caption: messageContent,
          messageType: outgoingType,
          ptt: outgoingType === 'audio'
        });
      } else {
        sendResult = await baileysService.sendTextMessage(activeSessionName, jidToSend, messageContent);
      }
      const finalContent = messageContent || fallbackContentForMedia(outgoingType, storedMedia?.originalName);

      // 4. Salvar mensagem
      const { data: newMessage, error: msgError } = await executeWithRLS(req.user.id, (client) =>
        client
          .from('evolution_messages')
          .insert([{
            id: uuidv4(),
            conversation_id: conversation.id,
            client_id: req.user.id,
            contact_id: conversation.contact_id,
            content: finalContent,
            message_type: outgoingType,
            media_url: storedMedia?.publicPath || '',
            direction: 'out',
            status: 'sent',
            is_from_ai: false,
            whatsapp_message_id: sendResult?.messageId || null,
            sent_at: now,
            created_at: now
          }])
          .select('*')
          .single()
      );

      if (msgError) console.error('Erro salvando mensagem enviada:', msgError);

      // 5. Atualizar conversa
      await executeWithRLS(req.user.id, (client) =>
        client
          .from('evolution_conversations')
          .update({
            last_message_at: now,
            total_messages: (conversation.total_messages || 0) + 1,
            updated_at: now
          })
          .eq('id', conversation.id)
      );

      if (newMessage) emitNewMessage(req.user.id, newMessage);
      emitConversationUpdate(req.user.id, {
        id: conversation.id,
        conversation_id: conversation.id,
        contact_id: conversation.contact_id,
        phone: conversation.phone,
        jid: conversation.jid,
        status: conversation.status || 'active',
        last_message_at: now,
        updated_at: now
      });

      success(res, newMessage || { content: finalContent, direction: 'out', sent_at: now, media_url: storedMedia?.publicPath || '' }, 'Mensagem enviada com sucesso');
    } catch (baileysError) {
      console.error('Erro ao enviar via Baileys:', baileysError.message);
      return error(res, 'Erro ao enviar: ' + baileysError.message, 500);
    }
  })
);

/**
 * PUT /api/messages/:id
 * Atualizar mensagem
 */
router.put('/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status, ai_confidence } = req.body;

    const updateData = {};

    if (status) {
      updateData.status = status;
    }

    if (ai_confidence !== undefined) {
      updateData.ai_confidence = ai_confidence;
    }

    if (Object.keys(updateData).length === 0) {
      return error(res, 'Nenhum campo para atualizar', 400);
    }

    const { data: updatedMessage, error: updateError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_messages')
        .update(updateData)
        .eq('client_id', req.user.id)
        .eq('id', id)
        .select('*')
        .single()
    );

    if (updateError) {
      return handleSupabaseError(res, updateError, 'Erro ao atualizar mensagem');
    }

    if (!updatedMessage) {
      return notFound(res, 'Mensagem não encontrada');
    }

    success(res, updatedMessage, 'Mensagem atualizada com sucesso');
  })
);

/**
 * POST /api/messages/:id/mark-read
 * Marcar mensagem como lida
 */
router.post('/:id/mark-read',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { data: message, error: findError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_messages')
        .select('conversation_id')
        .eq('client_id', req.user.id)
        .eq('id', id)
        .single()
    );

    if (findError || !message) {
      return notFound(res, 'Mensagem não encontrada');
    }

    // Atualizar status da mensagem
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_messages')
        .update({ status: 'read' })
        .eq('id', id)
    );

    // Decrementar contador de não lidas da conversa
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_conversations')
        .update({
          unread_count: 0, // Reset counter - ou implementar lógica mais refinada
          updated_at: new Date().toISOString()
        })
        .eq('id', message.conversation_id)
    );

    success(res, null, 'Mensagem marcada como lida');
  })
);

/**
 * DELETE /api/messages/:id
 * Excluir mensagem
 */
router.delete('/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Buscar mensagem para obter dados da conversa
    const { data: message } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_messages')
        .select('conversation_id, direction')
        .eq('client_id', req.user.id)
        .eq('id', id)
        .single()
    );

    if (!message) {
      return notFound(res, 'Mensagem não encontrada');
    }

    const { error: deleteError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_messages')
        .delete()
        .eq('client_id', req.user.id)
        .eq('id', id)
    );

    if (deleteError) {
      return handleSupabaseError(res, deleteError, 'Erro ao excluir mensagem');
    }

    // Atualizar contadores da conversa
    const { data: conversation } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_conversations')
        .select('total_messages, unread_count')
        .eq('id', message.conversation_id)
        .single()
    );

    if (conversation) {
      const updateData = {
        total_messages: Math.max(0, conversation.total_messages - 1),
        updated_at: new Date().toISOString()
      };

      if (message.direction === 'incoming' && conversation.unread_count > 0) {
        updateData.unread_count = conversation.unread_count - 1;
      }

      await executeWithRLS(req.user.id, (client) =>
        client
          .from('evolution_conversations')
          .update(updateData)
          .eq('id', message.conversation_id)
      );
    }

    success(res, null, 'Mensagem excluída com sucesso');
  })
);

/**
 * GET /api/messages/conversation/:conversation_id
 * Obter mensagens de uma conversa específica
 */
router.get('/conversation/:conversation_id',
  asyncHandler(async (req, res) => {
    const { conversation_id } = req.params;
    const { page = 1, limit = 100 } = req.query;

    // Verificar se conversa pertence ao cliente
    const { data: conversation } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_conversations')
        .select('id')
        .eq('client_id', req.user.id)
        .eq('id', conversation_id)
        .single()
    );

    if (!conversation) {
      return notFound(res, 'Conversa não encontrada');
    }

    const { page: currentPage, limit: currentLimit, offset } = getPagination(page, limit);

    const { data: messages, error, count } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_messages')
        .select('*', { count: 'exact' })
        .eq('conversation_id', conversation_id)
        .order('sent_at', { ascending: false })
        .range(offset, offset + currentLimit - 1)
    );

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao buscar mensagens');
    }

    // Reverter ordem para cronológica
    const sortedMessages = messages.reverse();

    const pagination = formatPaginationMeta(count, currentPage, currentLimit);

    paginated(res, sortedMessages, pagination, 'Mensagens da conversa recuperadas');
  })
);

/**
 * GET /api/messages/stats
 * Estatísticas de mensagens
 */
router.get('/stats',
  asyncHandler(async (req, res) => {
    const { period = 'today' } = req.query;

    let dateFilter = new Date();

    switch (period) {
      case 'today':
        dateFilter.setHours(0, 0, 0, 0);
        break;
      case 'week':
        dateFilter.setDate(dateFilter.getDate() - 7);
        break;
      case 'month':
        dateFilter.setMonth(dateFilter.getMonth() - 1);
        break;
      default:
        dateFilter.setHours(0, 0, 0, 0);
    }

    // Mensagens por direção
    const { data: directionStats } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_messages')
        .select('direction')
        .eq('client_id', req.user.id)
        .gte('sent_at', dateFilter.toISOString())
    );

    // Mensagens por tipo
    const { data: typeStats } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_messages')
        .select('message_type')
        .eq('client_id', req.user.id)
        .gte('sent_at', dateFilter.toISOString())
    );

    // Respostas de IA
    const { count: aiResponsesCount } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_messages')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', req.user.id)
        .eq('is_ai_response', true)
        .gte('sent_at', dateFilter.toISOString())
    );

    // Processar estatísticas
    const directionSummary = directionStats?.reduce((acc, msg) => {
      acc[msg.direction] = (acc[msg.direction] || 0) + 1;
      return acc;
    }, {}) || {};

    const typeSummary = typeStats?.reduce((acc, msg) => {
      acc[msg.message_type] = (acc[msg.message_type] || 0) + 1;
      return acc;
    }, {}) || {};

    const stats = {
      period,
      byDirection: directionSummary,
      byType: typeSummary,
      aiResponses: aiResponsesCount || 0,
      total: directionStats?.length || 0,
      timestamp: new Date().toISOString()
    };

    success(res, stats, 'Estatísticas de mensagens recuperadas');
  })
);

module.exports = router;
