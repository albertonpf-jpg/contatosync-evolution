const express = require('express');
const { executeWithRLS } = require('../config/supabase');
const { getPagination, formatPaginationMeta } = require('../utils/helpers');
const { success, asyncHandler, handleSupabaseError, paginated } = require('../utils/response');

const router = express.Router();

/**
 * GET /api/activities
 * Listar atividades do cliente com paginação e filtros
 */
router.get('/',
  asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 50,
      activity_type,
      date_from,
      date_to,
      related_phone,
      search
    } = req.query;

    const { page: currentPage, limit: currentLimit, offset } = getPagination(page, limit);

    let query = executeWithRLS(req.user.id, (client) => {
      let baseQuery = client
        .from('evolution_activities')
        .select('*', { count: 'exact' })
        .eq('client_id', req.user.id)
        .order('created_at', { ascending: false });

      // Filtros
      if (activity_type) {
        baseQuery = baseQuery.eq('activity_type', activity_type);
      }

      if (date_from) {
        baseQuery = baseQuery.gte('created_at', date_from);
      }

      if (date_to) {
        baseQuery = baseQuery.lte('created_at', date_to);
      }

      if (related_phone) {
        baseQuery = baseQuery.eq('related_phone', related_phone);
      }

      if (search) {
        baseQuery = baseQuery.ilike('description', `%${search}%`);
      }

      return baseQuery.range(offset, offset + currentLimit - 1);
    });

    const { data: activities, error, count } = await query;

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao buscar atividades');
    }

    const pagination = formatPaginationMeta(count, currentPage, currentLimit);

    paginated(res, activities, pagination, 'Atividades recuperadas com sucesso');
  })
);

/**
 * GET /api/activities/types
 * Listar tipos de atividades disponíveis
 */
router.get('/types',
  asyncHandler(async (req, res) => {
    const { data: activities } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .select('activity_type')
        .eq('client_id', req.user.id)
    );

    // Extrair tipos únicos
    const uniqueTypes = [...new Set(activities?.map(activity => activity.activity_type) || [])];

    // Tipos padrão do sistema
    const systemTypes = [
      'contact_created',
      'contact_updated',
      'contact_deleted',
      'contacts_imported',
      'conversation_created',
      'conversation_updated',
      'conversation_archived',
      'message_sent',
      'message_received',
      'ai_response_sent',
      'ai_enabled',
      'ai_disabled',
      'ai_config_updated',
      'ai_test',
      'login',
      'logout',
      'account_created',
      'profile_updated',
      'password_changed',
      'plan_updated',
      'integration_added',
      'integration_updated',
      'integration_removed',
      'whatsapp_connected',
      'whatsapp_disconnected',
      'error_occurred'
    ];

    // Combinar e remover duplicatas
    const allTypes = [...new Set([...systemTypes, ...uniqueTypes])].sort();

    success(res, allTypes, 'Tipos de atividades recuperados');
  })
);

/**
 * GET /api/activities/stats
 * Estatísticas de atividades
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

    // Buscar atividades do período
    const { data: activities } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .select('activity_type, created_at')
        .eq('client_id', req.user.id)
        .gte('created_at', dateFilter.toISOString())
    );

    // Contar por tipo
    const byType = activities?.reduce((acc, activity) => {
      acc[activity.activity_type] = (acc[activity.activity_type] || 0) + 1;
      return acc;
    }, {}) || {};

    // Atividades por dia (últimos 7 dias)
    const byDay = {};
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateKey = date.toISOString().split('T')[0];

      byDay[dateKey] = activities?.filter(activity => {
        const activityDate = new Date(activity.created_at).toISOString().split('T')[0];
        return activityDate === dateKey;
      }).length || 0;
    }

    // Atividades mais comuns
    const topActivities = Object.entries(byType)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([type, count]) => ({ type, count }));

    const stats = {
      period,
      total: activities?.length || 0,
      byType,
      byDay,
      topActivities,
      timestamp: new Date().toISOString()
    };

    success(res, stats, 'Estatísticas de atividades recuperadas');
  })
);

/**
 * GET /api/activities/recent
 * Atividades recentes (últimas 20)
 */
router.get('/recent',
  asyncHandler(async (req, res) => {
    const { limit = 20 } = req.query;

    const { data: activities, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .select('*')
        .eq('client_id', req.user.id)
        .order('created_at', { ascending: false })
        .limit(Math.min(limit, 100)) // Máximo de 100
    );

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao buscar atividades recentes');
    }

    success(res, activities, 'Atividades recentes recuperadas');
  })
);

/**
 * GET /api/activities/timeline
 * Timeline de atividades agrupadas por data
 */
router.get('/timeline',
  asyncHandler(async (req, res) => {
    const { days = 7, limit_per_day = 10 } = req.query;

    const dateFilter = new Date();
    dateFilter.setDate(dateFilter.getDate() - days);

    const { data: activities, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .select('*')
        .eq('client_id', req.user.id)
        .gte('created_at', dateFilter.toISOString())
        .order('created_at', { ascending: false })
    );

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao buscar timeline');
    }

    // Agrupar por data
    const timeline = {};

    activities?.forEach(activity => {
      const date = new Date(activity.created_at).toISOString().split('T')[0];

      if (!timeline[date]) {
        timeline[date] = [];
      }

      if (timeline[date].length < limit_per_day) {
        timeline[date].push(activity);
      }
    });

    // Converter para array ordenado
    const timelineArray = Object.entries(timeline)
      .map(([date, activities]) => ({
        date,
        count: activities.length,
        activities: activities.slice(0, limit_per_day)
      }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    success(res, timelineArray, 'Timeline recuperada');
  })
);

/**
 * GET /api/activities/contact/:contact_id
 * Atividades relacionadas a um contato específico
 */
router.get('/contact/:contact_id',
  asyncHandler(async (req, res) => {
    const { contact_id } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const { page: currentPage, limit: currentLimit, offset } = getPagination(page, limit);

    const { data: activities, error, count } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .select('*', { count: 'exact' })
        .eq('client_id', req.user.id)
        .eq('related_contact_id', contact_id)
        .order('created_at', { ascending: false })
        .range(offset, offset + currentLimit - 1)
    );

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao buscar atividades do contato');
    }

    const pagination = formatPaginationMeta(count, currentPage, currentLimit);

    paginated(res, activities, pagination, 'Atividades do contato recuperadas');
  })
);

/**
 * GET /api/activities/conversation/:conversation_id
 * Atividades relacionadas a uma conversa específica
 */
router.get('/conversation/:conversation_id',
  asyncHandler(async (req, res) => {
    const { conversation_id } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const { page: currentPage, limit: currentLimit, offset } = getPagination(page, limit);

    const { data: activities, error, count } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .select('*', { count: 'exact' })
        .eq('client_id', req.user.id)
        .eq('related_conversation_id', conversation_id)
        .order('created_at', { ascending: false })
        .range(offset, offset + currentLimit - 1)
    );

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao buscar atividades da conversa');
    }

    const pagination = formatPaginationMeta(count, currentPage, currentLimit);

    paginated(res, activities, pagination, 'Atividades da conversa recuperadas');
  })
);

/**
 * DELETE /api/activities/old
 * Limpar atividades antigas (mais de 90 dias)
 */
router.delete('/old',
  asyncHandler(async (req, res) => {
    const { days = 90 } = req.query;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const { error, count } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .delete({ count: 'exact' })
        .eq('client_id', req.user.id)
        .lt('created_at', cutoffDate.toISOString())
    );

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao limpar atividades antigas');
    }

    success(res, {
      deletedCount: count,
      cutoffDate: cutoffDate.toISOString(),
      daysOld: days
    }, `${count} atividades antigas foram removidas`);
  })
);

module.exports = router;