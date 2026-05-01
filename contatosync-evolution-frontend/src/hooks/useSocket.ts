'use client';

/**
 * useSocket — conexão Socket.IO para o ContatoSync
 *
 * Garante:
 * - Uma única conexão por montagem do componente
 * - Reconexão automática infinita
 * - Sem stale closure nos callbacks (via refs)
 * - Cleanup correto ao desmontar
 *
 * O servidor já entra o cliente na room correta via socketAuth middleware
 * (socket.join(`client_${client.id}`)), então não precisamos emitir "join" aqui.
 */

import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { getSocketUrl } from '@/lib/runtime-config';

interface UseSocketCallbacks {
  onNewMessage?: (data: any) => void;
  onConversationUpdated?: () => void;
}

interface UseSocketReturn {
  connected: boolean;
}

export function useSocket({ onNewMessage, onConversationUpdated }: UseSocketCallbacks): UseSocketReturn {
  const [connected, setConnected] = useState(false);

  // Refs para os callbacks — atualizados a cada render sem recriar o socket
  const onNewMessageRef = useRef(onNewMessage);
  const onConversationUpdatedRef = useRef(onConversationUpdated);
  onNewMessageRef.current = onNewMessage;
  onConversationUpdatedRef.current = onConversationUpdated;

  useEffect(() => {
    // Só roda no browser
    if (typeof window === 'undefined') return;

    console.log('[Socket] Hook iniciado');

    const token = localStorage.getItem('contatosync_token');
    if (!token) {
      console.warn('[Socket] Token ausente — conexão não iniciada');
      return;
    }

    const socket: Socket = io(getSocketUrl(), {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
    });

    // Expor globalmente para debug no console do browser
    (window as any).socket = socket;

    // ── LIFECYCLE ──────────────────────────────────────────────
    socket.on('connect', () => {
      console.log('[Socket] ✅ Conectado', socket.id);
      setConnected(true);
    });

    socket.on('disconnect', (reason) => {
      console.warn('[Socket] ❌ Desconectado | motivo:', reason);
      setConnected(false);
    });

    socket.on('connect_error', (err) => {
      console.log('[Socket] ❌ Erro conexão', err);
      setConnected(false);
    });

    // ── EVENTOS DE NEGÓCIO ────────────────────────────────────
    // Usa refs → callbacks sempre atuais, sem stale closure
    socket.on('new_message', (data: any) => {
      console.log('[Socket] 📨 new_message | conv:', data?.conversation_id, '| conteúdo:', (data?.content || '').slice(0, 40));
      onNewMessageRef.current?.(data);
    });

    socket.on('conversation_updated', (data: any) => {
      console.log('[Socket] 🔄 conversation_updated', data?.conversation_id || '');
      onConversationUpdatedRef.current?.();
    });

    socket.on('conversation_update', (data: any) => {
      console.log('[Socket] conversation_update', data?.conversation_id || '');
      onConversationUpdatedRef.current?.();
    });

    return () => {
      console.log('[Socket] Cleanup — desconectando');
      socket.disconnect();
    };
  }, []); // [] correto: socket criado uma vez, callbacks via refs

  return { connected };
}
