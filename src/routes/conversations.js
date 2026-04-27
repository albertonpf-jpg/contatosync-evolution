const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { executeWithRLS } = require('../config/supabase');
const { conversationSchemas, validate } = require('../utils/validation');
const { getPagination, formatPaginationMeta, formatActivity } = require('../utils/helpers');
const { success, error, notFound, asyncHandler, handleSupabaseError, paginated } = require('../utils/response');
const { emitConversationUpdate } = require('../services/socketService');

const router = express.Router();

/**
 * GET /api/conversations
 * Listar conversas do cliente com paginação e filtros
 */
router.get('/',
  asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 20,
      status,
      priority,
      lead_stage,
      search,
      assigned_to
    } = req.query;

    const { page: currentPage, limit: currentLimit, offset } = getPagination(page, limit);

    let query = executeWithRLS(req.user.id, (client) => {
      let baseQuery = client
        .from('evolution_conversations')
        .select(`
          *,
          evolution_contacts(name, phone)
        `, { count: 'exact' })
        .eq('client_id', req.user.id)
        .order('last_message_at', { ascending: false });

      // Filtros
      if (status) {
        baseQuery = baseQuery.eq('status', status);
      }

      if (priority) {
        baseQuery = baseQuery.eq('priority', priority);
      }

      if (lead_stage) {
        baseQuery = baseQuery.eq('lead_stage', lead_stage);
      }

      if (assigned_to) {
        baseQuery = baseQuery.eq('assigned_to', assigned_to);
      }

      if (search) {
        baseQuery = baseQuery.or(`contact_name.ilike.%${search}%, phone.ilike.%${search}%, notes.ilike.%${search}%`);
      }

      return baseQuery.range(offset, offset + currentLimit - 1);
    });

    const { data: conversations, error: queryError, count } = await query;

    if (queryError) {
      return handleSupabaseError(res, queryError, 'Erro ao buscar conversas');
    }

    const pagination = formatPaginationMeta(count, currentPage, currentLimit);

    paginated(res, conversations, pagination, 'Conversas recuperadas com sucesso');
  })
);

/**
 * GET /api/conversations/:id
 * Obter conversa específica com mensagens
 */
router.get('/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { messages_limit = 50 } = req.query;

    // Buscar conversa
    const { data: conversation, error: convError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_conversations')
        .select(`
          *,
          evolution_contacts(name, phone, source)
        `)
        .eq('client_id', req.user.id)
        .eq('id', id)
        .single()
    );

    if (convError || !conversation) {
      return notFound(res, 'Conversa não encontrada');
    }

    // Buscar mensagens da conversa
    const { data: messages, error: msgError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_messages')
        .select('*')
        .eq('conversation_id', id)
        .order('sent_at', { ascending: false })
        .limit(messages_limit)
    );

    if (msgError) {
      return handleSupabaseError(res, msgError, 'Erro ao buscar mensagens');
    }

    // Reverter ordem das mensagens para cronológica
    const sortedMessages = messages.reverse();

    success(res, {
      conversation,
      messages: sortedMessages
    }, 'Conversa recuperada com sucesso');
  })
);

/**
 * POST /api/conversations
 * Criar nova conversa
 */
router.post('/',
  validate(conversationSchemas.create),
  asyncHandler(async (req, res) => {
    const { contact_id, jid, phone, contact_name } = req.body;

    // Verificar se contato existe
    const { data: contact, error: contactError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_contacts')
        .select('id, name, phone')
        .eq('client_id', req.user.id)
        .eq('id', contact_id)
        .single()
    );

    if (contactError || !contact) {
      return notFound(res, 'Contato não encontrado');
    }

    // Verificar se já existe conversa para este JID
    const { data: existingConversation } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_conversations')
        .select('id')
        .eq('client_id', req.user.id)
        .eq('jid', jid)
        .single()
    );

    if (existingConversation) {
      return error(res, 'Conversa já existe para este contato', 409);
    }

    // Criar conversa
    const conversationData = {
      id: uuidv4(),
      client_id: req.user.id,
      contact_id,
      jid,
      phone: phone || contact.phone,
      contact_name: contact_name || contact.name,
      status: 'active',
      priority: 'normal',
      lead_stage: 'new',
      last_message_at: new Date().toISOString(),
      total_messages: 0,
      unread_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: newConversation, error: createError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_conversations')
        .insert([conversationData])
        .select('*')
        .single()
    );

    if (createError) {
      return handleSupabaseError(res, createError, 'Erro ao criar conversa');
    }

    // Log da atividade
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .insert([{
          id: uuidv4(),
          client_id: req.user.id,
          related_phone: phone || contact.phone,
          related_contact_id: contact_id,
          related_conversation_id: newConversation.id,
          ...formatActivity('conversation_created', `Nova conversa iniciada com ${contact_name || contact.name}`)
        }])
    );

    // Emitir evento via WebSocket
    emitConversationUpdate(req.user.id, newConversation);

    success(res, newConversation, 'Conversa criada com sucesso', 201);
  })
);

/**
 * PUT /api/conversations/:id
 * Atualizar conversa
 */
router.put('/:id',
  validate(conversationSchemas.update),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const updateData = {
      ...req.body,
      updated_at: new Date().toISOString()
    };

    const { data: updatedConversation, error: updateError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_conversations')
        .update(updateData)
        .eq('client_id', req.user.id)
        .eq('id', id)
        .select('*')
        .single()
    );

    if (updateError) {
      return handleSupabaseError(res, updateError, 'Erro ao atualizar conversa');
    }

    if (!updatedConversation) {
      return notFound(res, 'Conversa não encontrada');
    }

    // Log da atividade para mudanças importantes
    if (req.body.status || req.body.lead_stage || req.body.priority) {
      await executeWithRLS(req.user.id, (client) =>
        client
          .from('evolution_activities')
          .insert([{
            id: uuidv4(),
            client_id: req.user.id,
            related_phone: updatedConversation.phone,
            related_conversation_id: updatedConversation.id,
            ...formatActivity('conversation_updated', `Conversa atualizada: ${updatedConversation.contact_name}`, {
              updatedFields: Object.keys(req.body)
            })
          }])
      );
    }

    // Emitir evento via WebSocket
    emitConversationUpdate(req.user.id, updatedConversation);

    success(res, updatedConversation, 'Conversa atualizada com sucesso');
  })
);

/**
 * POST /api/conversations/:id/archive
 * Arquivar conversa
 */
router.post('/:id/archive',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { data: updatedConversation, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_conversations')
        .update({
          status: 'archived',
          updated_at: new Date().toISOString()
        })
        .eq('client_id', req.user.id)
        .eq('id', id)
        .select('*')
        .single()
    );

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao arquivar conversa');
    }

    if (!updatedConversation) {
      return notFound(res, 'Conversa não encontrada');
    }

    // Log da atividade
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .insert([{
          id: uuidv4(),
          client_id: req.user.id,
          related_conversation_id: id,
          ...formatActivity('conversation_archived', `Conversa arquivada: ${updatedConversation.contact_name}`)
        }])
    );

    success(res, updatedConversation, 'Conversa arquivada com sucesso');
  })
);

/**
 * POST /api/conversations/:id/close
 * Fechar conversa
 */
router.post('/:id/close',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { data: updatedConversation, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_conversations')
        .update({
          status: 'closed',
          updated_at: new Date().toISOString()
        })
        .eq('client_id', req.user.id)
        .eq('id', id)
        .select('*')
        .single()
    );

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao fechar conversa');
    }

    if (!updatedConversation) {
      return notFound(res, 'Conversa não encontrada');
    }

    success(res, updatedConversation, 'Conversa fechada com sucesso');
  })
);

/**
 * POST /api/conversations/:id/reopen
 * Reabrir conversa
 */
router.post('/:id/reopen',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { data: updatedConversation, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_conversations')
        .update({
          status: 'active',
          updated_at: new Date().toISOString()
        })
        .eq('client_id', req.user.id)
        .eq('id', id)
        .select('*')
        .single()
    );

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao reabrir conversa');
    }

    if (!updatedConversation) {
      return notFound(res, 'Conversa não encontrada');
    }

    success(res, updatedConversation, 'Conversa reaberta com sucesso');
  })
);

/**
 * GET /api/conversations/stats
 * Estatísticas de conversas
 */
router.get('/stats',
  asyncHandler(async (req, res) => {
    // Estatísticas por status
    const { data: statusStats } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_conversations')
        .select('status')
        .eq('client_id', req.user.id)
    );

    // Estatísticas por estágio de lead
    const { data: leadStats } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_conversations')
        .select('lead_stage')
        .eq('client_id', req.user.id)
    );

    // Conversas com mensagens não lidas
    const { count: unreadCount } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_conversations')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', req.user.id)
        .gt('unread_count', 0)
    );

    // Estatísticas hoje
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { count: todayCount } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_conversations')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', req.user.id)
        .gte('created_at', today.toISOString())
    );

    // Processar estatísticas
    const statusSummary = statusStats?.reduce((acc, conv) => {
      acc[conv.status] = (acc[conv.status] || 0) + 1;
      return acc;
    }, {}) || {};

    const leadSummary = leadStats?.reduce((acc, conv) => {
      acc[conv.lead_stage] = (acc[conv.lead_stage] || 0) + 1;
      return acc;
    }, {}) || {};

    const stats = {
      byStatus: statusSummary,
      byLeadStage: leadSummary,
      unreadConversations: unreadCount || 0,
      createdToday: todayCount || 0,
      timestamp: new Date().toISOString()
    };

    success(res, stats, 'Estatísticas recuperadas');
  })
);

module.exports = router;