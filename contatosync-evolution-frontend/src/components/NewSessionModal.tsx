'use client';

import { useState } from 'react';
import { X, Plus, Smartphone } from 'lucide-react';

interface NewSessionModalProps {
  onClose: () => void;
  onSubmit: (sessionName: string) => Promise<void>;
}

export default function NewSessionModal({ onClose, onSubmit }: NewSessionModalProps) {
  const [sessionName, setSessionName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!sessionName.trim()) {
      setError('Nome da sessão é obrigatório');
      return;
    }

    // Validar nome da sessão (apenas letras, números, underscore)
    if (!/^[a-zA-Z0-9_]+$/.test(sessionName)) {
      setError('Nome deve conter apenas letras, números e underscore');
      return;
    }

    try {
      setLoading(true);
      setError('');
      await onSubmit(sessionName.toLowerCase());
    } catch (err: any) {
      setError(err.response?.data?.message || 'Erro ao criar sessão');
    } finally {
      setLoading(false);
    }
  };

  const generateSuggestion = () => {
    const suggestions = [
      'whatsapp_principal',
      'whatsapp_vendas',
      'whatsapp_atendimento',
      'whatsapp_suporte',
      'whatsapp_pessoal'
    ];
    const random = suggestions[Math.floor(Math.random() * suggestions.length)];
    setSessionName(random);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b">
          <div className="flex items-center">
            <div className="bg-green-100 p-3 rounded-lg mr-3">
              <Smartphone className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Nova Sessão WhatsApp</h2>
              <p className="text-sm text-gray-500">Crie uma nova conexão WhatsApp</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6">
          {error && (
            <div className="mb-4 bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}

          <div className="space-y-4">
            {/* Nome da Sessão */}
            <div>
              <label htmlFor="sessionName" className="block text-sm font-medium text-gray-700 mb-2">
                Nome da Sessão *
              </label>
              <input
                type="text"
                id="sessionName"
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                placeholder="Ex: whatsapp_vendas"
                disabled={loading}
                maxLength={50}
              />
              <p className="text-xs text-gray-500 mt-1">
                Apenas letras, números e underscore. Será usado como identificador único.
              </p>
            </div>

            {/* Sugestões */}
            <div>
              <p className="text-sm text-gray-700 mb-2">Sugestões:</p>
              <div className="flex flex-wrap gap-2">
                {['principal', 'vendas', 'atendimento', 'suporte'].map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => setSessionName(`whatsapp_${suggestion}`)}
                    className="px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded-full hover:bg-gray-200 transition-colors"
                    disabled={loading}
                  >
                    whatsapp_{suggestion}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={generateSuggestion}
                  className="px-3 py-1 text-xs bg-green-100 text-green-700 rounded-full hover:bg-green-200 transition-colors"
                  disabled={loading}
                >
                  🎲 Aleatório
                </button>
              </div>
            </div>

            {/* Info */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p className="text-sm text-blue-800">
                <strong>Próximos passos:</strong><br />
                1. Após criar, será gerado um QR Code<br />
                2. Abra o WhatsApp no seu celular<br />
                3. Vá em "Aparelhos conectados" &gt; "Conectar um aparelho"<br />
                4. Escaneie o QR Code
              </p>
            </div>
          </div>

          {/* Buttons */}
          <div className="flex justify-end space-x-3 mt-6">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={loading || !sessionName.trim()}
              className="inline-flex items-center px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Criando...
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4 mr-2" />
                  Criar Sessão
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}