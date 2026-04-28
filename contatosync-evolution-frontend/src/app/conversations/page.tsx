'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, CheckCheck, MessageSquare, Search, Send } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { useSocketContext } from '@/contexts/SocketContext';
import { getApiUrl } from '@/lib/runtime-config';

const API = getApiUrl();

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

interface SocketConversationPayload {
  id?: string;
  conversation_id?: string;
  contact_id?: string;
  contact_name?: string;
  phone?: string;
  unread_count?: number;
  status?: string;
  last_message_at?: string;
  updated_at?: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Erro desconhecido';
}

async function apiFetch(path: string, token: string) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${API}${path}${sep}_t=${Date.now()}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const json = await res.json();
  return json?.data;
}

function parseBRPhone(raw: string): string {
  if (!raw) return '';

  const digits = raw.split('@')[0].replace(/\D/g, '');
  if (!digits.startsWith('55') || (digits.length !== 12 && digits.length !== 13)) {
    return '';
  }

  const ddd = parseInt(digits.substring(2, 4), 10);
  if (ddd < 11 || ddd > 99) {
    return '';
  }

  const local = digits.substring(4);
  if (local.length === 9 && local.startsWith('9')) {
    return `+55 (${ddd}) ${local.slice(0, 5)}-${local.slice(5)}`;
  }

  if (local.length === 8 && /^[2-5]/.test(local)) {
    return `+55 (${ddd}) ${local.slice(0, 4)}-${local.slice(4)}`;
  }

  return '';
}

function isRealPhone(raw?: string): boolean {
  const digits = (raw || '').split('@')[0].replace(/\D/g, '');
  return digits.startsWith('55') && digits.length >= 12 && digits.length <= 13;
}

function normalizePhone(raw?: string): string {
  const base = (raw || '').split('@')[0];
  const digits = base.replace(/\D/g, '');
  if (!digits) return base;
  return `+${digits}`;
}

export default function ConversationsPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevMsgCount = useRef(0);
  const currentConvId = useRef<string | null>(null);

  useEffect(() => {
    currentConvId.current = selectedConv?.id ?? null;
  }, [selectedConv?.id]);

  useEffect(() => {
    if (messages.length > prevMsgCount.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }

    prevMsgCount.current = messages.length;
  }, [messages]);

  const getToken = useCallback((): string => {
    return (typeof window !== 'undefined' ? localStorage.getItem('contatosync_token') : '') ?? '';
  }, []);

  const fetchConvs = useCallback(async () => {
    const token = getToken();
    if (!token) return;

    try {
      const data = await apiFetch('/conversations?page=1&limit=50&status=active', token);
      setConversations(data?.items ?? []);
    } catch (error: unknown) {
      console.error('[fetchConvs]', getErrorMessage(error));
    } finally {
      setLoadingConvs(false);
    }
  }, [getToken]);

  const fetchMsgs = useCallback(async (id: string) => {
    const token = getToken();
    if (!token || !id) return;

    try {
      const data = await apiFetch(`/messages/conversation/${id}?page=1&limit=100`, token);
      setMessages(data?.items ?? []);
    } catch (error: unknown) {
      console.error('[fetchMsgs]', getErrorMessage(error));
    }
  }, [getToken]);

  const { connected: socketOk, on, off } = useSocketContext();

  function upsertConversationFromSocket(payload?: SocketConversationPayload) {
    const conversationId = payload?.conversation_id || payload?.id;
    if (!conversationId) return;

    setConversations(prev => {
      const existing = prev.find(conv => conv.id === conversationId);

      if (!existing) {
        // Conversa nova vinda via socket — adicionar no topo
        const newConv: Conversation = {
          id: conversationId,
          client_id: '',
          contact_id: payload?.contact_id || '',
          contact_name: payload?.contact_name || 'Sem nome',
          phone: normalizePhone(payload?.phone),
          status: payload?.status || 'active',
          last_message_at: payload?.last_message_at || new Date().toISOString(),
          unread_count: payload?.unread_count ?? 1,
          created_at: payload?.last_message_at || new Date().toISOString(),
          updated_at: payload?.updated_at || new Date().toISOString(),
          evolution_contacts: payload?.contact_name
            ? { name: payload.contact_name, phone: normalizePhone(payload?.phone) }
            : undefined,
        };
        return [newConv, ...prev];
      }

      const nextPhone = isRealPhone(payload?.phone)
        ? normalizePhone(payload.phone)
        : (isRealPhone(existing.phone) ? normalizePhone(existing.phone) : normalizePhone(payload?.phone || existing.phone));

      const updatedConversation: Conversation = {
        ...existing,
        contact_id: payload?.contact_id || existing.contact_id,
        contact_name: payload?.contact_name || existing.contact_name,
        phone: nextPhone,
        unread_count: payload?.unread_count ?? existing.unread_count,
        status: payload?.status || existing.status,
        last_message_at: payload?.last_message_at || existing.last_message_at,
        updated_at: payload?.updated_at || existing.updated_at,
        evolution_contacts: payload?.contact_name
          ? { name: payload.contact_name, phone: nextPhone || '' }
          : existing.evolution_contacts,
      };

      setSelectedConv(prevSelected => (
        prevSelected?.id === conversationId ? updatedConversation : prevSelected
      ));

      return [
        updatedConversation,
        ...prev.filter(conv => conv.id !== conversationId),
      ];
    });
  }

  useEffect(() => {
    const handleNewMessage = (payload?: Message & SocketConversationPayload & { conversation?: Conversation }) => {
      if (!payload) return;

      // Conversa completa veio no payload — usar diretamente
      const fullConv = payload.conversation;

      upsertConversationFromSocket({
        conversation_id: payload.conversation_id,
        contact_id: payload.contact_id,
        contact_name: payload.contact_name || fullConv?.contact_name,
        phone: payload.phone || fullConv?.phone,
        unread_count: currentConvId.current === payload.conversation_id ? 0 : (fullConv?.unread_count ?? undefined),
        status: fullConv?.status,
        last_message_at: payload.sent_at || payload.created_at,
        updated_at: payload.created_at,
      });

      if (payload.conversation_id === currentConvId.current) {
        setMessages(prev => {
          if (prev.some(message => message.id === payload.id)) {
            return prev;
          }
          return [
            ...prev,
            {
              id: payload.id,
              conversation_id: payload.conversation_id,
              content: payload.content,
              message_type: payload.message_type || 'text',
              direction: payload.direction,
              status: payload.status || 'received',
              is_from_ai: !!payload.is_from_ai,
              created_at: payload.created_at,
              sent_at: payload.sent_at,
            },
          ];
        });
      }
    };

    const handleConvUpdated = (payload?: SocketConversationPayload) => {
      upsertConversationFromSocket(payload);
    };

    on('new_message', handleNewMessage);
    on('conversation_updated', handleConvUpdated);

    return () => {
      off('new_message', handleNewMessage);
      off('conversation_updated', handleConvUpdated);
    };
  }, [off, on, selectedConv?.id]);

  // Atualização automática da inbox/mensagens (com cadência diferente conforme socket).
  useEffect(() => {
    const runRefresh = () => {
      void fetchConvs();
      if (currentConvId.current) {
        void fetchMsgs(currentConvId.current);
      }
    };

    const firstRunId = window.setTimeout(runRefresh, 0);
    const intervalId = setInterval(() => {
      runRefresh();
    }, socketOk ? 10000 : 5000);

    return () => {
      clearTimeout(firstRunId);
      clearInterval(intervalId);
    };
  }, [fetchConvs, fetchMsgs, socketOk]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void fetchConvs();
        if (currentConvId.current) {
          void fetchMsgs(currentConvId.current);
        }
      }
    };

    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchConvs, fetchMsgs]);

  const openConv = async (conv: Conversation) => {
    const normalizedConv = { ...conv, unread_count: 0 };
    setSelectedConv(normalizedConv);
    setMessages([]);
    setLoadingMsgs(true);
    setConversations(prev => prev.map(item => (
      item.id === conv.id ? normalizedConv : item
    )));

    await fetchMsgs(conv.id);
    setLoadingMsgs(false);
  };

  const handleSend = async () => {
    if (!draft.trim() || !selectedConv || sending) return;

    setSending(true);
    const content = draft.trim();
    setDraft('');

    try {
      const res = await fetch(`${API}/messages/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          conversation_id: selectedConv.id,
          content,
          message_type: 'text',
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      setTimeout(() => {
        if (currentConvId.current) {
          fetchMsgs(currentConvId.current);
        }
        fetchConvs();
      }, 500);
    } catch (error: unknown) {
      console.error('[handleSend]', error);
      setDraft(content);
      alert('Erro ao enviar. Verifique se o WhatsApp esta conectado.');
    } finally {
      setSending(false);
    }
  };

  const getName = (conversation: Conversation) =>
    conversation.contact_name || conversation.evolution_contacts?.name || 'Sem nome';

  // Retorna telefone formatado BR se possivel; senao retorna numero cru se parecer telefone real;
  // senao retorna string vazia (LID nao resolvido)
  const getPhone = (conversation: Conversation): string => {
    const fromContact = normalizePhone(conversation.evolution_contacts?.phone);
    const fromConv = normalizePhone(conversation.phone);
    const candidate = isRealPhone(fromContact) ? fromContact : (fromConv || fromContact);

    const formatted = parseBRPhone(candidate);
    if (formatted) return formatted;

    const digits = candidate.split('@')[0].replace(/\D/g, '');
    // Se nao tem prefixo 55 ou tamanho fora do esperado, é LID nao resolvido — esconder
    if (!digits.startsWith('55') || digits.length < 12 || digits.length > 13) {
      return '';
    }
    // Tem prefixo BR mas parseBRPhone falhou (DDD invalido?) — mostrar cru
    return '+' + digits;
  };

  const getInitials = (name: string) =>
    name.split(' ').map(word => word[0]).join('').substring(0, 2).toUpperCase();

  const formatTime = (value: string) => {
    if (!value) return '';

    const date = new Date(value);
    const diff = Math.floor((Date.parse(new Date().toISOString()) - date.getTime()) / 86400000);

    if (diff === 0) {
      return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }

    if (diff === 1) {
      return 'Ontem';
    }

    if (diff < 7) {
      return date.toLocaleDateString('pt-BR', { weekday: 'short' });
    }

    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  };

  const filtered = conversations.filter(conversation => {
    if (!searchTerm) return true;

    const normalizedSearch = searchTerm.toLowerCase();
    return (
      getName(conversation).toLowerCase().includes(normalizedSearch) ||
      getPhone(conversation).toLowerCase().includes(normalizedSearch)
    );
  });

  return (
    <DashboardLayout>
      <div className="flex h-[calc(100vh-64px)] bg-gray-100">
        <div className={`${selectedConv ? 'hidden md:flex' : 'flex'} flex-col w-full md:w-96 bg-white border-r border-gray-200`}>
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold text-gray-900">Conversas</h1>
                <span className={`text-xs px-1.5 py-0.5 rounded-full flex items-center gap-1 ${socketOk ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${socketOk ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}`} />
                  {socketOk ? 'Live' : 'Polling'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 bg-gray-200 px-2 py-1 rounded-full">{filtered.length}</span>
              </div>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Buscar conversa..."
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                className="w-full pl-9 pr-4 py-2 bg-white border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {loadingConvs && conversations.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mb-3" />
                <p className="text-gray-500 text-sm">Carregando...</p>
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 px-6">
                <MessageSquare className="h-12 w-12 text-gray-300 mb-3" />
                <p className="text-gray-500 text-sm text-center">
                  {searchTerm ? 'Nenhuma conversa encontrada' : 'Nenhuma conversa ainda'}
                </p>
              </div>
            ) : (
              filtered.map(conv => (
                <button
                  key={conv.id}
                  onClick={() => openConv(conv)}
                  className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 border-b border-gray-100 text-left transition-colors ${selectedConv?.id === conv.id ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''}`}
                >
                  <div className="flex-shrink-0 w-12 h-12 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white font-semibold text-sm">
                    {getInitials(getName(conv))}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-gray-900 text-sm truncate">{getName(conv)}</span>
                      <span className="text-xs text-gray-400 ml-2 flex-shrink-0">{formatTime(conv.last_message_at)}</span>
                    </div>
                    <div className="flex items-center justify-between mt-0.5">
                      <span className="text-xs text-gray-500 truncate">{getPhone(conv) || 'WhatsApp'}</span>
                      {conv.unread_count > 0 && (
                        <span className="ml-2 bg-green-500 text-white text-xs font-bold rounded-full h-5 min-w-[20px] flex items-center justify-center px-1.5">
                          {conv.unread_count}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        <div className={`${selectedConv ? 'flex' : 'hidden md:flex'} flex-col flex-1 bg-gray-50`}>
          {selectedConv ? (
            <>
              <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 shadow-sm">
                <button onClick={() => setSelectedConv(null)} className="md:hidden p-1 text-gray-500 hover:text-gray-700">
                  <ArrowLeft className="h-5 w-5" />
                </button>
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white font-semibold text-sm">
                  {getInitials(getName(selectedConv))}
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="font-semibold text-gray-900 text-sm truncate">{getName(selectedConv)}</h2>
                  <p className="text-xs text-gray-500 truncate">{getPhone(selectedConv) || 'WhatsApp'}</p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${selectedConv.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                  {selectedConv.status === 'active' ? 'Ativa' : selectedConv.status}
                </span>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-4">
                {loadingMsgs ? (
                  <div className="flex items-center justify-center h-full">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
                  </div>
                ) : messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full">
                    <MessageSquare className="h-16 w-16 text-gray-300 mb-3" />
                    <p className="text-gray-400 text-sm">Nenhuma mensagem ainda</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {messages.map(msg => (
                      <div key={msg.id} className={`flex ${msg.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[75%] rounded-lg px-3 py-2 shadow-sm ${msg.direction === 'out' ? 'bg-green-100 rounded-br-none' : 'bg-white rounded-bl-none'}`}>
                          {msg.is_from_ai && (
                            <span className="text-xs text-purple-600 font-medium block mb-1">IA</span>
                          )}
                          <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                          <div className="flex items-center justify-end gap-1 mt-1">
                            <span className="text-[10px] text-gray-400">{formatTime(msg.sent_at || msg.created_at)}</span>
                            {msg.direction === 'out' && (
                              msg.status === 'read'
                                ? <CheckCheck className="h-3 w-3 text-blue-500" />
                                : <Check className="h-3 w-3 text-gray-400" />
                            )}
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
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        handleSend();
                      }
                    }}
                    placeholder="Digite uma mensagem..."
                    rows={1}
                    className="flex-1 resize-none px-4 py-2.5 bg-gray-100 border border-gray-200 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 max-h-32"
                    style={{ minHeight: '42px' }}
                  />
                  <button
                    onClick={handleSend}
                    disabled={!draft.trim() || sending}
                    className="flex-shrink-0 p-2.5 bg-blue-600 text-white rounded-full hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
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
                <h2 className="text-xl font-bold text-gray-900 mb-2">ContatoSync</h2>
                <p className="text-gray-500 text-sm">Selecione uma conversa para ver as mensagens</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
