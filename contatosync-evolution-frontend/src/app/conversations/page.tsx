'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Camera, Check, CheckCheck, FileText, Image as ImageIcon, MessageSquare, Mic, Paperclip, Search, Send, Smile, Square, Video, X } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useSocketContext } from '@/contexts/SocketContext';
import { getApiUrl } from '@/lib/runtime-config';

const API = getApiUrl();
const QUICK_EMOJIS = ['😀', '😂', '😍', '🙏', '👍', '👏', '🔥', '❤️', '✅', '🎉', '😎', '🤝', '📌', '💬', '🚀', '⭐'];

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
  media_url?: string;
  created_at: string;
  sent_at?: string;
}

interface SocketConversationPayload {
  id?: string;
  conversation_id?: string;
  conversationId?: string;
  client_id?: string;
  contact_id?: string;
  contact_name?: string;
  phone?: string;
  unread_count?: number;
  total_messages?: number;
  status?: string;
  last_message_at?: string;
  created_at?: string;
  updated_at?: string;
  evolution_contacts?: Contact;
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

function getBestPhone(...phones: Array<string | undefined>): string {
  const realPhone = phones.find(phone => isRealPhone(phone));
  if (realPhone) return normalizePhone(realPhone);

  return normalizePhone(phones.find(Boolean));
}

function getConversationId(payload?: SocketConversationPayload): string {
  return payload?.conversation_id || payload?.conversationId || payload?.id || '';
}

function normalizeDirection(direction?: string): Message['direction'] {
  return direction === 'out' || direction === 'outgoing' ? 'out' : 'in';
}

function getMediaUrl(mediaUrl?: string): string {
  if (!mediaUrl) return '';
  if (/^https?:\/\//i.test(mediaUrl)) return mediaUrl;
  const apiRoot = API.endsWith('/api') ? API.slice(0, -4) : API;
  return `${apiRoot}${mediaUrl.startsWith('/') ? mediaUrl : `/${mediaUrl}`}`;
}

function getFileMessageType(file: File): string {
  const name = file.name.toLowerCase();
  if (name.endsWith('.webp')) return 'sticker';
  if (file.type === 'image/gif') return 'gif';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'document';
}

function getPcmPeak(chunks: Float32Array[]): number {
  let peak = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      peak = Math.max(peak, Math.abs(chunk[i]));
    }
  }
  return peak;
}

function getRecordingMimeType(): string {
  const preferredTypes = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/webm'
  ];
  return preferredTypes.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function getRecordingExtension(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'ogg';
  return 'webm';
}

function mediaLabel(type: string): string {
  const labels: Record<string, string> = {
    image: 'Imagem',
    audio: 'Audio',
    video: 'Video',
    gif: 'GIF',
    document: 'Arquivo',
    sticker: 'Figurinha'
  };
  return labels[type] || 'Arquivo';
}

function isMediaPlaceholder(content: string, type: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized === `[${mediaLabel(type).toLowerCase()}]`) return true;
  return /^(audio|image|video|gif|document|sticker)-[a-z0-9]+/i.test(content.trim());
}

export default function ConversationsPage() {
  const { token, isAuthenticated, isLoading: authLoading } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [draft, setDraft] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [failedMediaIds, setFailedMediaIds] = useState<Set<string>>(new Set());
  const [showEmojiPanel, setShowEmojiPanel] = useState(false);
  const [recording, setRecording] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [sending, setSending] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoPreviewRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordingSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const recordingProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const recordingPcmChunksRef = useRef<Float32Array[]>([]);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const prevMsgCount = useRef(0);
  const currentConvId = useRef<string | null>(null);
  const autoOpenedInitialConv = useRef(false);

  useEffect(() => {
    currentConvId.current = selectedConv?.id ?? null;
  }, [selectedConv?.id]);

  useEffect(() => {
    if (messages.length > prevMsgCount.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevMsgCount.current = messages.length;
  }, [messages]);

  useEffect(() => {
    return () => {
      recordingStreamRef.current?.getTracks().forEach(track => track.stop());
      cameraStreamRef.current?.getTracks().forEach(track => track.stop());
    };
  }, []);

  const getToken = useCallback((): string => {
    return token || (typeof window !== 'undefined' ? localStorage.getItem('contatosync_token') : '') || '';
  }, [token]);

  const fetchConvs = useCallback(async () => {
    if (authLoading) return [];
    const currentToken = getToken();
    if (!currentToken) {
      setConversations([]);
      setSelectedConv(null);
      setLoadingConvs(false);
      return [];
    }
    try {
      const data = await apiFetch('/conversations?page=1&limit=50&status=active', currentToken);
      const items: Conversation[] = data?.items ?? [];
      setConversations(items);
      setSelectedConv(prevSelected => {
        if (!prevSelected) return prevSelected;
        const refreshed = items.find(item => item.id === prevSelected.id);
        return refreshed ? { ...refreshed, unread_count: 0 } : prevSelected;
      });
      return items;
    } catch (error: unknown) {
      console.error('[fetchConvs]', getErrorMessage(error));
      return [];
    } finally {
      setLoadingConvs(false);
    }
  }, [authLoading, getToken]);

  const fetchMsgs = useCallback(async (id: string) => {
    if (authLoading) return [];
    const currentToken = getToken();
    if (!currentToken || !id) return [];
    try {
      const data = await apiFetch(`/messages/conversation/${id}?page=1&limit=100`, currentToken);
      const items: Message[] = data?.items ?? [];
      setMessages(items);
      return items;
    } catch (error: unknown) {
      console.error('[fetchMsgs]', getErrorMessage(error));
      return [];
    }
  }, [authLoading, getToken]);

  const { connected: socketOk, on, off } = useSocketContext();

  function upsertConversationFromSocket(payload?: SocketConversationPayload) {
    const conversationId = getConversationId(payload);
    if (!conversationId) return;

    setConversations(prev => {
      const existing = prev.find(conv => conv.id === conversationId);

      const nextPhone = getBestPhone(
        payload?.phone,
        payload?.evolution_contacts?.phone,
        existing?.evolution_contacts?.phone,
        existing?.phone,
      );

      const baseConversation: Conversation = existing || {
        id: conversationId,
        client_id: payload?.client_id || '',
        contact_id: payload?.contact_id || '',
        contact_name: payload?.contact_name || payload?.evolution_contacts?.name || 'Sem nome',
        phone: nextPhone,
        status: payload?.status || 'active',
        last_message_at: payload?.last_message_at || payload?.created_at || new Date().toISOString(),
        unread_count: payload?.unread_count ?? 0,
        created_at: payload?.created_at || new Date().toISOString(),
        updated_at: payload?.updated_at || payload?.last_message_at || new Date().toISOString(),
        evolution_contacts: payload?.evolution_contacts,
      };

      const updatedConversation: Conversation = {
        ...baseConversation,
        contact_id: payload?.contact_id || baseConversation.contact_id,
        contact_name: payload?.contact_name || baseConversation.contact_name,
        phone: nextPhone,
        evolution_contacts: {
          ...baseConversation.evolution_contacts,
          ...payload?.evolution_contacts,
          phone: getBestPhone(payload?.evolution_contacts?.phone, nextPhone, baseConversation.evolution_contacts?.phone),
          name: payload?.evolution_contacts?.name || baseConversation.evolution_contacts?.name || payload?.contact_name || baseConversation.contact_name || 'Sem nome',
        },
        unread_count: payload?.unread_count ?? baseConversation.unread_count,
        status: payload?.status || baseConversation.status,
        last_message_at: payload?.last_message_at || baseConversation.last_message_at,
        updated_at: payload?.updated_at || baseConversation.updated_at,
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
      const fullConv = payload.conversation;
      const conversationId = getConversationId(payload);
      if (!conversationId) return;

      upsertConversationFromSocket({
        conversation_id: conversationId,
        contact_id: payload.contact_id,
        contact_name: payload.contact_name || fullConv?.contact_name,
        phone: payload.phone || fullConv?.phone,
        unread_count: currentConvId.current === conversationId ? 0 : (fullConv?.unread_count ?? undefined),
        status: fullConv?.status,
        last_message_at: payload.sent_at || payload.created_at,
        updated_at: payload.created_at,
      });

      if (conversationId === currentConvId.current) {
        setMessages(prev => {
          if (prev.some(message => message.id === payload.id)) return prev;
          return [
            ...prev,
            {
              id: payload.id,
              conversation_id: conversationId,
              content: payload.content,
              message_type: payload.message_type || 'text',
              direction: normalizeDirection(payload.direction),
              status: payload.status || 'received',
              is_from_ai: !!payload.is_from_ai,
              media_url: payload.media_url,
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
    on('conversation_update', handleConvUpdated);

    return () => {
      off('new_message', handleNewMessage);
      off('conversation_updated', handleConvUpdated);
      off('conversation_update', handleConvUpdated);
    };
  }, [off, on]);

  // Socket.IO é o canal imediato. O polling abaixo cobre reconexões e eventos perdidos.
  useEffect(() => {
    if (authLoading || !isAuthenticated) return;

    const runRefresh = () => {
      void fetchConvs();
      if (currentConvId.current) {
        void fetchMsgs(currentConvId.current);
      }
    };
    const firstRunId = window.setTimeout(runRefresh, 0);
    const intervalId = setInterval(runRefresh, currentConvId.current ? 5000 : 15000);
    return () => {
      clearTimeout(firstRunId);
      clearInterval(intervalId);
    };
  }, [authLoading, fetchConvs, fetchMsgs, isAuthenticated, selectedConv?.id]);

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void fetchConvs();
        if (currentConvId.current) void fetchMsgs(currentConvId.current);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [authLoading, fetchConvs, fetchMsgs, isAuthenticated]);

  const openConv = useCallback(async (conv: Conversation) => {
    const normalizedConv = { ...conv, unread_count: 0 };
    setSelectedConv(normalizedConv);
    setMessages([]);
    setLoadingMsgs(true);
    setConversations(prev => prev.map(item => (item.id === conv.id ? normalizedConv : item)));
    await fetchMsgs(conv.id);
    setLoadingMsgs(false);
  }, [fetchMsgs]);

  useEffect(() => {
    if (autoOpenedInitialConv.current || selectedConv || conversations.length === 0) return;

    autoOpenedInitialConv.current = true;
    void openConv(conversations[0]);
  }, [conversations, openConv, selectedConv]);

  const handleSend = async () => {
    if ((!draft.trim() && !selectedFile) || !selectedConv || sending) return;
    setSending(true);
    const content = draft.trim();
    const fileToSend = selectedFile;
    setDraft('');
    setSelectedFile(null);
    try {
      let res: Response;
      if (fileToSend) {
        const formData = new FormData();
        formData.append('conversation_id', selectedConv.id);
        formData.append('content', content);
        formData.append('message_type', getFileMessageType(fileToSend));
        formData.append('file', fileToSend);
        res = await fetch(`${API}/messages/send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${getToken()}` },
          body: formData,
        });
      } else {
        res = await fetch(`${API}/messages/send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_id: selectedConv.id, content, message_type: 'text' }),
        });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTimeout(() => {
        if (currentConvId.current) fetchMsgs(currentConvId.current);
        fetchConvs();
      }, 500);
    } catch (error: unknown) {
      console.error('[handleSend]', error);
      setDraft(content);
      setSelectedFile(fileToSend);
      alert('Erro ao enviar. Verifique se o WhatsApp esta conectado.');
    } finally {
      setSending(false);
    }
  };

  const addEmoji = (emoji: string) => {
    setDraft(current => `${current}${emoji}`);
    setShowEmojiPanel(false);
  };

  const startRecording = async () => {
    if (recording || sending) return;
    try {
      const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      permissionStream.getTracks().forEach(track => track.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(device => device.kind === 'audioinput');
      const physicalInput = audioInputs.find(device => !['default', 'communications'].includes(device.deviceId));
      const deviceConstraint = physicalInput?.deviceId ? { deviceId: { exact: physicalInput.deviceId } } : {};
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...deviceConstraint,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      recordingStreamRef.current = stream;
      recordingChunksRef.current = [];
      recordingPcmChunksRef.current = [];
      const mimeType = getRecordingMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 }
      );

      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const silentOutput = audioContext.createGain();
      silentOutput.gain.value = 0;
      processor.onaudioprocess = event => {
        recordingPcmChunksRef.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      recorder.ondataavailable = event => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      };
      recorder.onerror = event => {
        console.error('[recording]', event);
      };

      source.connect(processor);
      processor.connect(silentOutput);
      silentOutput.connect(audioContext.destination);
      audioContextRef.current = audioContext;
      recordingSourceRef.current = source;
      recordingProcessorRef.current = processor;
      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setRecording(true);
    } catch (error) {
      console.error('[startRecording]', error);
      alert('Não foi possível acessar o microfone.');
    }
  };

  const stopRecording = () => {
    if (!recording) return;
    const chunks = recordingPcmChunksRef.current;
    const recorder = mediaRecorderRef.current;
    const peak = getPcmPeak(chunks);
    if (recorder) {
      recorder.onstop = () => {
        const type = recorder?.mimeType || 'audio/webm';
        const blob = new Blob(recordingChunksRef.current, { type });
        if (peak < 0.001) {
          alert('Nenhum som foi capturado pelo microfone. Verifique o microfone selecionado no navegador e grave novamente.');
        } else if (blob.size > 0) {
          const extension = getRecordingExtension(type);
          const file = new File([blob], `audio-${Date.now()}.${extension}`, { type });
          setSelectedFile(file);
        }
        recordingChunksRef.current = [];
      };
    }
    if (recorder?.state === 'recording') {
      recorder.requestData();
      recorder.stop();
    } else if (peak < 0.001) {
      alert('Nenhum som foi capturado pelo microfone. Verifique o microfone selecionado no navegador e grave novamente.');
    }

    recordingProcessorRef.current?.disconnect();
    recordingSourceRef.current?.disconnect();
    audioContextRef.current?.close().catch(() => {});
    recordingStreamRef.current?.getTracks().forEach(track => track.stop());
    recordingProcessorRef.current = null;
    recordingSourceRef.current = null;
    audioContextRef.current = null;
    recordingStreamRef.current = null;
    recordingPcmChunksRef.current = [];
    mediaRecorderRef.current = null;
    setRecording(false);
  };

  const openCamera = async () => {
    if (sending) return;
    setCameraError('');
    setCameraOpen(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      cameraStreamRef.current = stream;
      if (videoPreviewRef.current) {
        videoPreviewRef.current.srcObject = stream;
      }
    } catch (error) {
      console.error('[openCamera]', error);
      setCameraError('Não foi possível acessar a câmera.');
    }
  };

  const closeCamera = () => {
    cameraStreamRef.current?.getTracks().forEach(track => track.stop());
    cameraStreamRef.current = null;
    if (videoPreviewRef.current) videoPreviewRef.current.srcObject = null;
    setCameraOpen(false);
    setCameraError('');
  };

  const capturePhoto = () => {
    const video = videoPreviewRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => {
      if (!blob) return;
      const file = new File([blob], `foto-${Date.now()}.jpg`, { type: 'image/jpeg' });
      setSelectedFile(file);
      closeCamera();
    }, 'image/jpeg', 0.92);
  };

  const renderMessageContent = (msg: Message) => {
    const mediaUrl = getMediaUrl(msg.media_url);
    const type = msg.message_type || 'text';

    if (!mediaUrl) {
      return <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>;
    }

    return (
      <div className="space-y-2">
        {type === 'image' || type === 'sticker' || type === 'gif' ? (
          <a href={mediaUrl} target="_blank" rel="noreferrer" className="block">
            {failedMediaIds.has(msg.id) ? (
              <span className="flex items-center gap-2 rounded-md bg-white/70 px-3 py-2 text-sm text-blue-700 hover:underline">
                <ImageIcon className="h-4 w-4" />
                Abrir {mediaLabel(type)}
              </span>
            ) : (
              <img
                src={mediaUrl}
                alt={mediaLabel(type)}
                className="max-h-72 max-w-full rounded-md object-contain bg-white"
                onError={() => setFailedMediaIds(prev => new Set(prev).add(msg.id))}
              />
            )}
          </a>
        ) : type === 'video' ? (
          <video src={mediaUrl} controls className="max-h-80 max-w-full rounded-md bg-black" />
        ) : type === 'audio' ? (
          <audio src={mediaUrl} controls className="w-64 max-w-full" />
        ) : (
          <a href={mediaUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-md bg-white/70 px-3 py-2 text-sm text-blue-700 hover:underline">
            <FileText className="h-4 w-4" />
            <span className="truncate">{msg.content || mediaLabel(type)}</span>
          </a>
        )}
        {msg.content && !isMediaPlaceholder(msg.content, type) && type !== 'document' && (
          <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
        )}
      </div>
    );
  };

  const getName = (conversation: Conversation) =>
    conversation.contact_name || conversation.evolution_contacts?.name || 'Sem nome';

  const getPhone = (conversation: Conversation): string => {
    const fromContact = normalizePhone(conversation.evolution_contacts?.phone);
    const fromConv = normalizePhone(conversation.phone);
    const candidate = isRealPhone(fromContact) ? fromContact : (fromConv || fromContact);
    const formatted = parseBRPhone(candidate);
    if (formatted) return formatted;
    const digits = candidate.split('@')[0].replace(/\D/g, '');
    if (!digits.startsWith('55') || digits.length < 12 || digits.length > 13) return 'Número pendente';
    return '+' + digits;
  };

  const getInitials = (name: string) =>
    name.split(' ').map(word => word[0]).join('').substring(0, 2).toUpperCase();

  const formatTime = (value: string) => {
    if (!value) return '';
    const date = new Date(value);
    const diff = Math.floor((Date.parse(new Date().toISOString()) - date.getTime()) / 86400000);
    if (diff === 0) return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (diff === 1) return 'Ontem';
    if (diff < 7) return date.toLocaleDateString('pt-BR', { weekday: 'short' });
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
        {cameraOpen && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4">
            <div className="w-full max-w-lg rounded-lg bg-white p-4 shadow-xl">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900">Câmera</h3>
                <button type="button" onClick={closeCamera} className="rounded-full p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700">
                  <X className="h-5 w-5" />
                </button>
              </div>
              {cameraError ? (
                <div className="rounded-md bg-red-50 px-3 py-6 text-center text-sm text-red-600">{cameraError}</div>
              ) : (
                <video ref={videoPreviewRef} autoPlay playsInline muted className="aspect-video w-full rounded-md bg-black object-cover" />
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={closeCamera} className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">Cancelar</button>
                <button type="button" onClick={capturePhoto} disabled={!!cameraError} className="rounded-md bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">Usar foto</button>
              </div>
            </div>
          </div>
        )}
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
              <input type="text" placeholder="Buscar conversa..." value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} className="w-full pl-9 pr-4 py-2 bg-white border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
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
                <p className="text-gray-500 text-sm text-center">{searchTerm ? 'Nenhuma conversa encontrada' : 'Nenhuma conversa ainda'}</p>
              </div>
            ) : (
              filtered.map(conv => (
                <button key={conv.id} onClick={() => openConv(conv)} className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 border-b border-gray-100 text-left transition-colors ${selectedConv?.id === conv.id ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''}`}>
                  <div className="flex-shrink-0 w-12 h-12 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white font-semibold text-sm">{getInitials(getName(conv))}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-gray-900 text-sm truncate">{getName(conv)}</span>
                      <span className="text-xs text-gray-400 ml-2 flex-shrink-0">{formatTime(conv.last_message_at)}</span>
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

        <div className={`${selectedConv ? 'flex' : 'hidden md:flex'} flex-col flex-1 bg-gray-50`}>
          {selectedConv ? (
            <>
              <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 shadow-sm">
                <button onClick={() => setSelectedConv(null)} className="md:hidden p-1 text-gray-500 hover:text-gray-700"><ArrowLeft className="h-5 w-5" /></button>
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white font-semibold text-sm">{getInitials(getName(selectedConv))}</div>
                <div className="flex-1 min-w-0">
                  <h2 className="font-semibold text-gray-900 text-sm truncate">{getName(selectedConv)}</h2>
                  <p className="text-xs text-gray-500 truncate">{getPhone(selectedConv) || 'WhatsApp'}</p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${selectedConv.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>{selectedConv.status === 'active' ? 'Ativa' : selectedConv.status}</span>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-4">
                {loadingMsgs ? (
                  <div className="flex items-center justify-center h-full"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" /></div>
                ) : messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full"><MessageSquare className="h-16 w-16 text-gray-300 mb-3" /><p className="text-gray-400 text-sm">Nenhuma mensagem ainda</p></div>
                ) : (
                  <div className="space-y-2">
                    {messages.map(msg => (
                      <div key={msg.id} className={`flex ${msg.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[75%] rounded-lg px-3 py-2 shadow-sm ${msg.direction === 'out' ? 'bg-green-100 rounded-br-none' : 'bg-white rounded-bl-none'}`}>
                          {msg.is_from_ai && (<span className="text-xs text-purple-600 font-medium block mb-1">IA</span>)}
                          {renderMessageContent(msg)}
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
                {showEmojiPanel && (
                  <div className="mb-2 grid max-w-sm grid-cols-8 gap-1 rounded-md border border-gray-200 bg-white p-2 shadow-sm">
                    {QUICK_EMOJIS.map(emoji => (
                      <button key={emoji} type="button" onClick={() => addEmoji(emoji)} className="h-8 rounded-md text-lg hover:bg-gray-100">
                        {emoji}
                      </button>
                    ))}
                  </div>
                )}
                {selectedFile && (
                  <div className="mb-2 flex items-center justify-between rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
                    <span className="flex min-w-0 items-center gap-2">
                      {getFileMessageType(selectedFile) === 'video' ? <Video className="h-4 w-4" /> : getFileMessageType(selectedFile) === 'image' || getFileMessageType(selectedFile) === 'gif' || getFileMessageType(selectedFile) === 'sticker' ? <ImageIcon className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                      <span className="truncate">{selectedFile.name}</span>
                    </span>
                    <button type="button" onClick={() => setSelectedFile(null)} className="ml-3 text-gray-500 hover:text-gray-800">Remover</button>
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <input ref={fileInputRef} type="file" className="hidden" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.rar,.webp" onChange={(event) => setSelectedFile(event.target.files?.[0] || null)} />
                  <button type="button" onClick={() => fileInputRef.current?.click()} disabled={sending} className="flex-shrink-0 p-2.5 bg-gray-100 text-gray-600 rounded-full hover:bg-gray-200 disabled:opacity-50"><Paperclip className="h-5 w-5" /></button>
                  <button type="button" onClick={() => setShowEmojiPanel(current => !current)} disabled={sending} className="flex-shrink-0 p-2.5 bg-gray-100 text-gray-600 rounded-full hover:bg-gray-200 disabled:opacity-50"><Smile className="h-5 w-5" /></button>
                  <button type="button" onClick={openCamera} disabled={sending} className="flex-shrink-0 p-2.5 bg-gray-100 text-gray-600 rounded-full hover:bg-gray-200 disabled:opacity-50"><Camera className="h-5 w-5" /></button>
                  <button type="button" onClick={recording ? stopRecording : startRecording} disabled={sending} className={`flex-shrink-0 p-2.5 rounded-full disabled:opacity-50 ${recording ? 'bg-red-100 text-red-600 hover:bg-red-200' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{recording ? <Square className="h-5 w-5" /> : <Mic className="h-5 w-5" />}</button>
                  <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); handleSend(); } }} placeholder="Digite uma mensagem..." rows={1} className="flex-1 resize-none px-4 py-2.5 bg-gray-100 border border-gray-200 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 max-h-32" style={{ minHeight: '42px' }} />
                  <button onClick={handleSend} disabled={(!draft.trim() && !selectedFile) || sending} className="flex-shrink-0 p-2.5 bg-blue-600 text-white rounded-full hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"><Send className="h-5 w-5" /></button>
                </div>
                {recording && <p className="mt-2 text-xs text-red-600">Gravando áudio...</p>}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-full">
              <div className="bg-white rounded-2xl p-8 shadow-sm text-center max-w-sm">
                <div className="w-20 h-20 rounded-full bg-blue-100 flex items-center justify-center mx-auto mb-4"><MessageSquare className="h-10 w-10 text-blue-500" /></div>
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
