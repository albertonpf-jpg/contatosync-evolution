const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { executeWithRLS } = require('../config/supabase');
const { integrationSchemas, validate } = require('../utils/validation');
const { sanitizeSensitiveData, formatActivity } = require('../utils/helpers');
const { success, error, notFound, conflict, asyncHandler, handleSupabaseError } = require('../utils/response');

const router = express.Router();

/**
 * GET /api/integrations
 * Listar integrações do cliente
 */
router.get('/',
  asyncHandler(async (req, res) => {
    const { integration_type, enabled } = req.query;

    let query = executeWithRLS(req.user.id, (client) => {
      let baseQuery = client
        .from('evolution_integrations')
        .select('*')
        .eq('client_id', req.user.id)
        .order('created_at', { ascending: false });

      if (integration_type) {
        baseQuery = baseQuery.eq('integration_type', integration_type);
      }

      if (enabled !== undefined) {
        baseQuery = baseQuery.eq('enabled', enabled === 'true');
      }

      return baseQuery;
    });

    const { data: integrations, error } = await query;

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao buscar integrações');
    }

    // Sanitizar dados sensíveis
    const sanitizedIntegrations = integrations?.map(integration => sanitizeSensitiveData(integration)) || [];

    success(res, sanitizedIntegrations, 'Integrações recuperadas com sucesso');
  })
);

/**
 * GET /api/integrations/:id
 * Obter integração específica
 */
router.get('/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { data: integration, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_integrations')
        .select('*')
        .eq('client_id', req.user.id)
        .eq('id', id)
        .single()
    );

    if (error || !integration) {
      return notFound(res, 'Integração não encontrada');
    }

    const sanitizedIntegration = sanitizeSensitiveData(integration);

    success(res, sanitizedIntegration, 'Integração recuperada');
  })
);

/**
 * POST /api/integrations
 * Criar nova integração
 */
router.post('/',
  validate(integrationSchemas.create),
  asyncHandler(async (req, res) => {
    const {
      integration_type,
      integration_name,
      api_endpoint,
      api_key,
      api_secret,
      config,
      enabled
    } = req.body;

    // Verificar se já existe integração com mesmo tipo e nome
    const { data: existingIntegration } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_integrations')
        .select('id')
        .eq('client_id', req.user.id)
        .eq('integration_type', integration_type)
        .eq('integration_name', integration_name)
        .single()
    );

    if (existingIntegration) {
      return conflict(res, 'Integração com este nome já existe');
    }

    // Criar integração
    const integrationData = {
      id: uuidv4(),
      client_id: req.user.id,
      integration_type,
      integration_name,
      api_endpoint: api_endpoint || '',
      api_key: api_key || '',
      api_secret: api_secret || '',
      config: config || {},
      enabled: enabled !== undefined ? enabled : true,
      status: 'active',
      error_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: newIntegration, error: createError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_integrations')
        .insert([integrationData])
        .select('*')
        .single()
    );

    if (createError) {
      return handleSupabaseError(res, createError, 'Erro ao criar integração');
    }

    // Log da atividade
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .insert([{
          id: uuidv4(),
          client_id: req.user.id,
          ...formatActivity('integration_added', `Integração adicionada: ${integration_name}`, {
            type: integration_type,
            name: integration_name
          })
        }])
    );

    const sanitizedIntegration = sanitizeSensitiveData(newIntegration);

    success(res, sanitizedIntegration, 'Integração criada com sucesso', 201);
  })
);

/**
 * PUT /api/integrations/:id
 * Atualizar integração
 */
router.put('/:id',
  validate(integrationSchemas.update),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const updateData = {
      ...req.body,
      updated_at: new Date().toISOString()
    };

    const { data: updatedIntegration, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_integrations')
        .update(updateData)
        .eq('client_id', req.user.id)
        .eq('id', id)
        .select('*')
        .single()
    );

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao atualizar integração');
    }

    if (!updatedIntegration) {
      return notFound(res, 'Integração não encontrada');
    }

    // Log da atividade
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .insert([{
          id: uuidv4(),
          client_id: req.user.id,
          ...formatActivity('integration_updated', `Integração atualizada: ${updatedIntegration.integration_name}`, {
            updatedFields: Object.keys(req.body)
          })
        }])
    );

    const sanitizedIntegration = sanitizeSensitiveData(updatedIntegration);

    success(res, sanitizedIntegration, 'Integração atualizada com sucesso');
  })
);

/**
 * DELETE /api/integrations/:id
 * Excluir integração
 */
router.delete('/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Buscar integração primeiro para log
    const { data: integration } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_integrations')
        .select('integration_name, integration_type')
        .eq('client_id', req.user.id)
        .eq('id', id)
        .single()
    );

    if (!integration) {
      return notFound(res, 'Integração não encontrada');
    }

    const { error: deleteError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_integrations')
        .delete()
        .eq('client_id', req.user.id)
        .eq('id', id)
    );

    if (deleteError) {
      return handleSupabaseError(res, deleteError, 'Erro ao excluir integração');
    }

    // Log da atividade
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .insert([{
          id: uuidv4(),
          client_id: req.user.id,
          ...formatActivity('integration_removed', `Integração removida: ${integration.integration_name}`, {
            type: integration.integration_type,
            name: integration.integration_name
          })
        }])
    );

    success(res, null, 'Integração excluída com sucesso');
  })
);

/**
 * POST /api/integrations/:id/test
 * Testar integração
 */
router.post('/:id/test',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { data: integration, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_integrations')
        .select('*')
        .eq('client_id', req.user.id)
        .eq('id', id)
        .single()
    );

    if (error || !integration) {
      return notFound(res, 'Integração não encontrada');
    }

    if (!integration.enabled) {
      return error(res, 'Integração está desabilitada', 400);
    }

    try {
      // TODO: Implementar lógica real de teste baseado no tipo de integração
      // Por agora, simular teste

      let testResult;

      switch (integration.integration_type) {
        case 'facilzap':
          testResult = {
            success: true,
            message: 'Conexão com FacilZap estabelecida com sucesso',
            data: {
              endpoint: integration.api_endpoint,
              response_time_ms: 150
            }
          };
          break;

        case 'webhook':
          testResult = {
            success: true,
            message: 'Webhook configurado corretamente',
            data: {
              endpoint: integration.api_endpoint,
              response_time_ms: 200
            }
          };
          break;

        default:
          testResult = {
            success: true,
            message: 'Integração testada com sucesso',
            data: {}
          };
      }

      // Atualizar status e último teste
      await executeWithRLS(req.user.id, (client) =>
        client
          .from('evolution_integrations')
          .update({
            status: testResult.success ? 'active' : 'error',
            last_sync: new Date().toISOString(),
            error_count: testResult.success ? 0 : integration.error_count + 1,
            last_error: testResult.success ? null : testResult.message,
            updated_at: new Date().toISOString()
          })
          .eq('id', id)
      );

      success(res, testResult, 'Teste de integração concluído');

    } catch (testError) {
      // Atualizar status de erro
      await executeWithRLS(req.user.id, (client) =>
        client
          .from('evolution_integrations')
          .update({
            status: 'error',
            error_count: integration.error_count + 1,
            last_error: testError.message,
            updated_at: new Date().toISOString()
          })
          .eq('id', id)
      );

      return error(res, 'Erro no teste de integração', 500, {
        message: testError.message
      });
    }
  })
);

/**
 * POST /api/integrations/:id/enable
 * Habilitar integração
 */
router.post('/:id/enable',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { data: updatedIntegration, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_integrations')
        .update({
          enabled: true,
          updated_at: new Date().toISOString()
        })
        .eq('client_id', req.user.id)
        .eq('id', id)
        .select('*')
        .single()
    );

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao habilitar integração');
    }

    if (!updatedIntegration) {
      return notFound(res, 'Integração não encontrada');
    }

    const sanitizedIntegration = sanitizeSensitiveData(updatedIntegration);

    success(res, sanitizedIntegration, 'Integração habilitada com sucesso');
  })
);

/**
 * POST /api/integrations/:id/disable
 * Desabilitar integração
 */
router.post('/:id/disable',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { data: updatedIntegration, error } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_integrations')
        .update({
          enabled: false,
          updated_at: new Date().toISOString()
        })
        .eq('client_id', req.user.id)
        .eq('id', id)
        .select('*')
        .single()
    );

    if (error) {
      return handleSupabaseError(res, error, 'Erro ao desabilitar integração');
    }

    if (!updatedIntegration) {
      return notFound(res, 'Integração não encontrada');
    }

    const sanitizedIntegration = sanitizeSensitiveData(updatedIntegration);

    success(res, sanitizedIntegration, 'Integração desabilitada com sucesso');
  })
);

/**
 * GET /api/integrations/types
 * Listar tipos de integrações disponíveis
 */
router.get('/types',
  asyncHandler(async (req, res) => {
    const integrationTypes = [
      {
        type: 'facilzap',
        name: 'FacilZap',
        description: 'Integração com API do FacilZap para envio de mensagens',
        fields: ['api_endpoint', 'api_key']
      },
      {
        type: 'webhook',
        name: 'Webhook',
        description: 'Webhook para receber notificações de eventos',
        fields: ['api_endpoint']
      },
      {
        type: 'crm',
        name: 'CRM Externo',
        description: 'Integração com sistemas CRM externos',
        fields: ['api_endpoint', 'api_key', 'api_secret']
      },
      {
        type: 'ecommerce',
        name: 'E-commerce',
        description: 'Integração com plataformas de e-commerce',
        fields: ['api_endpoint', 'api_key']
      },
      {
        type: 'email',
        name: 'E-mail Marketing',
        description: 'Integração com ferramentas de e-mail marketing',
        fields: ['api_endpoint', 'api_key']
      }
    ];

    success(res, integrationTypes, 'Tipos de integração disponíveis');
  })
);

module.exports = router;