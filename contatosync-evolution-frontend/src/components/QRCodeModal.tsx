'use client';

import { useState, useEffect } from 'react';
import { X, RefreshCw, Smartphone, CheckCircle, AlertTriangle } from 'lucide-react';
import { apiService } from '@/lib/api';
import { WhatsAppSession, QRCodeResponse } from '@/types/whatsapp';

interface QRCodeModalProps {
  session: WhatsAppSession;
  onClose: () => void;
  onConnected: () => void;
}

export default function QRCodeModal({ session, onClose, onConnected }: QRCodeModalProps) {
  const [qrData, setQrData] = useState<QRCodeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<string>(session.status);
  const [checkingStatus, setCheckingStatus] = useState(false);

  useEffect(() => {
    loadQRCode();

    // Verificar status a cada 3 segundos
    const statusInterval = setInterval(() => {
      checkStatus();
    }, 3000);

    return () => clearInterval(statusInterval);
  }, []);

  const loadQRCode = async () => {
    try {
      setLoading(true);
      setError('');
      const data = await apiService.getQRCode(session.session_name);

      console.log('QR Code data received:', data);

      setQrData(data);
    } catch (err: any) {
      console.error('QR Code error:', err);
      setError(err.response?.data?.message || 'Erro ao carregar QR Code');
    } finally {
      setLoading(false);
    }
  };

  const checkStatus = async () => {
    try {
      setCheckingStatus(true);
      const statusData = await apiService.getSessionStatus(session.session_name);
      const newStatus = statusData.instance.state;

      if (newStatus !== status) {
        setStatus(newStatus);

        if (newStatus === 'open') {
          // Conectado com sucesso!
          setTimeout(() => {
            onConnected();
          }, 2000);
        }
      }
    } catch (err) {
      console.error('Erro ao verificar status:', err);
    } finally {
      setCheckingStatus(false);
    }
  };

  const handleRefresh = () => {
    loadQRCode();
  };

  const getStatusDisplay = () => {
    switch (status) {
      case 'open':
        return {
          icon: <CheckCircle className="h-6 w-6 text-green-500" />,
          text: 'Conectado com sucesso!',
          color: 'text-green-600',
          bg: 'bg-green-50 border-green-200'
        };
      case 'connecting':
        return {
          icon: <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>,
          text: 'Conectando...',
          color: 'text-blue-600',
          bg: 'bg-blue-50 border-blue-200'
        };
      case 'close':
      default:
        return {
          icon: <Smartphone className="h-6 w-6 text-gray-500" />,
          text: 'Aguardando leitura do QR Code',
          color: 'text-gray-600',
          bg: 'bg-gray-50 border-gray-200'
        };
    }
  };

  const statusDisplay = getStatusDisplay();

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">QR Code - {session.session_name}</h2>
            <p className="text-sm text-gray-500">Escaneie com o WhatsApp do seu celular</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* Status */}
          <div className={`flex items-center p-4 rounded-lg border mb-6 ${statusDisplay.bg}`}>
            {statusDisplay.icon}
            <div className="ml-3">
              <p className={`font-medium ${statusDisplay.color}`}>{statusDisplay.text}</p>
              {checkingStatus && (
                <p className="text-sm text-gray-500">Verificando status...</p>
              )}
            </div>
          </div>

          {status === 'open' ? (
            /* Success State */
            <div className="text-center py-8">
              <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-green-600 mb-2">WhatsApp Conectado!</h3>
              <p className="text-gray-600 mb-4">
                Sua sessão está ativa e pronta para enviar/receber mensagens
              </p>
              <button
                onClick={onConnected}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
              >
                Continuar
              </button>
            </div>
          ) : error ? (
            /* Error State */
            <div className="text-center py-8">
              <AlertTriangle className="h-16 w-16 text-red-500 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-red-600 mb-2">Erro ao Carregar QR Code</h3>
              <p className="text-gray-600 mb-4">{error}</p>
              <button
                onClick={handleRefresh}
                className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Tentar Novamente
              </button>
            </div>
          ) : loading ? (
            /* Loading State */
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-green-600 mx-auto mb-4"></div>
              <p className="text-gray-600">Gerando QR Code...</p>
            </div>
          ) : (
            /* QR Code Display */
            <div className="space-y-6">
              {/* QR Code */}
              <div className="flex justify-center">
                <div className="bg-white p-4 rounded-lg border-2 border-gray-200">
                  {(() => {
                    // Debug completo
                    console.log('QR Data completa:', qrData);

                    // Tentar diferentes campos possíveis para o QR code
                    const qrImage = qrData?.base64 || qrData?.qr || qrData?.qrcode;

                    console.log('QR Image encontrada:', qrImage ? 'SIM' : 'NÃO');

                    if (qrImage) {
                      return (
                        <div className="space-y-2">
                          <img
                            src={qrImage}
                            alt="QR Code WhatsApp"
                            className="w-64 h-64 border border-gray-300"
                            onError={(e) => {
                              console.error('Erro ao carregar QR Code:', e);
                              console.error('URL da imagem:', qrImage);
                            }}
                            onLoad={() => console.log('✅ QR Code carregado com sucesso!')}
                          />
                          <p className="text-xs text-green-600 text-center">QR Code carregado</p>
                        </div>
                      );
                    } else {
                      return (
                        <div className="w-64 h-64 bg-red-50 border-2 border-red-200 flex flex-col items-center justify-center rounded-lg p-4">
                          <p className="text-red-600 font-medium mb-2">QR Code não disponível</p>
                          <div className="text-xs text-gray-500 text-left">
                            <p><strong>Debug:</strong></p>
                            <pre className="whitespace-pre-wrap text-xs">
                              {JSON.stringify(qrData, null, 2)}
                            </pre>
                          </div>
                        </div>
                      );
                    }
                  })()}
                </div>
              </div>

              {/* Instructions */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h4 className="font-medium text-blue-900 mb-3">Como conectar:</h4>
                <ol className="list-decimal list-inside space-y-2 text-sm text-blue-800">
                  <li>Abra o <strong>WhatsApp</strong> no seu celular</li>
                  <li>Vá em <strong>"Aparelhos conectados"</strong></li>
                  <li>Toque em <strong>"Conectar um aparelho"</strong></li>
                  <li>Escaneie o QR Code acima</li>
                  <li>Aguarde a confirmação de conexão</li>
                </ol>
              </div>

              {/* Refresh Button */}
              <div className="flex justify-center">
                <button
                  onClick={handleRefresh}
                  disabled={loading}
                  className="inline-flex items-center px-3 py-2 text-sm bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50"
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                  Atualizar QR Code
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}