const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { executeWithRLS } = require('../config/supabase');
const { clientSchemas, validate } = require('../utils/validation');
const { sanitizeSensitiveData, formatActivity, hashPassword } = require('../utils/helpers');
const { success, error, notFound, asyncHandler, handleSupabaseError } = require('../utils/response');

const router = express.Router();

/**
 * GET /api/clients/profile
 * Obter perfil completo do cliente
 */
router.get('/profile',
  asyncHandler(async (req, res) => {
    const { data: client, error: clientError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_clients')
        .select('*')
        .eq('id', req.user.id)
        .single()
    );

    if (clientError) {
      return handleSupabaseError(res, clientError, 'Erro ao buscar perfil');
    }

    // Buscar configuração de IA
    const { data: aiConfig } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_ai_config')
        .select('*')
        .eq('client_id', req.user.id)
        .single()
    );

    // Sanitizar dados sensíveis
    const sanitizedClient = sanitizeSensitiveData(client);
    const sanitizedAiConfig = aiConfig ? sanitizeSensitiveData(aiConfig) : null;

    success(res, {
      client: sanitizedClient,
      aiConfig: sanitizedAiConfig
    }, 'Perfil recuperado com sucesso');
  })
);

/**
 * PUT /api/clients/profile
 * Atualizar perfil do cliente
 */
router.put('/profile',
  validate(clientSchemas.update),
  asyncHandler(async (req, res) => {
    const updateData = {
      ...req.body,
      updated_at: new Date().toISOString()
    };

    // Se tem nova senha, fazer hash
    if (req.body.password) {
      updateData.password_hash = await hashPassword(req.body.password);
      delete updateData.password;
    }

    const { data: updatedClient, error: updateError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_clients')
        .update(updateData)
        .eq('id', req.user.id)
        .select('*')
        .single()
    );

    if (updateError) {
      return handleSupabaseError(res, updateError, 'Erro ao atualizar perfil');
    }

    // Log da atividade
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .insert([{
          id: uuidv4(),
          client_id: req.user.id,
          ...formatActivity('profile_updated', 'Perfil atualizado', {
            updatedFields: Object.keys(req.body)
          })
        }])
    );

    const sanitizedClient = sanitizeSensitiveData(updatedClient);

    const aiConfigData = {};
    if (req.body.ai_enabled !== undefined) aiConfigData.enabled = req.body.ai_enabled;
    if (req.body.daily_ai_limit !== undefined) aiConfigData.daily_limit = req.body.daily_ai_limit;
    if (req.body.working_hours_start !== undefined) aiConfigData.hour_start = req.body.working_hours_start;
    if (req.body.working_hours_end !== undefined) aiConfigData.hour_end = req.body.working_hours_end;

    if (Object.keys(aiConfigData).length > 0) {
      const { data: currentAIConfig } = await executeWithRLS(req.user.id, (client) =>
        client
          .from('evolution_ai_config')
          .select('id')
          .eq('client_id', req.user.id)
          .single()
      );

      const syncOperation = currentAIConfig
        ? (client) => client
          .from('evolution_ai_config')
          .update({
            ...aiConfigData,
            updated_at: new Date().toISOString()
          })
          .eq('client_id', req.user.id)
        : (client) => client
          .from('evolution_ai_config')
          .insert([{
            id: uuidv4(),
            client_id: req.user.id,
            enabled: aiConfigData.enabled ?? false,
            model: 'gpt-5-mini',
            max_tokens: 500,
            temperature: 0.7,
            working_hours_enabled: true,
            timezone: 'America/Sao_Paulo',
            working_days: [1, 2, 3, 4, 5],
            hour_start: aiConfigData.hour_start ?? 9,
            hour_end: aiConfigData.hour_end ?? 18,
            daily_limit: aiConfigData.daily_limit ?? 50,
            monthly_limit: 1500,
            system_prompt: 'Voce e um assistente virtual amigavel e prestativo.',
            greeting_message: 'Ola! Como posso ajudar voce hoje?',
            fallback_message: 'Desculpe, nao consegui entender. Um atendente humano entrara em contato em breve.',
            trigger_keywords: ['preco', 'produto', 'estoque', 'delivery'],
            blacklist_keywords: ['urgente', 'emergencia'],
            ...aiConfigData,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }]);

      const { error: aiSyncError } = await executeWithRLS(req.user.id, syncOperation);

      if (aiSyncError) {
        console.warn('[CLIENTS] Falha ao sincronizar configuracao de IA:', aiSyncError.message);
      }
    }

    success(res, sanitizedClient, 'Perfil atualizado com sucesso');
  })
);

/**
 * GET /api/clients/stats
 * Obter estatísticas do cliente
 */
router.get('/stats',
  asyncHandler(async (req, res) => {
    // Buscar contagem de contatos
    const { count: contactsCount } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_contacts')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', req.user.id)
    );

    // Buscar contagem de conversas ativas
    const { count: activeConversations } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_conversations')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', req.user.id)
        .eq('status', 'active')
    );

    // Buscar mensagens do mês atual
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { count: monthlyMessages } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_messages')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', req.user.id)
        .gte('created_at', startOfMonth.toISOString())
    );

    // Buscar respostas de IA do dia
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { count: todayAiResponses } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_ai_log')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', req.user.id)
        .eq('status', 'success')
        .gte('created_at', today.toISOString())
    );

    // Buscar configuração atual
    const { data: aiConfig } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_ai_config')
        .select('enabled, daily_limit')
        .eq('client_id', req.user.id)
        .single()
    );

    const stats = {
      contacts: {
        total: contactsCount || 0
      },
      conversations: {
        active: activeConversations || 0
      },
      messages: {
        thisMonth: monthlyMessages || 0
      },
      ai: {
        enabled: aiConfig?.enabled || false,
        responsesToday: todayAiResponses || 0,
        dailyLimit: aiConfig?.daily_limit || 50,
        remainingToday: Math.max(0, (aiConfig?.daily_limit || 50) - (todayAiResponses || 0))
      },
      timestamp: new Date().toISOString()
    };

    success(res, stats, 'Estatísticas recuperadas');
  })
);

/**
 * POST /api/clients/change-password
 * Alterar senha
 */
router.post('/change-password',
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return error(res, 'Senha atual e nova senha são obrigatórias', 400);
    }

    if (newPassword.length < 8) {
      return error(res, 'Nova senha deve ter no mínimo 8 caracteres', 400);
    }

    // Buscar senha atual
    const { data: client, error: findError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_clients')
        .select('password_hash')
        .eq('id', req.user.id)
        .single()
    );

    if (findError) {
      return handleSupabaseError(res, findError, 'Erro ao verificar senha');
    }

    // Verificar senha atual
    const bcrypt = require('bcryptjs');
    const isValidPassword = await bcrypt.compare(currentPassword, client.password_hash);

    if (!isValidPassword) {
      return error(res, 'Senha atual incorreta', 400);
    }

    // Hash da nova senha
    const newPasswordHash = await hashPassword(newPassword);

    // Atualizar senha
    const { error: updateError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_clients')
        .update({
          password_hash: newPasswordHash,
          updated_at: new Date().toISOString()
        })
        .eq('id', req.user.id)
    );

    if (updateError) {
      return handleSupabaseError(res, updateError, 'Erro ao atualizar senha');
    }

    // Log da atividade
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .insert([{
          id: uuidv4(),
          client_id: req.user.id,
          ...formatActivity('password_changed', 'Senha alterada com sucesso')
        }])
    );

    success(res, null, 'Senha alterada com sucesso');
  })
);

/**
 * POST /api/clients/update-plan
 * Atualizar plano do cliente (placeholder - implementar lógica de pagamento)
 */
router.post('/update-plan',
  asyncHandler(async (req, res) => {
    const { plan } = req.body;

    if (!['basic', 'pro', 'enterprise'].includes(plan)) {
      return error(res, 'Plano inválido', 400);
    }

    // TODO: Implementar verificação de pagamento

    const { data: updatedClient, error: updateError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_clients')
        .update({
          plan,
          updated_at: new Date().toISOString()
        })
        .eq('id', req.user.id)
        .select('id, plan, updated_at')
        .single()
    );

    if (updateError) {
      return handleSupabaseError(res, updateError, 'Erro ao atualizar plano');
    }

    // Log da atividade
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .insert([{
          id: uuidv4(),
          client_id: req.user.id,
          ...formatActivity('plan_updated', `Plano alterado para ${plan}`, { plan })
        }])
    );

    success(res, updatedClient, 'Plano atualizado com sucesso');
  })
);

/**
 * DELETE /api/clients/account
 * Excluir conta (soft delete)
 */
router.delete('/account',
  asyncHandler(async (req, res) => {
    const { password } = req.body;

    if (!password) {
      return error(res, 'Senha é obrigatória para excluir conta', 400);
    }

    // Verificar senha
    const { data: client, error: findError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_clients')
        .select('password_hash')
        .eq('id', req.user.id)
        .single()
    );

    if (findError) {
      return handleSupabaseError(res, findError, 'Erro ao verificar senha');
    }

    const bcrypt = require('bcryptjs');
    const isValidPassword = await bcrypt.compare(password, client.password_hash);

    if (!isValidPassword) {
      return error(res, 'Senha incorreta', 400);
    }

    // Soft delete - alterar status para 'deleted'
    const { error: deleteError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_clients')
        .update({
          status: 'deleted',
          email: `deleted_${Date.now()}_${req.user.id}@deleted.com`,
          updated_at: new Date().toISOString()
        })
        .eq('id', req.user.id)
    );

    if (deleteError) {
      return handleSupabaseError(res, deleteError, 'Erro ao excluir conta');
    }

    success(res, null, 'Conta excluída com sucesso');
  })
);

module.exports = router;
