const Joi = require('joi');

// Schemas de validação

const authSchemas = {
  register: Joi.object({
    email: Joi.string().email().required().messages({
      'string.email': 'E-mail inválido',
      'any.required': 'E-mail é obrigatório'
    }),
    password: Joi.string().min(8).required().messages({
      'string.min': 'Senha deve ter no mínimo 8 caracteres',
      'any.required': 'Senha é obrigatória'
    }),
    name: Joi.string().min(2).max(255).required().messages({
      'string.min': 'Nome deve ter no mínimo 2 caracteres',
      'string.max': 'Nome deve ter no máximo 255 caracteres',
      'any.required': 'Nome é obrigatório'
    }),
    company_name: Joi.string().max(255).optional().allow(''),
    phone: Joi.string().max(50).optional().allow(''),
    plan: Joi.string().valid('basic', 'pro', 'enterprise').default('basic')
  }),

  login: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required()
  })
};

const clientSchemas = {
  update: Joi.object({
    name: Joi.string().min(2).max(255).optional(),
    company_name: Joi.string().max(255).optional().allow(''),
    phone: Joi.string().max(50).optional().allow(''),
    google_oauth_token: Joi.string().optional().allow(''),
    google_refresh_token: Joi.string().optional().allow(''),
    icloud_username: Joi.string().max(255).optional().allow(''),
    icloud_password: Joi.string().max(255).optional().allow(''),
    openai_api_key: Joi.string().max(4096).optional().allow(''),
    claude_api_key: Joi.string().max(4096).optional().allow(''),
    ai_enabled: Joi.boolean().optional(),
    daily_ai_limit: Joi.number().integer().min(1).max(1000).optional(),
    auto_reply_enabled: Joi.boolean().optional(),
    working_hours_start: Joi.number().integer().min(0).max(23).optional(),
    working_hours_end: Joi.number().integer().min(0).max(23).optional()
  })
};

const contactSchemas = {
  create: Joi.object({
    phone: Joi.string().max(50).required(),
    name: Joi.string().max(255).required(),
    email: Joi.string().email().optional().allow(''),
    whatsapp_number: Joi.string().max(50).optional().allow(''),
    notes: Joi.string().optional().allow(''),
    status: Joi.string().valid('active', 'inactive', 'blocked').default('active'),
    tags: Joi.array().items(Joi.string()).optional(),
    jid: Joi.string().max(100).optional().allow(''),
    source: Joi.string().valid('whatsapp', 'manual', 'import', 'api').default('manual'),
    first_message: Joi.string().optional().allow('')
  }),

  update: Joi.object({
    name: Joi.string().max(255).optional(),
    email: Joi.string().email().optional().allow(''),
    whatsapp_number: Joi.string().max(50).optional().allow(''),
    notes: Joi.string().optional().allow(''),
    status: Joi.string().valid('active', 'inactive', 'blocked').optional(),
    tags: Joi.array().items(Joi.string()).optional(),
    saved_to_google: Joi.boolean().optional(),
    saved_to_icloud: Joi.boolean().optional(),
    google_contact_id: Joi.string().max(255).optional().allow(''),
    icloud_contact_id: Joi.string().max(255).optional().allow('')
  })
};

const conversationSchemas = {
  create: Joi.object({
    contact_id: Joi.string().uuid().required(),
    jid: Joi.string().max(100).required(),
    phone: Joi.string().max(50).required(),
    contact_name: Joi.string().max(255).optional().allow('')
  }),

  update: Joi.object({
    status: Joi.string().valid('active', 'closed', 'archived').optional(),
    tags: Joi.array().items(Joi.string()).optional(),
    priority: Joi.string().valid('low', 'normal', 'high', 'urgent').optional(),
    assigned_to: Joi.string().max(100).optional().allow(''),
    lead_stage: Joi.string().valid('new', 'contacted', 'qualified', 'proposal', 'won', 'lost').optional(),
    notes: Joi.string().optional().allow(''),
    estimated_value: Joi.number().precision(2).optional().allow(null)
  })
};

const messageSchemas = {
  create: Joi.object({
    conversation_id: Joi.string().uuid().required(),
    message_id: Joi.string().max(255).optional().allow(''),
    jid: Joi.string().max(100).required(),
    phone: Joi.string().max(50).required(),
    content: Joi.string().optional().allow(''),
    message_type: Joi.string().valid('text', 'image', 'audio', 'video', 'document').default('text'),
    media_url: Joi.string().max(500).optional().allow(''),
    media_caption: Joi.string().optional().allow(''),
    direction: Joi.string().valid('incoming', 'outgoing').required(),
    sender_type: Joi.string().valid('contact', 'client', 'ai').optional().allow(''),
    is_ai_response: Joi.boolean().default(false),
    ai_model_used: Joi.string().max(100).optional().allow(''),
    ai_confidence: Joi.number().precision(2).min(0).max(1).optional().allow(null),
    sent_at: Joi.date().iso().required()
  })
};

const aiConfigSchemas = {
  update: Joi.object({
    enabled: Joi.boolean().optional(),
    model: Joi.string().max(100).optional(),
    max_tokens: Joi.number().integer().min(1).max(4000).optional(),
    temperature: Joi.number().precision(2).min(0).max(2).optional(),
    working_hours_enabled: Joi.boolean().optional(),
    timezone: Joi.string().max(50).optional(),
    working_days: Joi.array().items(Joi.number().integer().min(1).max(7)).optional(),
    hour_start: Joi.number().integer().min(0).max(23).optional(),
    hour_end: Joi.number().integer().min(0).max(23).optional(),
    daily_limit: Joi.number().integer().min(1).max(1000).optional(),
    reply_delay_seconds: Joi.number().integer().min(1).max(60).optional(),
    monthly_limit: Joi.number().integer().min(1).max(50000).optional(),
    product_catalog_url: Joi.string().max(1000).optional().allow(''),
    product_search_enabled: Joi.boolean().optional(),
    system_prompt: Joi.string().optional().allow(''),
    greeting_message: Joi.string().optional().allow(''),
    fallback_message: Joi.string().optional().allow(''),
    trigger_keywords: Joi.array().items(Joi.string()).optional(),
    blacklist_keywords: Joi.array().items(Joi.string()).optional()
  })
};

const integrationSchemas = {
  create: Joi.object({
    integration_type: Joi.string().max(100).required(),
    integration_name: Joi.string().max(255).required(),
    api_endpoint: Joi.string().max(500).optional().allow(''),
    api_key: Joi.string().max(4096).optional().allow(''),
    api_secret: Joi.string().max(4096).optional().allow(''),
    config: Joi.object().optional(),
    enabled: Joi.boolean().default(true)
  }),

  update: Joi.object({
    integration_name: Joi.string().max(255).optional(),
    api_endpoint: Joi.string().max(500).optional().allow(''),
    api_key: Joi.string().max(4096).optional().allow(''),
    api_secret: Joi.string().max(4096).optional().allow(''),
    config: Joi.object().optional(),
    enabled: Joi.boolean().optional()
  })
};

/**
 * Middleware de validação genérico
 * @param {Object} schema - Schema Joi para validação
 * @param {string} property - Propriedade da request a validar (body, query, params)
 */
const validate = (schema, property = 'body') => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      const errorMessages = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }));

      return res.status(400).json({
        error: 'Dados inválidos',
        details: errorMessages
      });
    }

    // Substituir dados validados
    req[property] = value;
    next();
  };
};

module.exports = {
  authSchemas,
  clientSchemas,
  contactSchemas,
  conversationSchemas,
  messageSchemas,
  aiConfigSchemas,
  integrationSchemas,
  validate
};
