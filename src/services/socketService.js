/**
 * Serviço de WebSocket para comunicação em tempo real
 * Gerencia conexões, mensagens e eventos do sistema
 */

let io;

const getIO = () => io;

/**
 * Inicializar serviço WebSocket
 * @param {object} socketIO - Instância do Socket.IO
 */
const initializeSocket = (socketIO) => {
  io = socketIO;

  io.on('connection', (socket) => {
    console.log(`📡 Cliente conectado: ${socket.userEmail} (${socket.id})`);

    // Entrar em salas específicas
    socket.join(`client_${socket.userId}`);
    socket.join('all_clients');

    // Evento: Cliente solicita status de conexão
    socket.on('get_status', () => {
      socket.emit('status_update', {
        connected: true,
        userId: socket.userId,
        timestamp: new Date().toISOString()
      });
    });

    // Evento: Marcar mensagem como lida
    socket.on('mark_message_read', (data) => {
      const { messageId, conversationId } = data;

      // Emitir para outros dispositivos do mesmo cliente
      socket.to(`client_${socket.userId}`).emit('message_read', {
        messageId,
        conversationId,
        readBy: socket.userId,
        timestamp: new Date().toISOString()
      });
    });

    // Evento: Cliente está digitando
    socket.on('typing', (data) => {
      const { conversationId, isTyping } = data;

      socket.to(`client_${socket.userId}`).emit('typing_status', {
        conversationId,
        isTyping,
        userId: socket.userId,
        timestamp: new Date().toISOString()
      });
    });

    // Evento: Atualização de status de conversa
    socket.on('conversation_status', (data) => {
      const { conversationId, status } = data;

      io.to(`client_${socket.userId}`).emit('conversation_updated', {
        conversationId,
        status,
        updatedBy: socket.userId,
        timestamp: new Date().toISOString()
      });
    });

    // Evento: Ping para manter conexão ativa
    socket.on('ping', () => {
      socket.emit('pong', {
        timestamp: new Date().toISOString()
      });
    });

    // Desconexão
    socket.on('disconnect', (reason) => {
      console.log(`📴 Cliente desconectado: ${socket.userEmail} - Motivo: ${reason}`);
    });

    // Erro
    socket.on('error', (error) => {
      console.error(`❌ Erro WebSocket para ${socket.userEmail}:`, error);
    });
  });

  return io;
};

const emitNewMessage = (clientId, message) => {
  if (!io) return;
  io.to(`client_${clientId}`).emit('new_message', {
    ...message,
    timestamp: new Date().toISOString()
  });
};

const emitConversationUpdate = (clientId, conversation) => {
  if (!io) return;
  io.to(`client_${clientId}`).emit('conversation_updated', {
    ...conversation,
    timestamp: new Date().toISOString()
  });
};

const emitNewContact = (clientId, contact) => {
  if (!io) return;
  io.to(`client_${clientId}`).emit('new_contact', {
    ...contact,
    timestamp: new Date().toISOString()
  });
};

const emitActivity = (clientId, activity) => {
  if (!io) return;
  io.to(`client_${clientId}`).emit('new_activity', {
    ...activity,
    timestamp: new Date().toISOString()
  });
};

const emitAIResponse = (clientId, aiResponse) => {
  if (!io) return;
  io.to(`client_${clientId}`).emit('ai_response', {
    ...aiResponse,
    timestamp: new Date().toISOString()
  });
};

const emitError = (clientId, error, details = {}) => {
  if (!io) return;
  io.to(`client_${clientId}`).emit('error', {
    error,
    details,
    timestamp: new Date().toISOString()
  });
};

const emitConfigUpdate = (clientId, config) => {
  if (!io) return;
  io.to(`client_${clientId}`).emit('config_updated', {
    config,
    timestamp: new Date().toISOString()
  });
};

const emitWhatsAppStatus = (clientId, status) => {
  if (!io) return;
  io.to(`client_${clientId}`).emit('whatsapp_status', {
    ...status,
    timestamp: new Date().toISOString()
  });
};

const emitQRCode = (clientId, qrCode) => {
  if (!io) return;
  io.to(`client_${clientId}`).emit('whatsapp_qr', {
    qrCode,
    timestamp: new Date().toISOString()
  });
};

const broadcast = (event, data) => {
  if (!io) return;
  io.to('all_clients').emit(event, {
    ...data,
    timestamp: new Date().toISOString()
  });
};

const getStats = () => {
  if (!io) return { connected: 0, rooms: [] };
  const sockets = io.sockets.sockets;
  const connected = sockets.size;
  return {
    connected,
    rooms: Array.from(io.sockets.adapter.rooms.keys()).filter(room => room.startsWith('client_')),
    timestamp: new Date().toISOString()
  };
};

module.exports = {
  initializeSocket,
  getIO,
  emitNewMessage,
  emitConversationUpdate,
  emitNewContact,
  emitActivity,
  emitAIResponse,
  emitError,
  emitConfigUpdate,
  emitWhatsAppStatus,
  emitQRCode,
  broadcast,
  getStats
};
