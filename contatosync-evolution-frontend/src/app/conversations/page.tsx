'use client';

import { useState, useEffect, useRef } from 'react';
import { MessageSquare, Search, Send, ArrowLeft, RefreshCw, Check, CheckCheck } from 'lucide-react';
import { io, Socket } from 'socket.io-client';
import DashboardLayout from '@/components/DashboardLayout';
import { apiService } from '@/lib/api';


interface Contact {
  name: string;
  phone: string;
}

interface Conversation {
  id: string;
  client_id: string;
  contact_id: string;
  contact_name?: string;
  phone?: string;
  status: string;
  last_message_at: string;
  unread_count: number;
  created_at: string;
  updated_at: string;
  evolution_contacts?: Contact;
}

interface Message {
  id: string;
  conversation_id: string;
  content: string;
  message_type: string;
  direction: 'in' | 'out';
  status: string;
  is_from_ai: boolean;
  created_at: string;
  sent_at?: string;
}

export default function ConversationsPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [socketOk, setSocketOk] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevMsgCount = useRef(0);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => { loadConversations(); }, []);

  // Scroll apenas quando chegar mensagem nova
  useEffect(() => {
    if (messages.length > prevMsgCount.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevMsgCount.current = messages.length;
  }, [messages]);

  // Ref para conversa atual (evita stale closure)
  const currentConvRef = useRef<string | null>(null);
  useEffect(() => {
    currentConvRef.current = selectedConversation?.id ?? null;
  }, [selectedConversation?.id]);

  // ============================================================
  // SOCKET.IO — TEMPO REAL
  // ============================================================
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('contatosync_token') : null;
    if (!token) return;

    const socketUrl = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
      ? 'https://web-production-50297.up.railway.app'
      : 'http://localhost:3003';

    const socket = io(socketUrl, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socketRef.current = socket;

    // ---- Nova mensagem recebida via socket ----
    socket.on('new_message', (data: any) => {
      console.log('[Socket] new_message recebida:', data);

      // 1) Atualizar lista de conversas (mover a conversa pro topo, incrementar unread)
      setConversations(prev => {
        const convId = data.conversation_id;
        const existingIdx = prev.findIndex(c => c.id === convId);

        if (existingIdx >= 0) {
          // Conversa existente — atualizar e mover pro topo
          const updated = [...prev];
          const conv = { ...updated[existingIdx] };
          conv.last_message_at = data.timestamp || new Date().toISOString();

          // Atualizar nome e telefone se vieram no socket
          if (data.contact_name) conv.contact_name = data.contact_name;
          if (data.phone) conv.phone = data.phone;

          // Incrementar unread apenas se NAO e a conversa aberta
          if (currentConvRef.current !== convId) {
            conv.unread_count = (conv.unread_count || 0) + 1;
          }

          updated.splice(existingIdx, 1);
          updated.unshift(conv);
          return updated;
        } else {
          // Conversa nova — buscar do servidor
          loadConversations();
          return prev;
        }
      });

      // 2) Se a conversa aberta e a mesma, adicionar a mensagem na lista
      if (currentConvRef.current === data.conversation_id && data.direction === 'in') {
        const newMsg: Message = {
          id: data.id || ('socket_' + Date.now()),
          conversation_id: data.conversation_id,
          content: data.content || '',
          message_type: data.message_type || 'text',
          direction: 'in',
          status: 'received',
          is_from_ai: false,
          created_at: data.timestamp || new Date().toISOString(),
          sent_at: data.timestamp || new Date().toISOString(),
        };

        setMessages(prev => {
          // Evitar duplicatas
          const isDuplicate = prev.some(m =>
            (m.id === newMsg.id) ||
            (m.content === newMsg.content && m.direction === 'in' &&
              Math.abs(new Date(m.sent_at || m.created_at).getTime() - new Date(newMsg.sent_at || newMsg.created_at).getTime()) < 3000)
          );
          if (isDuplicate) return prev;
          return [...prev, newMsg];
        });
      }
    });

    // ---- Conversa atualizada ----
    socket.on('conversation_updated', () => {
      loadConversations();
    });

    socket.on('connect', () => {
      console.log('[Socket] Conectado!');
      setSocketOk(true);
    });

    socket.on('disconnect', (reason) => {
      console.warn('[Socket] Desconectado:', reason);
      setSocketOk(false);
    });

    socket.on('connect_error', (err) => {
      console.warn('[Socket] Erro conexao:', err.message);
      setSocketOk(false);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  // ============================================================
  // POLLING como fallback (intervalo maior se socket conectado)
  // ============================================================
  useEffect(() => {
    const interval = setInterval(() => {
      loadConversations();
      if (currentConvRef.current) {
        loadMessagesForConversation(currentConvRef.current);
      }
    }, socketOk ? 10000 : 3000);

    return () => clearInterval(interval);
  }, [socketOk]);


  const loadConversations = async () => {
    try {
      setError(null);
      const response = await apiService.getConversations(1, 50);
      let list: Conversation[] = [];
      if (response?.items && Array.isArray(response.items)) list = response.items;
      else if (Array.isArray(response)) list = response;
      else if (response?.data && Array.isArray(response.data)) list = response.data;
      setConversations(list);
    } catch (err: any) {
      if (conversations.length === 0) setError(err.message || 'Erro ao carregar conversas');
    } finally {
      setLoading(false);
    }
  };

  const loadMessagesForConversation = async (conversationId: string) => {
    try {
      const response = await apiService.getMessages(conversationId);
      let msgs: Message[] = [];
      if (response?.messages && Array.isArray(response.messages)) msgs = response.messages;
      else if (response?.items && Array.isArray(response.items)) msgs = response.items;
      else if (Array.isArray(response)) msgs = response;
      setMessages(msgs);
    } catch (err: any) {
      console.error('Erro carregando mensagens:', err?.message);
    }
  };

  const openConversation = async (conv: Conversation) => {
    setSelectedConversation(conv);
    setLoadingMessages(true);

    // Zerar unread localmente
    setConversations(prev => prev.map(c =>
      c.id === conv.id ? { ...c, unread_count: 0 } : c
    ));

    try {
      const response = await apiService.getMessages(conv.id);
      let msgs: Message[] = [];
      if (response?.messages && Array.isArray(response.messages)) msgs = response.messages;
      else if (response?.items && Array.isArray(response.items)) msgs = response.items;
      else if (Array.isArray(response)) msgs = response;
      setMessages(msgs);
    } catch { setMessages([]); }
    finally { setLoadingMessages(false); }
  };

  const handleSend = async () => {
    if (!newMessage.trim() || !selectedConversation || sending) return;
    setSending(true);
    try {
      await apiService.sendMessage({
        conversation_id: selectedConversation.id,
        content: newMessage.trim(),
        message_type: 'text'
      });
      setNewMessage('');
      setTimeout(() => {
        if (currentConvRef.current) {
          loadMessagesForConversation(currentConvRef.current);
        }
        loadConversations();
      }, 800);
    } catch (err: any) {
      console.error('Erro ao enviar mensagem:', err);
      alert('Erro ao enviar mensagem. Verifique se o WhatsApp esta conectado.');
    } finally {
      setSending(false);
    }
  };

  // ============================================================
  // FUNCOES DE EXIBICAO
  // ============================================================

  const getName = (c: Conversation) => c.contact_name || c.evolution_contacts?.name || c.phone || 'Sem nome';

  const getPhone = (c: Conversation) => {
    // Prioridade: evolution_contacts.phone > conversation.phone
    const contactPhone = c.evolution_contacts?.phone || '';
    const convPhone = c.phone || '';

    // Escolher o telefone real (nao LID)
    const candidates = [contactPhone, convPhone].filter(Boolean);

    for (const p of candidates) {
      const digits = p.replace(/\D/g, '');
      // Telefone real brasileiro: 10-13 digitos (ex: 5511999999999)
      if (digits.length >= 10 && digits.length <= 13 && !p.includes('@')) {
        return formatPhoneNumber(digits);
      }
    }

    // Se nenhum telefone real encontrado, nao mostrar codigo LID
    return '';
  };

  const formatPhoneNumber = (digits: string): string => {
    if (digits.startsWith('55') && digits.length >= 12) {
      const ddd = digits.substring(2, 4);
      const rest = digits.substring(4);
      if (rest.length === 9) {
        return `+55 (${ddd}) ${rest.substring(0, 5)}-${rest.substring(5)}`;
      } else if (rest.length === 8) {
        return `+55 (${ddd}) ${rest.substring(0, 4)}-${rest.substring(4)}`;
      }
      return `+55 (${ddd}) ${rest}`;
    }
    return `+${digits}`;
  };

  const getInitials = (n: string) => n.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();

  const formatTime = (d: string) => {
    if (!d) return '';
    const date = new Date(d);
    const diff = Math.floor((Date.now() - date.getTime()) / 86400000);
    if (diff === 0) return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (diff === 1) return 'Ontem';
    if (diff < 7) return date.toLocaleDateString('pt-BR', { weekday: 'short' });
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  };

  const filtered = conversations.filter(c => {
    if (!searchTerm) return true;
    const s = searchTerm.toLowerCase();
    return getName(c).toLowerCase().includes(s) || getPhone(c).toLowerCase().includes(s);
  });

  if (error && conversations.length === 0) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-full p-6">
          <div className="bg-red-50 border border-red-200 rounded-lg p-6 max-w-md w-full text-center">
            <MessageSquare className="h-12 w-12 text-red-400 mx-auto mb-3" />
            <h2 className="text-red-800 font-semibold text-lg mb-2">Erro ao carregar</h2>
            <p className="text-red-600 text-sm mb-4">{error}</p>
            <button onClick={loadConversations} className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm">Tentar novamente</button>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="flex h-[calc(100vh-64px)] bg-gray-100">
        {/* Lista */}
        <div className={`${selectedConversation ? 'hidden md:flex' : 'flex'} flex-col w-full md:w-96 bg-white border-r border-gray-200`}>
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
            <div className="flex items-center justify-between mb-3">
               <div className="flex items-center gap-2">
                 <h1 className="text-lg font-bold text-gray-900">Conversas</h1>
                 <span className={`text-xs px-1.5 py-0.5 rounded-full flex items-center gap-1 ${socketOk ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}`}>
                   <span className={`w-1.5 h-1.5 rounded-full ${socketOk ? "bg-green-500 animate-pulse" : "bg-yellow-500"}`}></span>
                   {socketOk ? "Live" : "Polling"}
                 </span>
               </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 bg-gray-200 px-2 py-1 rounded-full">{filtered.length}</span>
                <button onClick={loadConversations} className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded-full">
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input type="text" placeholder="Buscar conversa..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-4 py-2 bg-white border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading && conversations.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mb-3"></div>
                <p className="text-gray-500 text-sm">Carregando conversas...</p>
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 px-6">
                <MessageSquare className="h-12 w-12 text-gray-300 mb-3" />
                <p className="text-gray-500 text-sm text-center">{searchTerm ? 'Nenhuma conversa encontrada' : 'Nenhuma conversa ainda'}</p>
                <p className="text-gray-400 text-xs text-center mt-1">{searchTerm ? 'Tente outro termo' : 'Conversas aparecem quando receber mensagens no WhatsApp'}</p>
              </div>
            ) : (
              filtered.map((conv) => (
                <button key={conv.id} onClick={() => openConversation(conv)}
                  className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 border-b border-gray-100 text-left ${selectedConversation?.id === conv.id ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''}`}>
                  <div className="flex-shrink-0 w-12 h-12 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white font-semibold text-sm">
                    {getInitials(getName(conv))}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-gray-900 text-sm truncate">{getName(conv)}</span>
                      <span className="text-xs text-gray-400 ml-2">{formatTime(conv.last_message_at)}</span>
                    </div>
                    <div className="flex items-center justify-between mt-0.5">
                      <span className="text-xs text-gray-500 truncate">{getPhone(conv) || 'WhatsApp'}</span>
                      {conv.unread_count > 0 && (
                        <span className="ml-2 bg-green-500 text-white text-xs font-bold rounded-full h-5 min-w-[20px] flex items-center justify-center px-1.5">{conv.unread_count}</span>
                      )}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Chat */}
        <div className={`${selectedConversation ? 'flex' : 'hidden md:flex'} flex-col flex-1 bg-gray-50`}>
          {selectedConversation ? (
            <>
              <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 shadow-sm">
                <button onClick={() => setSelectedConversation(null)} className="md:hidden p-1 text-gray-500 hover:text-gray-700">
                  <ArrowLeft className="h-5 w-5" />
                </button>
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white font-semibold text-sm">
                  {getInitials(getName(selectedConversation))}
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="font-semibold text-gray-900 text-sm truncate">{getName(selectedConversation)}</h2>
                  <p className="text-xs text-gray-500 truncate">{getPhone(selectedConversation) || 'WhatsApp'}</p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${selectedConversation.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                  {selectedConversation.status === 'active' ? 'Ativa' : selectedConversation.status}
                </span>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-4">
                {loadingMessages ? (
                  <div className="flex items-center justify-center h-full"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div></div>
                ) : messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full">
                    <MessageSquare className="h-16 w-16 text-gray-300 mb-3" />
                    <p className="text-gray-400 text-sm">Nenhuma mensagem ainda</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {messages.map((msg) => (
                      <div key={msg.id} className={`flex ${msg.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[75%] rounded-lg px-3 py-2 shadow-sm ${msg.direction === 'out' ? 'bg-green-100 rounded-br-none' : 'bg-white rounded-bl-none'}`}>
                          {msg.is_from_ai && <span className="text-xs text-purple-600 font-medium block mb-1">🤖 IA</span>}
                          <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                          <div className="flex items-center justify-end gap-1 mt-1">
                            <span className="text-[10px] text-gray-400">{formatTime(msg.sent_at || msg.created_at)}</span>
                            {msg.direction === 'out' && (msg.status === 'read' ? <CheckCheck className="h-3 w-3 text-blue-500" /> : <Check className="h-3 w-3 text-gray-400" />)}
                          </div>
                        </div>
                      </div>
                    ))}
                    <div ref={messagesEndRef} />
                  </div>
                )}
              </div>

              <div className="px-4 py-3 bg-white border-t border-gray-200">
                <div className="flex items-end gap-2">
                  <textarea value={newMessage} onChange={(e) => setNewMessage(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                    placeholder="Digite uma mensagem..." rows={1}
                    className="flex-1 resize-none px-4 py-2.5 bg-gray-100 border border-gray-200 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 max-h-32"
                    style={{ minHeight: '42px' }} />
                  <button onClick={handleSend} disabled={!newMessage.trim() || sending}
                    className="flex-shrink-0 p-2.5 bg-blue-600 text-white rounded-full hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                    <Send className="h-5 w-5" />
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-full">
              <div className="bg-white rounded-2xl p-8 shadow-sm text-center max-w-sm">
                <div className="w-20 h-20 rounded-full bg-blue-100 flex items-center justify-center mx-auto mb-4">
                  <MessageSquare className="h-10 w-10 text-blue-500" />
                </div>
                <h2 className="text-xl font-bold text-gray-900 mb-2">ContatoSync Evolution</h2>
                <p className="text-gray-500 text-sm">Selecione uma conversa para visualizar mensagens</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
