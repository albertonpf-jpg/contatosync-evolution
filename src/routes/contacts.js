const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { executeWithRLS } = require('../config/supabase');
const { contactSchemas, validate } = require('../utils/validation');
const { formatPhone, getPagination, formatPaginationMeta, formatActivity } = require('../utils/helpers');
const { success, error, notFound, conflict, asyncHandler, handleSupabaseError, paginated } = require('../utils/response');
const { emitNewContact, emitActivity } = require('../services/socketService');

const router = express.Router();

/**
 * GET /api/contacts
 * Listar contatos do cliente com paginação e filtros
 */
router.get('/',
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, search, source, saved_to_google, saved_to_icloud } = req.query;
    const { page: currentPage, limit: currentLimit, offset } = getPagination(page, limit);

    let query = executeWithRLS(req.user.id, (client) => {
      let baseQuery = client
        .from('evolution_contacts')
        .select('*', { count: 'exact' })
        .eq('client_id', req.user.id)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });

      if (search) {
        baseQuery = baseQuery.or(`name.ilike.%${search}%, phone.ilike.%${search}%`);
      }
      if (source) {
        baseQuery = baseQuery.eq('source', source);
      }
      if (saved_to_google !== undefined) {
        baseQuery = baseQuery.eq('saved_to_google', saved_to_google === 'true');
      }
      if (saved_to_icloud !== undefined) {
        baseQuery = baseQuery.eq('saved_to_icloud', saved_to_icloud === 'true');
      }
      return baseQuery.range(offset, offset + currentLimit - 1);
    });

    const { data: contacts, error: queryError, count } = await query;
    if (queryError) {
      return handleSupabaseError(res, queryError, 'Erro ao buscar contatos');
    }
    const pagination = formatPaginationMeta(count, currentPage, currentLimit);
    paginated(res, contacts, pagination, 'Contatos recuperados com sucesso');
  })
);

/**
 * GET /api/contacts/export — CORRIGIDO: antes de /:id para evitar conflito
 * Exportar contatos como CSV
 */
router.get('/export',
  asyncHandler(async (req, res) => {
    const { data: contacts, error: queryError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_contacts')
        .select('name, phone, source, saved_to_google, saved_to_icloud, created_at')
        .eq('client_id', req.user.id)
        .order('created_at', { ascending: false })
    );
    if (queryError) {
      return handleSupabaseError(res, queryError, 'Erro ao exportar contatos');
    }
    const csvHeaders = 'Nome,Telefone,Origem,Google,iCloud,Data Criação\n';
    const csvData = contacts.map(contact => [
      contact.name || '',
      contact.phone || '',
      contact.source || '',
      contact.saved_to_google ? 'Sim' : 'Não',
      contact.saved_to_icloud ? 'Sim' : 'Não',
      new Date(contact.created_at).toLocaleString('pt-BR')
    ].join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="contatos.csv"');
    res.send(csvHeaders + csvData);
  })
);

/**
 * GET /api/contacts/:id
 * Obter contato específico
 */
router.get('/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { data: contact, error: queryError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_contacts')
        .select('*')
        .eq('client_id', req.user.id)
        .eq('id', id)
        .single()
    );
    if (queryError || !contact) {
      return notFound(res, 'Contato não encontrado');
    }
    success(res, contact, 'Contato recuperado');
  })
);

/**
 * POST /api/contacts
 * Criar novo contato
 */
router.post('/',
  validate(contactSchemas.create),
  asyncHandler(async (req, res) => {
    const { phone, name, email, whatsapp_number, notes, status, tags, jid, source, first_message } = req.body;
    const formattedPhone = formatPhone(phone);
    if (!formattedPhone) {
      return error(res, 'Número de telefone inválido', 400);
    }

    // Verificar se contato já existe
    const { data: existingContact } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_contacts')
        .select('id')
        .eq('client_id', req.user.id)
        .eq('phone', formattedPhone)
        .single()
    );
    if (existingContact) {
      return conflict(res, 'Contato já existe para este número');
    }

    const contactData = {
      id: uuidv4(),
      client_id: req.user.id,
      phone: formattedPhone,
      name: name,
      email: email || null,
      whatsapp_number: whatsapp_number || null,
      notes: notes || null,
      status: status || 'active',
      tags: tags || null,
      last_message_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: newContact, error: createError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_contacts')
        .insert([contactData])
        .select('*')
        .single()
    );
    if (createError) {
      return handleSupabaseError(res, createError, 'Erro ao criar contato');
    }

    // Atualizar estatísticas do cliente
    await executeWithRLS(req.user.id, (client) =>
      client.rpc('update_client_stats', { client_uuid: req.user.id })
    );

    // Log da atividade
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .insert([{
          id: uuidv4(),
          client_id: req.user.id,
          ...formatActivity('contact_created', `Contato criado: ${newContact.name}`, {
            source: newContact.source,
            phone: formattedPhone,
            contact_id: newContact.id
          })
        }])
    );

    // Emitir evento via WebSocket
    emitNewContact(req.user.id, newContact);
    emitActivity(req.user.id, {
      type: 'contact_created',
      description: `Contato criado: ${newContact.name}`,
      phone: formattedPhone
    });

    success(res, newContact, 'Contato criado com sucesso', 201);
  })
);

/**
 * PUT /api/contacts/:id
 * Atualizar contato
 */
router.put('/:id',
  validate(contactSchemas.update),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const updateData = {
      ...req.body,
      updated_at: new Date().toISOString()
    };

    const { data: updatedContact, error: updateError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_contacts')
        .update(updateData)
        .eq('client_id', req.user.id)
        .eq('id', id)
        .select('*')
        .single()
    );
    if (updateError) {
      return handleSupabaseError(res, updateError, 'Erro ao atualizar contato');
    }
    if (!updatedContact) {
      return notFound(res, 'Contato não encontrado');
    }

    // Log da atividade
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .insert([{
          id: uuidv4(),
          client_id: req.user.id,
          ...formatActivity('contact_updated', `Contato atualizado: ${updatedContact.name}`, {
            updatedFields: Object.keys(req.body),
            phone: updatedContact.phone,
            contact_id: updatedContact.id
          })
        }])
    );

    success(res, updatedContact, 'Contato atualizado com sucesso');
  })
);

/**
 * DELETE /api/contacts/:id
 * Excluir contato
 */
router.delete('/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { data: contact } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_contacts')
        .select('name, phone')
        .eq('client_id', req.user.id)
        .eq('id', id)
        .single()
    );
    if (!contact) {
      return notFound(res, 'Contato não encontrado');
    }

    const { error: deleteError } = await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_contacts')
        .delete()
        .eq('client_id', req.user.id)
        .eq('id', id)
    );
    if (deleteError) {
      return handleSupabaseError(res, deleteError, 'Erro ao excluir contato');
    }

    // Atualizar estatísticas
    await executeWithRLS(req.user.id, (client) =>
      client.rpc('update_client_stats', { client_uuid: req.user.id })
    );

    // Log da atividade
    await executeWithRLS(req.user.id, (client) =>
      client
        .from('evolution_activities')
        .insert([{
          id: uuidv4(),
          client_id: req.user.id,
          ...formatActivity('contact_deleted', `Contato excluído: ${contact.name}`, {
            phone: contact.phone
          })
        }])
    );

    success(res, null, 'Contato excluído com sucesso');
  })
);

/**
 * POST /api/contacts/bulk
 * Importar múltiplos contatos
 */
router.post('/bulk',
  asyncHandler(async (req, res) => {
    const { contacts } = req.body;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return error(res, 'Lista de contatos inválida', 400);
    }
    if (contacts.length > 1000) {
      return error(res, 'Máximo de 1000 contatos por importação', 400);
    }

    const results = { created: 0, skipped: 0, errors: [] };

    for (const contactData of contacts) {
      try {
        const formattedPhone = formatPhone(contactData.phone);
        if (!formattedPhone) {
          results.errors.push(`Telefone inválido: ${contactData.phone}`);
          continue;
        }
        const { data: existing } = await executeWithRLS(req.user.id, (client) =>
          client
            .from('evolution_contacts')
            .select('id')
            .eq('client_id', req.user.id)
            .eq('phone', formattedPhone)
            .single()
        );
        if (existing) {
          results.skipped++;
          continue;
        }
        const newContactData = {
          id: uuidv4(),
          client_id: req.user.id,
          phone: formattedPhone,
          name: contactData.name || `Contato ${formattedPhone}`,
          source: 'import',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        const { error: createError } = await executeWithRLS(req.user.id, (client) =>
          client.from('evolution_contacts').insert([newContactData])
        );
        if (createError) {
          results.errors.push(`Erro ao criar ${formattedPhone}: ${createError.message}`);
        } else {
          results.created++;
        }
      } catch (err) {
        results.errors.push(`Erro ao processar contato: ${err.message}`);
      }
    }

    if (results.created > 0) {
      await executeWithRLS(req.user.id, (client) =>
        client.rpc('update_client_stats', { client_uuid: req.user.id })
      );
      await executeWithRLS(req.user.id, (client) =>
        client
          .from('evolution_activities')
          .insert([{
            id: uuidv4(),
            client_id: req.user.id,
            ...formatActivity('contacts_imported', `Importação concluída: ${results.created} contatos criados`, results)
          }])
      );
    }

    success(res, results, 'Importação concluída');
  })
);

module.exports = router;
