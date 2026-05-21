const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../config/supabase');
const { success, error, asyncHandler } = require('../utils/response');
const { formatActivity } = require('../utils/helpers');
const {
  buildProductContextForConfig,
  buildSiteContextForConfig,
  buildDifyKnowledgeContextForConfig,
  buildOperationalContextForConfig
} = require('../services/aiService');
const { getDifyToolApiKey } = require('../services/difyService');

const router = express.Router();

function getBearerToken(req) {
  const header = String(req.headers.authorization || '');
  if (/^bearer\s+/i.test(header)) return header.replace(/^bearer\s+/i, '').trim();
  return String(req.headers['x-dify-tool-key'] || req.query.tool_key || '').trim();
}

function requireDifyToolAuth(req, res, next) {
  const configured = getDifyToolApiKey();
  if (!configured) return error(res, 'DIFY_TOOL_API_KEY nao configurado no servidor', 503);
  if (getBearerToken(req) !== configured) return error(res, 'Nao autorizado', 401);
  next();
}

function normalizeType(value = '') {
  const type = String(value || 'all').trim().toLowerCase();
  if (['all', 'catalog', 'products', 'site', 'files', 'knowledge', 'operational', 'api'].includes(type)) return type;
  return 'all';
}

async function getClientConfig(clientId) {
  const { data, error: dbError } = await supabaseAdmin
    .from('evolution_ai_config')
    .select('*')
    .eq('client_id', clientId)
    .single();
  if (dbError) throw dbError;
  return data;
}

async function getConversationContext(clientId, conversationId, phone) {
  let conversation = null;
  let contact = null;

  if (conversationId) {
    const { data } = await supabaseAdmin
      .from('evolution_conversations')
      .select('*, evolution_contacts(*)')
      .eq('client_id', clientId)
      .eq('id', conversationId)
      .single();
    conversation = data || null;
    contact = data?.evolution_contacts || null;
  }

  if (!contact && phone) {
    const { data } = await supabaseAdmin
      .from('evolution_contacts')
      .select('*')
      .eq('client_id', clientId)
      .eq('phone', phone)
      .single();
    contact = data || null;
  }

  const historyQuery = supabaseAdmin
    .from('evolution_messages')
    .select('content, direction, is_from_ai, created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(12);

  if (conversationId) historyQuery.eq('conversation_id', conversationId);
  const { data: recentMessages } = await historyQuery;
  const conversationHistory = (recentMessages || []).reverse();

  return { conversation, contact, conversationHistory };
}

function trimContext(value = '', max = 12000) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n\n[conteudo truncado]';
}

function compactProductCards(cards = []) {
  return (Array.isArray(cards) ? cards : []).slice(0, 12).map(card => ({
    title: card.title || '',
    description: card.description || '',
    url: card.url || '',
    imageUrl: card.imageUrl || ''
  }));
}

router.use(requireDifyToolAuth);

router.get('/manifest', asyncHandler(async (req, res) => {
  const baseUrl = String(req.protocol + '://' + req.get('host')).replace(/\/+$/, '');
  success(res, {
    name: 'ContatoSync Dify Tool Gateway',
    description: 'Ferramentas para o Dify consultar catalogo/API, site/URLs, arquivos/base e executar acoes POST controladas.',
    auth: 'Authorization: Bearer <DIFY_TOOL_API_KEY>',
    tools: [
      {
        method: 'GET',
        url: `${baseUrl}/api/dify-tools/search`,
        query: {
          client_id: 'uuid do cliente',
          type: 'all|catalog|site|files|operational',
          query: 'consulta do cliente',
          conversation_id: 'opcional',
          phone: 'opcional'
        }
      },
      {
        method: 'POST',
        url: `${baseUrl}/api/dify-tools/action`,
        body: {
          client_id: 'uuid do cliente',
          action: 'create_activity|update_contact_tags',
          payload: {}
        }
      }
    ]
  }, 'Manifesto de ferramentas do Dify');
}));

router.get('/search', asyncHandler(async (req, res) => {
  const clientId = String(req.query.client_id || req.query.clientId || '').trim();
  const query = String(req.query.query || req.query.q || '').trim();
  const type = normalizeType(req.query.type);
  const conversationId = String(req.query.conversation_id || req.query.conversationId || '').trim();
  const phone = String(req.query.phone || '').trim();

  if (!clientId) return error(res, 'client_id e obrigatorio', 400);
  if (!query) return error(res, 'query e obrigatoria', 400);

  const config = await getClientConfig(clientId);
  const { conversation, contact, conversationHistory } = await getConversationContext(clientId, conversationId, phone);
  const result = {
    client_id: clientId,
    query,
    type,
    sources: {}
  };

  if (type === 'all' || type === 'catalog' || type === 'products') {
    const productContext = await buildProductContextForConfig(query, config, conversationHistory, { conversation });
    result.sources.catalog = {
      lookup_attempted: productContext.lookupAttempted === true,
      products_found: productContext.productsFound === true,
      search_text: productContext.searchText || '',
      context: trimContext(productContext.contextText, 12000),
      cards: compactProductCards(productContext.productCards),
      products: productContext.product_context_products || productContext.recent_products_data || []
    };
  }

  if (type === 'all' || type === 'site') {
    const siteContext = await buildSiteContextForConfig(query, config, { force: true });
    result.sources.site = {
      lookup_attempted: siteContext.lookupAttempted === true,
      context: trimContext(siteContext.contextText, 10000)
    };
  }

  if (type === 'all' || type === 'files' || type === 'knowledge') {
    result.sources.files = {
      context: trimContext(buildDifyKnowledgeContextForConfig(config), 12000)
    };
  }

  if (type === 'all' || type === 'operational' || type === 'api') {
    const operationalContext = await buildOperationalContextForConfig(query, config, contact, conversation);
    result.sources.operational = {
      lookup_attempted: operationalContext.lookupAttempted === true,
      context: trimContext(operationalContext.contextText, 10000)
    };
  }

  console.log('[DIFY TOOL SEARCH] ' + JSON.stringify({
    clientId,
    type,
    query: query.slice(0, 180),
    catalogCards: result.sources.catalog?.cards?.length || 0,
    hasSite: Boolean(result.sources.site?.context),
    hasFiles: Boolean(result.sources.files?.context),
    hasOperational: Boolean(result.sources.operational?.context)
  }));

  success(res, result, 'Busca executada para o Dify');
}));

router.post('/action', asyncHandler(async (req, res) => {
  const clientId = String(req.body.client_id || req.body.clientId || '').trim();
  const action = String(req.body.action || '').trim();
  const payload = req.body.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
  if (!clientId) return error(res, 'client_id e obrigatorio', 400);

  if (action === 'create_activity') {
    const description = String(payload.description || payload.message || 'Atividade criada pelo Dify').trim().slice(0, 500);
    const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
    const { data, error: dbError } = await supabaseAdmin
      .from('evolution_activities')
      .insert([{
        id: uuidv4(),
        client_id: clientId,
        ...formatActivity('dify_tool_activity', description, metadata)
      }])
      .select('*')
      .single();
    if (dbError) throw dbError;
    return success(res, data, 'Atividade criada pelo Dify');
  }

  if (action === 'update_contact_tags') {
    const contactId = String(payload.contact_id || payload.contactId || '').trim();
    const phone = String(payload.phone || '').trim();
    const tags = Array.isArray(payload.tags) ? payload.tags.map(String).slice(0, 20) : [];
    if (!contactId && !phone) return error(res, 'contact_id ou phone e obrigatorio', 400);
    let query = supabaseAdmin
      .from('evolution_contacts')
      .update({ tags, updated_at: new Date().toISOString() })
      .eq('client_id', clientId)
      .select('*')
      .single();
    query = contactId ? query.eq('id', contactId) : query.eq('phone', phone);
    const { data, error: dbError } = await query;
    if (dbError) throw dbError;
    return success(res, data, 'Tags do contato atualizadas pelo Dify');
  }

  return error(res, 'Acao nao permitida para o Dify', 400, {
    allowed_actions: ['create_activity', 'update_contact_tags']
  });
}));

module.exports = router;
