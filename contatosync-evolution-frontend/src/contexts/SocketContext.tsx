'use client';

/**
 * SocketContext — conexão Socket.IO global
 *
 * Vive acima de todas as páginas. Conecta assim que o token aparece em
 * localStorage (independente de qual página está aberta ou se ProtectedRoute
 * já renderizou). Reconecta automaticamente. Limpa ao logout.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from 'react';
import { io, Socket } from 'socket.io-client';

const SOCKET_URL = 'https://web-production-50297.up.railway.app';
const TOKEN_KEY  = 'contatosync_token';

// ── Tipos ────────────────────────────────────────────────────────
type Listener = (data?: any) => void;

interface SocketContextValue {
  connected: boolean;
  on:  (event: string, fn: Listener) => void;
  off: (event: string, fn: Listener) => void;
}

// ── Context ──────────────────────────────────────────────────────
const SocketContext = createContext<SocketContextValue>({
  connected: false,
  on:  () => {},
  off: () => {},
});

export const useSocketContext = () => useContext(SocketContext);

// ── Provider ─────────────────────────────────────────────────────
export function SocketProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const socketRef  = useRef<Socket | null>(null);
  const listeners  = useRef<Map<string, Set<Listener>>>(new Map());

  // Registrar listeners externos sem recriar o socket
  const on = useCallback((event: string, fn: Listener) => {
    if (!listeners.current.has(event)) listeners.current.set(event, new Set());
    listeners.current.get(event)!.add(fn);
  }, []);

  const off = useCallback((event: string, fn: Listener) => {
    listeners.current.get(event)?.delete(fn);
  }, []);

  useEffect(() => {
    console.log('[Socket] SocketProvider montado');

    function connect() {
      const token = localStorage.getItem(TOKEN_KEY);

      if (!token) {
        console.warn('[Socket] Sem token — aguardando login');
        return;
      }

      if (socketRef.current?.connected) {
        console.log('[Socket] Já conectado, reutilizando');
        return;
      }

      // Desconectar socket anterior se existir
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }

      console.log('[Socket] Criando conexão → token:', token.slice(0, 12) + '...');

      const socket = io(SOCKET_URL, {
        auth: { token },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000,
      });

      // Expor no window para debug no console do browser
      (window as any).socket = socket;

      socketRef.current = socket;

      socket.on('connect', () => {
        console.log('[Socket] ✅ Conectado | id:', socket.id);
        setConnected(true);
      });

      socket.on('disconnect', (reason) => {
        console.warn('[Socket] ❌ Desconectado | motivo:', reason);
        setConnected(false);
      });

      socket.on('connect_error', (err) => {
        console.error('[Socket] ❌ Erro conexão:', err.message);
        setConnected(false);
      });

      // Redirecionar todos os eventos para os listeners registrados
      ['new_message', 'conversation_updated', 'conversation_update', 'new_contact', 'whatsapp_status', 'typing_status'].forEach(ev => {
        socket.on(ev, (data: any) => {
          console.log('[Socket] evento:', ev, data?.conversation_id || '');
          listeners.current.get(ev)?.forEach(fn => fn(data));
        });
      });
    }

    // Conectar imediatamente se já há token
    connect();

    // Reconectar quando o token mudar no localStorage (login/logout em outra aba)
    const handleStorage = (e: StorageEvent) => {
      if (e.key === TOKEN_KEY) {
        if (e.newValue) {
          console.log('[Socket] Token detectado via storage event — reconectando');
          connect();
        } else {
          console.log('[Socket] Token removido — desconectando');
          socketRef.current?.disconnect();
          socketRef.current = null;
          setConnected(false);
        }
      }
    };
    window.addEventListener('storage', handleStorage);

    // Polling para detectar token em abas que não disparam storage event
    const tokenPoller = setInterval(() => {
      const token = localStorage.getItem(TOKEN_KEY);
      if (token && !socketRef.current?.connected) {
        console.log('[Socket] Token detectado no poller — conectando');
        connect();
      }
    }, 2000);

    return () => {
      clearInterval(tokenPoller);
      window.removeEventListener('storage', handleStorage);
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, []);

  return (
    <SocketContext.Provider value={{ connected, on, off }}>
      {children}
    </SocketContext.Provider>
  );
}
