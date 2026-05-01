'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Search, Phone, Mail, MoreHorizontal, Edit, Trash2 } from 'lucide-react';
import { apiService } from '@/lib/api';
import DashboardLayout from '@/components/DashboardLayout';
import ContactForm from '@/components/ContactForm';
import { useSocketContext } from '@/contexts/SocketContext';

interface Contact {
  id: string;
  client_id?: string;
  name: string;
  phone: string;
  email?: string;
  whatsapp_number?: string;
  notes?: string;
  created_at: string;
  updated_at?: string;
  last_message_at?: string;
  status: 'active' | 'inactive' | 'blocked';
}

interface ContactRealtimePayload {
  id?: string;
  contact_id?: string;
  client_id?: string;
  name?: string;
  contact_name?: string;
  phone?: string;
  status?: 'active' | 'inactive' | 'blocked';
  last_message_at?: string;
  created_at?: string;
  updated_at?: string;
  evolution_contacts?: {
    name?: string;
    phone?: string;
  };
}

function isRealPhone(raw?: string): boolean {
  const digits = (raw || '').split('@')[0].replace(/\D/g, '');
  return digits.startsWith('55') && digits.length >= 12 && digits.length <= 13;
}

function normalizePhone(raw?: string): string {
  return (raw || '').split('@')[0].replace(/\D/g, '');
}

function getBestPhone(...phones: Array<string | undefined>): string {
  const realPhone = phones.find(isRealPhone);
  if (realPhone) return normalizePhone(realPhone);
  return normalizePhone(phones.find(Boolean));
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const { on, off } = useSocketContext();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadContacts = useCallback(async () => {
    try {
      setLoading(true);
      const response = await apiService.getContacts(currentPage, 10, searchTerm);
      setContacts(response.items || []);
      setTotalPages(Math.ceil((response.pagination?.total || 0) / 10));
    } catch (error: unknown) {
      console.error('Erro ao carregar contatos:', error);
    } finally {
      setLoading(false);
    }
  }, [currentPage, searchTerm]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      void loadContacts();
    }, 250);
  }, [loadContacts]);

  const upsertContactFromRealtime = useCallback((payload?: ContactRealtimePayload) => {
    if (!payload) return;
    const contactId = payload.contact_id || payload.id;
    if (!contactId) {
      scheduleRefresh();
      return;
    }

    setContacts(prev => {
      const existing = prev.find(contact => contact.id === contactId);
      const nextPhone = getBestPhone(
        payload.phone,
        payload.evolution_contacts?.phone,
        existing?.phone,
      );

      if (!existing) {
        scheduleRefresh();
        return prev;
      }

      const updated: Contact = {
        ...existing,
        name: payload.name || payload.contact_name || payload.evolution_contacts?.name || existing.name,
        phone: nextPhone || existing.phone,
        status: payload.status || existing.status,
        last_message_at: payload.last_message_at || existing.last_message_at,
        updated_at: payload.updated_at || existing.updated_at,
      } as Contact;

      return [updated, ...prev.filter(contact => contact.id !== contactId)];
    });
  }, [scheduleRefresh]);

  useEffect(() => {
    void loadContacts();
  }, [loadContacts]);

  useEffect(() => {
    const handleRealtimeContact = (payload?: ContactRealtimePayload) => {
      upsertContactFromRealtime(payload);
      scheduleRefresh();
    };

    on('new_message', handleRealtimeContact);
    on('conversation_updated', handleRealtimeContact);
    on('conversation_update', handleRealtimeContact);
    on('new_contact', handleRealtimeContact);
    on('contact_updated', handleRealtimeContact);

    return () => {
      off('new_message', handleRealtimeContact);
      off('conversation_updated', handleRealtimeContact);
      off('conversation_update', handleRealtimeContact);
      off('new_contact', handleRealtimeContact);
      off('contact_updated', handleRealtimeContact);
    };
  }, [off, on, scheduleRefresh, upsertContactFromRealtime]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      void loadContacts();
    }, 15000);
    return () => clearInterval(intervalId);
  }, [loadContacts]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      void loadContacts();
    }, 500);
    return () => clearTimeout(timeoutId);
  }, [searchTerm, loadContacts]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadContacts();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadContacts]);

  const handleDelete = async (contactId: string) => {
    if (!confirm('Tem certeza que deseja excluir este contato?')) return;
    try {
      await apiService.deleteContact(contactId);
      void loadContacts();
    } catch (error: unknown) {
      console.error('Erro ao excluir contato:', error);
    }
  };

  const handleEdit = (contact: Contact) => {
    setSelectedContact(contact);
    setShowForm(true);
  };

  const handleCloseForm = () => {
    setShowForm(false);
    setSelectedContact(null);
    void loadContacts();
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active': return 'bg-green-100 text-green-800';
      case 'inactive': return 'bg-gray-100 text-gray-800';
      case 'blocked': return 'bg-red-100 text-red-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatPhone = (raw: string): string => {
    if (!raw) return 'Sem número';
    const digits = raw.replace(/\D/g, '');
    if (digits.startsWith('55') && digits.length >= 12 && digits.length <= 13) {
      const ddd = digits.substring(2, 4);
      const local = digits.substring(4);
      if (local.length === 9 && local.startsWith('9')) {
        return `+55 (${ddd}) ${local.slice(0, 5)}-${local.slice(5)}`;
      }
      if (local.length === 8) {
        return `+55 (${ddd}) ${local.slice(0, 4)}-${local.slice(4)}`;
      }
      return `+${digits}`;
    }
    return 'Número pendente';
  };

  if (loading && currentPage === 1) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Contatos</h1>
          <p className="text-gray-600">Gerencie seus contatos do WhatsApp</p>
        </div>
        <button onClick={() => setShowForm(true)} className="mt-4 sm:mt-0 inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
          <Plus className="h-4 w-4 mr-2" />
          Novo Contato
        </button>
      </div>

      <div className="bg-white p-6 rounded-lg shadow-sm border">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
              <input type="text" placeholder="Buscar por nome, telefone ou email..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="pl-10 pr-4 py-2 w-full border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
            </div>
          </div>
          <select className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
            <option value="">Todos os status</option>
            <option value="active">Ativo</option>
            <option value="inactive">Inativo</option>
            <option value="blocked">Bloqueado</option>
          </select>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
        {contacts.length === 0 ? (
          <div className="text-center py-12">
            <Phone className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-2 text-sm font-medium text-gray-900">Nenhum contato</h3>
            <p className="mt-1 text-sm text-gray-500">{searchTerm ? 'Nenhum contato encontrado para esta busca.' : 'Comece adicionando um novo contato.'}</p>
            {!searchTerm && (
              <div className="mt-6">
                <button onClick={() => setShowForm(true)} className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                  <Plus className="h-4 w-4 mr-2" />
                  Novo Contato
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="divide-y divide-gray-200">
            {contacts.map((contact) => (
              <div key={contact.id} className="p-6 hover:bg-gray-50 transition-colors">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-3">
                      <div className="flex-shrink-0">
                        <div className="h-10 w-10 bg-blue-100 rounded-full flex items-center justify-center">
                          <span className="text-blue-600 font-medium">{contact.name.charAt(0).toUpperCase()}</span>
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center space-x-2">
                          <p className="text-sm font-medium text-gray-900 truncate">{contact.name}</p>
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(contact.status)}`}>
                            {contact.status === 'active' ? 'Ativo' : contact.status === 'inactive' ? 'Inativo' : 'Bloqueado'}
                          </span>
                        </div>
                        <div className="flex items-center space-x-4 mt-1">
                          <div className="flex items-center text-sm text-gray-500">
                            <Phone className="h-3 w-3 mr-1" />
                            {formatPhone(contact.phone)}
                          </div>
                          {contact.email && (
                            <div className="flex items-center text-sm text-gray-500">
                              <Mail className="h-3 w-3 mr-1" />
                              {contact.email}
                            </div>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 mt-1">
                          Criado em {formatDate(contact.created_at)}
                          {contact.last_message_at && (<> • Última mensagem: {formatDate(contact.last_message_at)}</>)}
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button onClick={() => handleEdit(contact)} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"><Edit className="h-4 w-4" /></button>
                    <button onClick={() => handleDelete(contact.id)} className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between bg-white px-6 py-3 border rounded-lg">
          <div className="flex-1 flex justify-between sm:hidden">
            <button onClick={() => setCurrentPage(Math.max(1, currentPage - 1))} disabled={currentPage === 1} className="relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed">Anterior</button>
            <button onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))} disabled={currentPage === totalPages} className="ml-3 relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed">Próximo</button>
          </div>
          <div className="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
            <div><p className="text-sm text-gray-700">Página <span className="font-medium">{currentPage}</span> de <span className="font-medium">{totalPages}</span></p></div>
            <div>
              <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px">
                <button onClick={() => setCurrentPage(Math.max(1, currentPage - 1))} disabled={currentPage === 1} className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed">Anterior</button>
                <button onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))} disabled={currentPage === totalPages} className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed">Próximo</button>
              </nav>
            </div>
          </div>
        </div>
      )}

        {showForm && (
          <ContactForm contact={selectedContact} onClose={handleCloseForm} />
        )}
      </div>
    </DashboardLayout>
  );
}
