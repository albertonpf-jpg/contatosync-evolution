'use client';

import { useState, useEffect } from 'react';
import { X, Send, User, Search, MessageSquare } from 'lucide-react';
import { apiService } from '@/lib/api';
import { WhatsAppSession } from '@/types/whatsapp';

interface Contact {
  id: string;
  name: string;
  phone: string;
  email?: string;
}

interface SendMessageModalProps {
  session: WhatsAppSession;
  onClose: () => void;
  onSent: () => void;
}

export default function SendMessageModal({ session, onClose, onSent }: SendMessageModalProps) {
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showContacts, setShowContacts] = useState(false);

  useEffect(() => {
    loadContacts();
  }, []);

  const loadContacts = async () => {
    try {
      const response = await apiService.getContacts();
      setContacts(response.items || []);
    } catch (err) {
      console.error('Erro ao carregar contatos:', err);
    }
  };

  const handleContactSelect = (contact: Contact) => {
    setSelectedContact(contact);
    setPhone(contact.phone);
    setShowContacts(false);
    setSearchTerm('');
  };

  const handlePhoneChange = (value: string) => {
    setPhone(value);
    setSelectedContact(null);
  };

  const filteredContacts = contacts.filter(contact =>
    contact.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    contact.phone.includes(searchTerm)
  );

  const formatPhoneForDisplay = (phoneStr: string) => {
    // Remove country code for display
    const cleaned = phoneStr.replace(/\D/g, '');
    if (cleaned.startsWith('55')) {
      return cleaned.substring(2);
    }
    return cleaned;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!phone.trim() || !message.trim()) {
      setError('Telefone e mensagem são obrigatórios');
      return;
    }

    try {
      setLoading(true);
      setError('');

      await apiService.sendWhatsAppMessage(
        session.session_name,
        phone,
        message,
        selectedContact?.id
      );

      onSent();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Erro ao enviar mensagem');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b">
          <div className="flex items-center">
            <div className="bg-green-100 p-3 rounded-lg mr-3">
              <MessageSquare className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Enviar Mensagem</h2>
              <p className="text-sm text-gray-500">Via {session.session_name}</p>
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
            {/* Destinatário */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Destinatário *
              </label>

              {/* Contact Selection */}
              <div className="relative">
                <div className="flex space-x-2">
                  <div className="flex-1">
                    <input
                      type="text"
                      value={phone}
                      onChange={(e) => handlePhoneChange(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                      placeholder="Digite o telefone ou busque um contato"
                      disabled={loading}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowContacts(!showContacts)}
                    className="px-3 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
                    disabled={loading}
                  >
                    <User className="h-5 w-5" />
                  </button>
                </div>

                {/* Selected Contact */}
                {selectedContact && (
                  <div className="mt-2 flex items-center p-2 bg-green-50 border border-green-200 rounded-lg">
                    <User className="h-4 w-4 text-green-600 mr-2" />
                    <div>
                      <p className="text-sm font-medium text-green-800">{selectedContact.name}</p>
                      <p className="text-xs text-green-600">📱 {formatPhoneForDisplay(selectedContact.phone)}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedContact(null);
                        setPhone('');
                      }}
                      className="ml-auto p-1 text-green-600 hover:text-green-800"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}

                {/* Contacts Dropdown */}
                {showContacts && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg z-10 max-h-64 overflow-y-auto">
                    {/* Search */}
                    <div className="p-3 border-b">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
                        <input
                          type="text"
                          value={searchTerm}
                          onChange={(e) => setSearchTerm(e.target.value)}
                          className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                          placeholder="Buscar contatos..."
                        />
                      </div>
                    </div>

                    {/* Contacts List */}
                    <div className="max-h-48 overflow-y-auto">
                      {filteredContacts.length === 0 ? (
                        <div className="p-4 text-center text-gray-500 text-sm">
                          Nenhum contato encontrado
                        </div>
                      ) : (
                        filteredContacts.map((contact) => (
                          <button
                            key={contact.id}
                            type="button"
                            onClick={() => handleContactSelect(contact)}
                            className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
                          >
                            <div className="flex items-center">
                              <User className="h-4 w-4 text-gray-400 mr-3" />
                              <div>
                                <p className="text-sm font-medium text-gray-900">{contact.name}</p>
                                <p className="text-xs text-gray-500">📱 {formatPhoneForDisplay(contact.phone)}</p>
                                {contact.email && (
                                  <p className="text-xs text-gray-400">✉️ {contact.email}</p>
                                )}
                              </div>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>

              <p className="text-xs text-gray-500 mt-1">
                Formato: (11) 99999-9999 ou 11999999999
              </p>
            </div>

            {/* Mensagem */}
            <div>
              <label htmlFor="message" className="block text-sm font-medium text-gray-700 mb-2">
                Mensagem *
              </label>
              <textarea
                id="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
                placeholder="Digite sua mensagem..."
                rows={4}
                disabled={loading}
                maxLength={1000}
              />
              <div className="flex justify-between mt-1">
                <p className="text-xs text-gray-500">
                  Mensagem será enviada via WhatsApp
                </p>
                <p className="text-xs text-gray-500">
                  {message.length}/1000
                </p>
              </div>
            </div>

            {/* Templates (opcional) */}
            <div>
              <p className="text-sm text-gray-700 mb-2">Templates rápidos:</p>
              <div className="flex flex-wrap gap-2">
                {[
                  'Olá! Como posso ajudar?',
                  'Obrigado pelo contato!',
                  'Entraremos em contato em breve.',
                  'Mais informações em nosso site.'
                ].map((template, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={() => setMessage(template)}
                    className="px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded-full hover:bg-gray-200 transition-colors"
                    disabled={loading}
                  >
                    {template}
                  </button>
                ))}
              </div>
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
              disabled={loading || !phone.trim() || !message.trim()}
              className="inline-flex items-center px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Enviando...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  Enviar Mensagem
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}