const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { executeWithRLS, supabaseAdmin } = require('../config/supabase');
const { aiConfigSchemas, validate } = require('../utils/validation');
const { isWithinWorkingHours, getPagination, formatPaginationMeta, formatActivity } = require('../utils/helpers');
const { success, error, notFound, asyncHandler, handleSupabaseError, paginated } = require('../utils/response');
const { emitConfigUpdate, emitAIResponse } = require('../services/socketService');
const { generateAIResponse } = require('../services/aiService');

const router = express.Router();

/**
 * GET /api/ai/config
 * Obter configuração de IA do cliente
 */
router.get('/config',
  asyncHandler(async (req, res) => {
    const { data: config, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_ai_config')
        .select('*')
        .eq('client_id', req.user.id)
        .single()
    );

    if (error && error.code !== 'PGRST116') {
      return handleSupabaseError(res, error, 'Erro ao buscar configuração de IA');
    }

    // Se não existe configuração, criar uma padrão
    if (!config) {
      const defaultConfig = {
        id: uuidv4(),
        client_id: req.user.id,
        enabled: false,
        model: 'gpt-4o-mini',
        max_tokens: 150,
        temperature: 0.7,
        working_hours_enabled: true,
        timezone: 'America/Sao_Paulo',
        working_days: [1, 2, 3, 4, 5, 6, 7],
        hour_start: 9,
        hour_end: 18,
        daily_limit: 50,
        reply_delay_seconds: 8,
        monthly_limit: 1500,
        product_catalog_url: '',
        product_search_enabled: true,
        system_prompt: 'Você é um assistente virtual amigável e prestativo.',
        greeting_message: 'Olá! Como posso ajudar você hoje? 😊',
        fallback_message: 'Desculpe, não consegui entender. Um atendente humano entrará em contato em breve.',
        trigger_keywords: ['preço', 'produto', 'estoque', 'delivery'],
        blacklist_keywords: ['urgente', 'emergência'],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const { data: newConfig, error: createError } = await executeWithRLS(req.user.id, (client) =>
        client
          .from('evolution_ai_config')
          .insert([defaultConfig])
          .select('*')
          .single()
      );

      if (createError) {
        return handleSupabaseError(res, createError, 'Erro ao criar configuração padrão');
      }

      return success(res, newConfig, 'Configuração criada com padrões');
    }

    success(res, config, 'Configuração de IA recuperada');
  })
);

/**
 * PUT /api/ai/config
 * Atualizar configuração de IA
 */
router.put('/config',
  validate(aiConfigSchemas.update),
  asyncHandler(async (req, res) => {
    const updateData = {
      ...req.body,
      updated_at: new Date().toISOString()
    };

    const { data: updatedConfig, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_ai_config')
        .update(updateData)
        .eq('client_id', req.user.id)
        .select('*')
        .single()
    );

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao atualizar configuração de IA');
    }

    // Log da atividade
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .insert([{
          id: uuidv4(),
          client_id: req.user.id,
          ...formatActivity('ai_config_updated', 'Configuração de IA atualizada', {
            updatedFields: Object.keys(req.body)
          })
        }])
    );

    // Emitir evento via WebSocket
    emitConfigUpdate(req.user.id, updatedConfig);

    success(res, updatedConfig, 'Configuração atualizada com sucesso');
  })
);

/**
 * POST /api/ai/test
 * Testar resposta de IA
 */
router.post('/test',
  asyncHandler(async (req, res) => {
    const { message, phone } = req.body;

    if (!message) {
      return error(res, 'Mensagem é obrigatória', 400);
    }

    // Buscar configuração
    const { data: config } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_ai_config')
        .select('*')
        .eq('client_id', req.user.id)
        .single()
    );

    if (!config || !config.enabled) {
      return error(res, 'IA não está habilitada', 400);
    }

    // Verificar horário de funcionamento
    if (!isWithinWorkingHours(config, config.timezone)) {
      return error(res, 'Fora do horário de funcionamento da IA', 400);
    }

    // Verificar limites diários
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { count: todayCount } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_ai_log')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', req.user.id)
        .eq('status', 'success')
        .gte('created_at', today.toISOString())
    );

    if (todayCount >= config.daily_limit) {
      return error(res, 'Limite diário de IA atingido', 429);
    }

    // Buscar API key do cliente
    const { data: client } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_clients')
        .select('openai_api_key, claude_api_key, ai_model')
        .eq('id', req.user.id)
        .single()
    );

    const apiKey = String(config.model || '').includes('claude') ? client?.claude_api_key : client?.openai_api_key;

    if (!apiKey) {
      return error(res, 'API key não configurada', 400);
    }

    try {
      const aiResult = await generateAIResponse({
        supabase: supabaseAdmin,
        clientId: req.user.id,
        message,
        conversation: {
          id: null,
          contact_name: 'Teste manual',
          phone: phone || ''
        },
        contact: {
          name: 'Teste manual',
          phone: phone || ''
        }
      });

      if (aiResult.skipped) {
        return error(res, aiResult.reason || 'IA nao respondeu ao teste', 400);
      }

      const aiResponse = {
        response: aiResult.response,
        model: aiResult.model,
        provider: aiResult.provider,
        tokens_used: aiResult.total_tokens || 0,
        processing_time_ms: aiResult.processing_time_ms
      };

      await executeWithRLS(req.user.id, (client) =>
        client
          .from('evolution_activities')
          .insert([{
            id: uuidv4(),
            client_id: req.user.id,
            related_phone: phone || '',
            ...formatActivity('ai_test', 'Teste de IA realizado', {
              model: aiResult.model,
              provider: aiResult.provider,
              tokens: aiResult.total_tokens || 0
            })
          }])
      );

      return success(res, aiResponse, 'Resposta de IA gerada com sucesso');

    } catch (aiError) {
      // Log do erro
      await executeWithRLS(req.user.id, (client) =>
        client
          .from('evolution_ai_log')
          .insert([{
            id: uuidv4(),
            client_id: req.user.id,
            model_used: config.model,
            status: 'error',
            error_message: aiError.message,
            created_at: new Date().toISOString()
          }])
      );

      return error(res, 'Erro ao gerar resposta de IA', 500, { message: aiError.message });
    }
  })
);

/**
 * GET /api/ai/logs
 * Obter logs de IA com paginação
 */
router.get('/logs',
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 50, status, model, date_from, date_to } = req.query;
    const { page: currentPage, limit: currentLimit, offset } = getPagination(page, limit);

    let query = executeWithRLS(req.user.id, (client) => {
      let baseQuery = client
        .from('evolution_ai_log')
        .select('*', { count: 'exact' })
        .eq('client_id', req.user.id)
        .order('created_at', { ascending: false });

      // Filtros
      if (status) {
        baseQuery = baseQuery.eq('status', status);
      }

      if (model) {
        baseQuery = baseQuery.eq('model_used', model);
      }

      if (date_from) {
        baseQuery = baseQuery.gte('created_at', date_from);
      }

      if (date_to) {
        baseQuery = baseQuery.lte('created_at', date_to);
      }

      return baseQuery.range(offset, offset + currentLimit - 1);
    });

    const { data: logs, error, count } = await query;

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao buscar logs de IA');
    }

    const pagination = formatPaginationMeta(count, currentPage, currentLimit);

    paginated(res, logs, pagination, 'Logs de IA recuperados');
  })
);

/**
 * GET /api/ai/stats
 * Estatísticas de uso da IA
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

    // Total de requests
    const { count: totalRequests } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_ai_log')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', req.user.id)
        .gte('created_at', dateFilter.toISOString())
    );

    // Requests com sucesso
    const { count: successfulRequests } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_ai_log')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', req.user.id)
        .eq('status', 'success')
        .gte('created_at', dateFilter.toISOString())
    );

    // Dados detalhados para cálculos
    const { data: detailedLogs } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_ai_log')
        .select('total_tokens, cost_usd, processing_time_ms, model_used, confidence_score')
        .eq('client_id', req.user.id)
        .eq('status', 'success')
        .gte('created_at', dateFilter.toISOString())
    );

    // Configuração atual
    const { data: config } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_ai_config')
        .select('enabled, daily_limit, monthly_limit')
        .eq('client_id', req.user.id)
        .single()
    );

    // Calcular estatísticas
    const totalTokens = detailedLogs?.reduce((sum, log) => sum + (log.total_tokens || 0), 0) || 0;
    const totalCost = detailedLogs?.reduce((sum, log) => sum + (log.cost_usd || 0), 0) || 0;
    const avgProcessingTime = detailedLogs?.length > 0
      ? detailedLogs.reduce((sum, log) => sum + (log.processing_time_ms || 0), 0) / detailedLogs.length
      : 0;
    const avgConfidence = detailedLogs?.length > 0
      ? detailedLogs.filter(log => log.confidence_score).reduce((sum, log) => sum + log.confidence_score, 0) / detailedLogs.filter(log => log.confidence_score).length
      : 0;

    // Modelos usados
    const modelUsage = detailedLogs?.reduce((acc, log) => {
      acc[log.model_used] = (acc[log.model_used] || 0) + 1;
      return acc;
    }, {}) || {};

    // Limite diário atual
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { count: todayUsage } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_ai_log')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', req.user.id)
        .eq('status', 'success')
        .gte('created_at', today.toISOString())
    );

    const stats = {
      period,
      enabled: config?.enabled || false,
      requests: {
        total: totalRequests || 0,
        successful: successfulRequests || 0,
        failed: (totalRequests || 0) - (successfulRequests || 0),
        successRate: totalRequests > 0 ? ((successfulRequests || 0) / totalRequests * 100).toFixed(1) : 0
      },
      usage: {
        totalTokens,
        totalCost: totalCost.toFixed(6),
        avgProcessingTime: Math.round(avgProcessingTime),
        avgConfidence: avgConfidence.toFixed(2)
      },
      limits: {
        dailyLimit: config?.daily_limit || 50,
        dailyUsed: todayUsage || 0,
        dailyRemaining: Math.max(0, (config?.daily_limit || 50) - (todayUsage || 0)),
        monthlyLimit: config?.monthly_limit || 1500
      },
      models: modelUsage,
      timestamp: new Date().toISOString()
    };

    success(res, stats, 'Estatísticas de IA recuperadas');
  })
);

/**
 * POST /api/ai/enable
 * Habilitar IA
 */
router.post('/enable',
  asyncHandler(async (req, res) => {
    // Verificar se cliente tem API key configurada
    const { data: client } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_clients')
        .select('openai_api_key, claude_api_key, ai_model')
        .eq('id', req.user.id)
        .single()
    );

    if (!client.openai_api_key && !client.claude_api_key) {
      return error(res, 'Configure uma API key antes de habilitar a IA', 400);
    }

    const { data: updatedConfig, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_ai_config')
        .update({
          enabled: true,
          updated_at: new Date().toISOString()
        })
        .eq('client_id', req.user.id)
        .select('*')
        .single()
    );

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao habilitar IA');
    }

    // Log da atividade
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .insert([{
          id: uuidv4(),
          client_id: req.user.id,
          ...formatActivity('ai_enabled', 'IA habilitada')
        }])
    );

    success(res, updatedConfig, 'IA habilitada com sucesso');
  })
);

/**
 * POST /api/ai/disable
 * Desabilitar IA
 */
router.post('/disable',
  asyncHandler(async (req, res) => {
    const { data: updatedConfig, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_ai_config')
        .update({
          enabled: false,
          updated_at: new Date().toISOString()
        })
        .eq('client_id', req.user.id)
        .select('*')
        .single()
    );

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao desabilitar IA');
    }

    // Log da atividade
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .insert([{
          id: uuidv4(),
          client_id: req.user.id,
          ...formatActivity('ai_disabled', 'IA desabilitada')
        }])
    );

    success(res, updatedConfig, 'IA desabilitada com sucesso');
  })
);

module.exports = router;
