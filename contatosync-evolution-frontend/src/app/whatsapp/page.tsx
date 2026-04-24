'use client';

import { useState, useEffect } from 'react';
import { Smartphone, Plus, Trash2, MessageSquare, AlertCircle, Wifi, WifiOff, Clock, RefreshCw } from 'lucide-react';
import { apiService } from '@/lib/api';
import { WhatsAppSession } from '@/types/whatsapp';
import DashboardLayout from '@/components/DashboardLayout';
import QRCodeModal from '@/components/QRCodeModal';
import NewSessionModal from '@/components/NewSessionModal';
import SendMessageModal from '@/components/SendMessageModal';

export default function WhatsAppPage() {
  const [sessions, setSessions] = useState<WhatsAppSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSession, setSelectedSession] = useState<WhatsAppSession | null>(null);
  const [showQRModal, setShowQRModal] = useState(false);
  const [showNewSession, setShowNewSession] = useState(false);
  const [showSendMessage, setShowSendMessage] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState<NodeJS.Timeout | null>(null);

  useEffect(() => {
    loadSessions();

    // Atualizar status a cada 5 segundos para tempo real
    const interval = setInterval(() => {
      console.log('Atualizando sessões...');
      loadSessions();
    }, 5000);

    setRefreshInterval(interval);

    return () => {
      console.log('Limpando interval...');
      clearInterval(interval);
    };
  }, []);

  const loadSessions = async () => {
    try {
      const data = await apiService.getWhatsAppSessions();
      const sessionsWithUpdatedStatus = await Promise.all(
        (data || []).map(async (session) => {
          try {
            // Verificar status individual de cada sessão
            const statusData = await apiService.getSessionStatus(session.session_name);
            return {
              ...session,
              evolution_status: statusData?.instance?.state || session.evolution_status || session.status,
              last_status_check: new Date().toISOString()
            };
          } catch (error) {
            console.error(`Erro ao verificar status da sessão ${session.session_name}:`, error);
            return session;
          }
        })
      );
      setSessions(sessionsWithUpdatedStatus);
    } catch (error: unknown) {
      console.error('Erro ao carregar sessões:', error);
      // Em caso de rate limiting, não mostrar erro para o usuário
      const axiosError = error as { response?: { status?: number } };
      if (axiosError.response?.status !== 429) {
        console.error('Erro não relacionado ao rate limit:', error);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCreateSession = async (sessionName: string) => {
    try {
      await apiService.createWhatsAppSession(sessionName);
      setShowNewSession(false);
      loadSessions();
    } catch (error: unknown) {
      console.error('Erro ao criar sessão:', error);
    }
  };

  const handleDeleteSession = async (session: WhatsAppSession) => {
    if (!confirm(`Tem certeza que deseja excluir a sessão "${session.session_name}"?`)) return;

    try {
      await apiService.deleteWhatsAppSession(session.session_name);
      loadSessions();
    } catch (error: unknown) {
      console.error('Erro ao excluir sessão:', error);
    }
  };

  const handleShowQR = (session: WhatsAppSession) => {
    setSelectedSession(session);
    setShowQRModal(true);
  };

  const handleSendMessage = (session: WhatsAppSession) => {
    setSelectedSession(session);
    setShowSendMessage(true);
  };

  const getCurrentStatus = (session: WhatsAppSession): string => {
    // Priorizar evolution_status que vem da API real do WhatsApp
    return session.evolution_status || session.status || 'disconnected';
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'connected':
      case 'open':
        return <Wifi className="h-4 w-4 text-green-500" />;
      case 'qr_pending':
      case 'connecting':
        return <Clock className="h-4 w-4 text-yellow-500" />;
      case 'disconnected':
      case 'close':
        return <WifiOff className="h-4 w-4 text-red-500" />;
      default:
        return <WifiOff className="h-4 w-4 text-gray-500" />;
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'connected':
      case 'open':
        return 'Conectado';
      case 'qr_pending':
      case 'connecting':
        return 'Aguardando QR';
      case 'disconnected':
      case 'close':
        return 'Desconectado';
      default:
        return 'Status desconhecido';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'connected':
      case 'open':
        return 'bg-green-100 text-green-800';
      case 'qr_pending':
      case 'connecting':
        return 'bg-yellow-100 text-yellow-800';
      case 'disconnected':
      case 'close':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-600';
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">WhatsApp</h1>
            <p className="text-gray-600">Gerencie suas conexões WhatsApp</p>
          </div>
          <div className="mt-4 sm:mt-0 flex items-center space-x-3">
            <button
              onClick={() => {
                setLoading(true);
                loadSessions();
              }}
              disabled={loading}
              className="inline-flex items-center px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Atualizar
            </button>
            <button
              onClick={() => setShowNewSession(true)}
              className="inline-flex items-center px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
            >
              <Plus className="h-4 w-4 mr-2" />
              Nova Sessão
            </button>
          </div>
        </div>

        {/* Info Card */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-start">
            <AlertCircle className="h-5 w-5 text-blue-600 mt-0.5 mr-3 flex-shrink-0" />
            <div className="text-sm text-blue-800">
              <p className="font-medium mb-1">Como funciona:</p>
              <ul className="list-disc list-inside space-y-1 text-blue-700">
                <li>Crie uma nova sessão para conectar um número WhatsApp</li>
                <li>Escaneie o QR Code com o WhatsApp do seu celular</li>
                <li>Depois de conectado, você pode enviar e receber mensagens</li>
                <li>Cada sessão representa uma conta WhatsApp diferente</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Sessions List */}
        <div className="bg-white rounded-lg shadow-sm border">
          <div className="px-6 py-4 border-b">
            <h3 className="text-lg font-medium text-gray-900">Sessões WhatsApp</h3>
          </div>

          {loading ? (
            <div className="p-6 text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600 mx-auto"></div>
              <p className="text-gray-500 mt-2">Carregando sessões...</p>
            </div>
          ) : sessions.length === 0 ? (
            <div className="p-6 text-center">
              <Smartphone className="h-12 w-12 text-gray-400 mx-auto mb-3" />
              <p className="text-gray-500 mb-2">Nenhuma sessão WhatsApp criada</p>
              <p className="text-sm text-gray-400 mb-4">Crie sua primeira sessão para começar</p>
              <button
                onClick={() => setShowNewSession(true)}
                className="inline-flex items-center px-3 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700"
              >
                <Plus className="h-4 w-4 mr-2" />
                Criar Sessão
              </button>
            </div>
          ) : (
            <div className="divide-y divide-gray-200">
              {sessions.map((session) => (
                <div key={session.id} className="p-6 hover:bg-gray-50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center space-x-3">
                        <Smartphone className="h-8 w-8 text-gray-400" />
                        <div>
                          <h4 className="text-lg font-medium text-gray-900">{session.session_name}</h4>
                          <div className="flex items-center mt-1 space-x-4">
                            <div className="flex items-center">
                              {getStatusIcon(getCurrentStatus(session))}
                              <span className={`ml-2 px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(getCurrentStatus(session))}`}>
                                {getStatusText(getCurrentStatus(session))}
                              </span>
                            </div>
                            {session.whatsapp_phone && (
                              <span className="text-sm text-gray-500">
                                📱 {session.whatsapp_phone}
                              </span>
                            )}
                          </div>
                          {session.device_info?.profileName && (
                            <p className="text-sm text-gray-500 mt-1">
                              👤 {session.device_info.profileName}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center space-x-2 ml-4">
                      {(['qr_pending', 'connecting', 'disconnected', 'close'].includes(getCurrentStatus(session))) && (
                        <button
                          onClick={() => handleShowQR(session)}
                          className="inline-flex items-center px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                        >
                          📱 QR Code
                        </button>
                      )}

                      {(['connected', 'open'].includes(getCurrentStatus(session))) && (
                        <button
                          onClick={() => handleSendMessage(session)}
                          className="inline-flex items-center px-3 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700"
                        >
                          <MessageSquare className="h-4 w-4 mr-1" />
                          Enviar Mensagem
                        </button>
                      )}

                      <button
                        onClick={() => handleDeleteSession(session)}
                        className="inline-flex items-center px-3 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {showNewSession && (
        <NewSessionModal
          onClose={() => setShowNewSession(false)}
          onSubmit={handleCreateSession}
        />
      )}

      {showQRModal && selectedSession && (
        <QRCodeModal
          session={selectedSession}
          onClose={() => setShowQRModal(false)}
          onConnected={() => {
            setShowQRModal(false);
            loadSessions();
          }}
        />
      )}

      {showSendMessage && selectedSession && (
        <SendMessageModal
          session={selectedSession}
          onClose={() => setShowSendMessage(false)}
          onSent={() => {
            setShowSendMessage(false);
          }}
        />
      )}
    </DashboardLayout>
  );
}