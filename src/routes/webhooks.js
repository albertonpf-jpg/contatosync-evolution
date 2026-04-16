const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { executeWithRLS } = require('../config/supabase');
const { success, error, asyncHandler } = require('../utils/response');
const { formatActivity } = require('../utils/helpers');

const router = express.Router();

/**
 * POST /api/webhooks/evolution
 * Webhook para receber eventos da Evolution API
 */
router.post('/evolution',
  asyncHandler(async (req, res) => {
    const { event, instance, data } = req.body;

    console.log('📞 Webhook Evolution recebido:', {
      event,
      instance: instance?.instanceName,
      timestamp: new Date().toISOString()
    });

    try {
      switch (event) {
        case 'qrcode.updated':
          await handleQRCodeUpdate(instance, data);
          break;

        case 'connection.update':
          await handleConnectionUpdate(instance, data);
          break;

        case 'messages.upsert':
          await handleNewMessage(instance, data);
          break;

        case 'send.message':
          await handleMessageSent(instance, data);
          break;

        default:
          console.log('Evento não tratado:', event);
      }

      success(res, null, 'Webhook processado com sucesso');
    } catch (error) {
      console.error('Erro ao processar webhook:', error);
      return error(res, 'Erro interno no webhook', 500);
    }
  })
);

/**
 * Processar atualização de QR Code
 */
async function handleQRCodeUpdate(instance, data) {
  const sessionName = instance?.instanceName;
  if (!sessionName) return;

  console.log('🔄 QR Code atualizado para:', sessionName);

  // Buscar sessão no banco (sem RLS pois não temos user_id no webhook)
  const { data: session } = await require('../config/supabase').supabaseAdmin
    .from('evolution_sessions')
    .select('*')
    .eq('session_name', sessionName)
    .single();

  if (session) {
    // Atualizar QR code no banco
    await require('../config/supabase').supabaseAdmin
      .from('evolution_sessions')
      .update({
        qr_code: data?.qrcode || data?.code,
        status: 'qr_pending',
        updated_at: new Date().toISOString()
      })
      .eq('id', session.id);

    // Log da atividade
    await require('../config/supabase').supabaseAdmin
      .from('evolution_activities')
      .insert([{
        id: uuidv4(),
        client_id: session.client_id,
        ...formatActivity('whatsapp_qr_updated', `QR Code atualizado: ${sessionName}`)
      }]);
  }
}

/**
 * Processar mudança de status da conexão
 */
async function handleConnectionUpdate(instance, data) {
  const sessionName = instance?.instanceName;
  if (!sessionName) return;

  const connectionState = data?.state || data?.connection;
  console.log('🔗 Conexão atualizada:', sessionName, '->', connectionState);

  // Buscar sessão no banco
  const { data: session } = await require('../config/supabase').supabaseAdmin
    .from('evolution_sessions')
    .select('*')
    .eq('session_name', sessionName)
    .single();

  if (session) {
    let newStatus = 'disconnected';
    let deviceInfo = null;

    // Mapear estados da Evolution API para nosso sistema
    switch (connectionState) {
      case 'open':
        newStatus = 'connected';
        break;
      case 'close':
        newStatus = 'disconnected';
        break;
      case 'connecting':
        newStatus = 'qr_pending';
        break;
    }

    // Extrair informações do dispositivo se conectado
    if (connectionState === 'open' && data?.instance) {
      deviceInfo = {
        profilePicture: data.instance.profilePictureUrl,
        profileName: data.instance.profileName,
        phone: data.instance.wuid?.split('@')[0]
      };
    }

    // Atualizar status no banco
    await require('../config/supabase').supabaseAdmin
      .from('evolution_sessions')
      .update({
        status: newStatus,
        whatsapp_phone: deviceInfo?.phone,
        device_info: deviceInfo,
        last_seen: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', session.id);

    // Log da atividade
    const activityDescription = `Status WhatsApp: ${sessionName} -> ${newStatus}`;
    await require('../config/supabase').supabaseAdmin
      .from('evolution_activities')
      .insert([{
        id: uuidv4(),
        client_id: session.client_id,
        ...formatActivity('whatsapp_status_changed', activityDescription, {
          session_name: sessionName,
          old_status: session.status,
          new_status: newStatus,
          device_info: deviceInfo
        })
      }]);
  }
}

/**
 * Processar nova mensagem recebida
 */
async function handleNewMessage(instance, data) {
  const sessionName = instance?.instanceName;
  if (!sessionName || !data?.messages) return;

  console.log('💬 Nova mensagem recebida:', sessionName, data.messages.length, 'mensagem(s)');

  // Buscar sessão no banco
  const { data: session } = await require('../config/supabase').supabaseAdmin
    .from('evolution_sessions')
    .select('*')
    .eq('session_name', sessionName)
    .single();

  if (!session) return;

  // Processar cada mensagem
  for (const message of data.messages) {
    try {
      await processIncomingMessage(session, message);
    } catch (error) {
      console.error('Erro ao processar mensagem:', error);
    }
  }
}

/**
 * Processar mensagem individual
 */
async function processIncomingMessage(session, message) {
  const phone = message.key?.remoteJid?.replace('@s.whatsapp.net', '');
  const messageContent = message.message?.conversation ||
                        message.message?.extendedTextMessage?.text ||
                        message.message?.imageMessage?.caption ||
                        '[Mídia]';

  if (!phone || message.key.fromMe) return; // Ignorar mensagens próprias

  console.log('📩 Processando mensagem de:', phone, '|', messageContent.substring(0, 50));

  // Buscar ou criar contato
  let contact;
  const { data: existingContact } = await require('../config/supabase').supabaseAdmin
    .from('evolution_contacts')
    .select('*')
    .eq('client_id', session.client_id)
    .eq('phone', phone)
    .single();

  if (existingContact) {
    contact = existingContact;
  } else {
    // Criar novo contato automaticamente
    const { data: newContact } = await require('../config/supabase').supabaseAdmin
      .from('evolution_contacts')
      .insert([{
        id: uuidv4(),
        client_id: session.client_id,
        phone: phone,
        name: message.pushName || `Contato ${phone}`,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select('*')
      .single();

    contact = newContact;
  }

  // Buscar ou criar conversa
  let conversation;
  const { data: existingConv } = await require('../config/supabase').supabaseAdmin
    .from('evolution_conversations')
    .select('*')
    .eq('client_id', session.client_id)
    .eq('contact_id', contact.id)
    .single();

  if (existingConv) {
    conversation = existingConv;
  } else {
    const { data: newConv } = await require('../config/supabase').supabaseAdmin
      .from('evolution_conversations')
      .insert([{
        id: uuidv4(),
        client_id: session.client_id,
        contact_id: contact.id,
        status: 'active',
        last_message_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select('*')
      .single();

    conversation = newConv;
  }

  // Salvar mensagem
  await require('../config/supabase').supabaseAdmin
    .from('evolution_messages')
    .insert([{
      id: uuidv4(),
      conversation_id: conversation.id,
      client_id: session.client_id,
      contact_id: contact.id,
      content: messageContent,
      message_type: getMessageType(message),
      direction: 'in',
      status: 'received',
      whatsapp_message_id: message.key.id,
      created_at: new Date().toISOString()
    }]);

  // Atualizar conversa com última mensagem
  await require('../config/supabase').supabaseAdmin
    .from('evolution_conversations')
    .update({
      last_message_at: new Date().toISOString(),
      unread_count: require('../config/supabase').supabaseAdmin.sql`unread_count + 1`,
      updated_at: new Date().toISOString()
    })
    .eq('id', conversation.id);

  console.log('✅ Mensagem salva:', contact.name, '|', messageContent.substring(0, 30));
}

/**
 * Determinar tipo da mensagem
 */
function getMessageType(message) {
  if (message.message?.imageMessage) return 'image';
  if (message.message?.audioMessage) return 'audio';
  if (message.message?.videoMessage) return 'video';
  if (message.message?.documentMessage) return 'document';
  return 'text';
}

/**
 * Processar confirmação de mensagem enviada
 */
async function handleMessageSent(instance, data) {
  const sessionName = instance?.instanceName;
  console.log('📤 Mensagem enviada confirmada:', sessionName);

  // Aqui podemos atualizar status da mensagem no banco
  // data geralmente contém o ID da mensagem e status de entrega
}

module.exports = router;