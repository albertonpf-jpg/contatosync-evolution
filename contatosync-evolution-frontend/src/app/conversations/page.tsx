'use client';

import { useState, useEffect, useRef } from 'react';
import { MessageSquare, Search, Send, ArrowLeft, RefreshCw, Check, CheckCheck } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { useSocketContext } from '@/contexts/SocketContext';

// ── CONFIG ────────────────────────────────────────────────────────
const API =
  process.env.NEXT_PUBLIC_API_URL ||
  'https://web-production-50297.up.railway.app/api';

// ── TYPES ─────────────────────────────────────────────────────────
interface Contact { name: string; phone: string; }
interface Conversation {
  id: string; client_id: string; contact_id: string;
  contact_name?: string; phone?: string; status: string;
  last_message_at: string; unread_count: number;
  created_at: string; updated_at: string;
  evolution_contacts?: Contact;
}
interface Message {
  id: string; conversation_id: string; content: string;
  message_type: string; direction: 'in' | 'out';
  status: string; is_from_ai: boolean;
  created_at: string; sent_at?: string;
}

// ── API FETCH ─────────────────────────────────────────────────────
// fetch nativo, cache desabilitado, bust de cache via _t
async function apiFetch(path: string, token: string) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${API}${path}${sep}_t=${Date.now()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json?.data; // { items: [...], pagination: {...} }
}

// ── VALIDAÇÃO DE TELEFONE ─────────────────────────────────────────
// Aceita apenas telefone brasileiro real: 55 + DDD válido + celular(9d/9) ou fixo(8d/2-5)
function parseBRPhone(raw: string): string {
  if (!raw || raw.includes('@')) return '';
  const d = raw.replace(/\D/g, '');
  if (!d.startsWith('55') || (d.length !== 12 && d.length !== 13)) return '';
  const ddd = parseInt(d.substring(2, 4), 10);
  if (ddd < 11 || ddd > 99) return '';
  const local = d.substring(4);
  if (local.length === 9 && local.startsWith('9'))
    return `+55 (${ddd}) ${local.slice(0, 5)}-${local.slice(5)}`;
  if (local.length === 8 && /^[2-5]/.test(local))
    return `+55 (${ddd}) ${local.slice(0, 4)}-${local.slice(4)}`;
  return '';
}

// ── COMPONENTE ────────────────────────────────────────────────────
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

  // Manter ref da conversa aberta sempre atual
  useEffect(() => {
    currentConvId.current = selectedConv?.id ?? null;
  }, [selectedConv?.id]);

  // Scroll apenas quando chega mensagem nova
  useEffect(() => {
    if (messages.length > prevMsgCount.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevMsgCount.current = messages.length;
  }, [messages]);

  // ── TOKEN ─────────────────────────────────────────────────────
  function getToken(): string {
    return (typeof window !== 'undefined' ? localStorage.getItem('contatosync_token') : '') ?? '';
  }

  // ── FETCH FUNCTIONS ───────────────────────────────────────────
  // Definidas como funções normais + armazenadas em refs
  // → o setInterval e o socket sempre chamam a versão mais recente

  async function fetchConvs() {
    const token = getToken();
    if (!token) return;
    try {
      const data = await apiFetch('/conversations?page=1&limit=50&status=active', token);
      setConversations(data?.items ?? []);
      setLoadingConvs(false);
    } catch (e: any) {
      console.error('[fetchConvs]', e.message);
      setLoadingConvs(false);
    }
  }

  async function fetchMsgs(id: string) {
    const token = getToken();
    if (!token || !id) return;
    try {
      const data = await apiFetch(`/messages/conversation/${id}?page=1&limit=100`, token);
      setMessages(data?.items ?? []);
    } catch (e: any) {
      console.error('[fetchMsgs]', e.message);
    }
  }

  const fetchConvsRef = useRef(fetchConvs);
  const fetchMsgsRef  = useRef(fetchMsgs);
  fetchConvsRef.current = fetchConvs;
  fetchMsgsRef.current  = fetchMsgs;

  // ── SOCKET via Context global ────────────────────────────────
  // SocketProvider vive no layout.tsx — sempre conectado independente da rota
  const { connected: socketOk, on, off } = useSocketContext();

  useEffect(() => {
    const handleNewMessage = () => {
      fetchConvsRef.current();
      if (currentConvId.current) fetchMsgsRef.current(currentConvId.current);
    };
    const handleConvUpdated = () => {
      fetchConvsRef.current();
    };

    on('new_message', handleNewMessage);
    on('conversation_updated', handleConvUpdated);

    return () => {
      off('new_message', handleNewMessage);
      off('conversation_updated', handleConvUpdated);
    };
  }, [on, off]);

  // ── CARGA INICIAL ─────────────────────────────────────────────
  useEffect(() => {
    fetchConvsRef.current();
  }, []);

  // ── POLLING 3s ────────────────────────────────────────────────
  // Fallback garantido caso socket falhe
  useEffect(() => {
    const id = setInterval(() => {
      fetchConvsRef.current();
      if (currentConvId.current) fetchMsgsRef.current(currentConvId.current);
    }, 3000);
    return () => clearInterval(id);
  }, []);

  // ── ABRIR CONVERSA ────────────────────────────────────────────
  const openConv = async (conv: Conversation) => {
    setSelectedConv(conv);
    setMessages([]);
    setLoadingMsgs(true);
    setConversations(prev => prev.map(c =>
      c.id === conv.id ? { ...c, unread_count: 0 } : c
    ));
    await fetchMsgsRef.current(conv.id);
    setLoadingMsgs(false);
  };

  // ── ENVIAR MENSAGEM ───────────────────────────────────────────
  const handleSend = async () => {
    if (!draft.trim() || !selectedConv || sending) return;
    setSending(true);
    const content = draft.trim();
    setDraft('');
    try {
      const res = await fetch(`${API}/messages/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: selectedConv.id, content, message_type: 'text' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTimeout(() => {
        if (currentConvId.current) fetchMsgsRef.current(currentConvId.current);
        fetchConvsRef.current();
      }, 500);
    } catch (e: any) {
      console.error('[handleSend]', e);
      setDraft(content);
      alert('Erro ao enviar. Verifique se o WhatsApp está conectado.');
    } finally {
      setSending(false);
    }
  };

  // ── HELPERS ───────────────────────────────────────────────────
  const getName = (c: Conversation) =>
    c.contact_name || c.evolution_contacts?.name || 'Sem nome';

  const getPhone = (c: Conversation) =>
    parseBRPhone(c.evolution_contacts?.phone ?? '') ||
    parseBRPhone(c.phone ?? '');

  const getInitials = (n: string) =>
    n.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();

  const formatTime = (d: string) => {
    if (!d) return '';
    const date = new Date(d);
    const diff = Math.floor((Date.now() - date.getTime()) / 86400000);
    if (diff === 0) return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (diff === 1) return 'Ontem';
    if (diff < 7)  return date.toLocaleDateString('pt-BR', { weekday: 'short' });
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  };

  const filtered = conversations.filter(c => {
    if (!searchTerm) return true;
    const s = searchTerm.toLowerCase();
    return getName(c).toLowerCase().includes(s) || getPhone(c).toLowerCase().includes(s);
  });

  // ── RENDER ────────────────────────────────────────────────────
  return (
    <DashboardLayout>
      <div className="flex h-[calc(100vh-64px)] bg-gray-100">

        {/* LISTA DE CONVERSAS */}
        <div className={`${selectedConv ? 'hidden md:flex' : 'flex'} flex-col w-full md:w-96 bg-white border-r border-gray-200`}>
          {/* Header da lista */}
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold text-gray-900">Conversas</h1>
                {/* Indicador de conexão socket */}
                <span className={`text-xs px-1.5 py-0.5 rounded-full flex items-center gap-1 ${socketOk ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${socketOk ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}`} />
                  {socketOk ? 'Live' : 'Polling'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 bg-gray-200 px-2 py-1 rounded-full">{filtered.length}</span>
                <button
                  onClick={() => fetchConvsRef.current()}
                  className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded-full"
                >
                  <RefreshCw className={`h-4 w-4 ${loadingConvs ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Buscar conversa..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-4 py-2 bg-white border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Lista */}
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

        {/* ÁREA DO CHAT */}
        <div className={`${selectedConv ? 'flex' : 'hidden md:flex'} flex-col flex-1 bg-gray-50`}>
          {selectedConv ? (
            <>
              {/* Header do chat */}
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

              {/* Mensagens */}
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
                            <span className="text-xs text-purple-600 font-medium block mb-1">🤖 IA</span>
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

              {/* Input */}
              <div className="px-4 py-3 bg-white border-t border-gray-200">
                <div className="flex items-end gap-2">
                  <textarea
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
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
