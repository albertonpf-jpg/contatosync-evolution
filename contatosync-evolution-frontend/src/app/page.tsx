'use client';

import { useState, useEffect } from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import { apiService } from '@/lib/api';
import { MessageSquare, Users, TrendingUp, Clock, Zap, Phone } from 'lucide-react';

interface DashboardStats {
  totalContacts: number;
  activeConversations: number;
  messagesThisMonth: number;
  connectedSessions: number;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats>({
    totalContacts: 0,
    activeConversations: 0,
    messagesThisMonth: 0,
    connectedSessions: 0
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    try {
      setLoading(true);
      setError(null);

      // Carregar dados em paralelo
      const [contactsRes, conversationsRes, sessionsRes] = await Promise.all([
        apiService.getContacts(1, 1).catch(() => ({ items: [], total: 0 })),
        apiService.getConversations(1, 1).catch(() => ({ items: [], total: 0 })),
        apiService.getWhatsAppSessions().catch(() => [])
      ]);

      setStats({
        totalContacts: contactsRes?.total || contactsRes?.items?.length || 0,
        activeConversations: conversationsRes?.total || conversationsRes?.items?.length || 0,
        messagesThisMonth: 0, // TODO: implementar endpoint de estatísticas
        connectedSessions: Array.isArray(sessionsRes) ? sessionsRes.filter(s => s?.status === 'connected').length : 0
      });
    } catch (err: any) {
      console.error('Erro ao carregar dashboard:', err);
      setError(err.message || 'Erro ao carregar dados');
    } finally {
      setLoading(false);
    }
  };

  const statCards = [
    { title: 'Total Contatos', value: stats.totalContacts, icon: Users, color: 'bg-blue-500' },
    { title: 'Conversas Ativas', value: stats.activeConversations, icon: MessageSquare, color: 'bg-green-500' },
    { title: 'Mensagens/Mês', value: stats.messagesThisMonth, icon: TrendingUp, color: 'bg-purple-500' },
    { title: 'WhatsApp Conectado', value: stats.connectedSessions, icon: Phone, color: 'bg-emerald-500' },
  ];

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-96">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
            <p className="text-gray-500">Carregando dashboard...</p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  if (error) {
    return (
      <DashboardLayout>
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 max-w-md mx-auto mt-8">
          <div className="flex items-center">
            <TrendingUp className="h-8 w-8 text-red-400 mr-3" />
            <div>
              <h2 className="text-red-800 font-semibold">Erro no Dashboard</h2>
              <p className="text-red-600 text-sm mt-1">{error}</p>
            </div>
          </div>
          <button
            onClick={loadDashboardData}
            className="mt-4 px-4 py-2 bg-red-600 text-white text-sm rounded hover:bg-red-700"
          >
            Tentar novamente
          </button>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
              <p className="text-gray-600 mt-1">Visão geral do ContatoSync Evolution</p>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Clock className="h-4 w-4" />
              <span>Atualizado agora</span>
            </div>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
          {statCards.map((card, index) => (
            <div
              key={index}
              className="bg-white rounded-lg border border-gray-200 p-6 hover:shadow-lg transition-shadow"
            >
              <div className="flex items-center">
                <div className={`${card.color} rounded-lg p-3 mr-4`}>
                  <card.icon className="h-6 w-6 text-white" />
                </div>
                <div>
                  <h3 className="text-sm font-medium text-gray-500">{card.title}</h3>
                  <p className="text-2xl font-bold text-gray-900">{card.value}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Quick Actions */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Ações Rápidas</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <button
              onClick={() => window.location.href = '/contacts'}
              className="flex items-center p-4 text-left hover:bg-gray-50 rounded-lg border border-gray-200 transition-colors"
            >
              <Users className="h-8 w-8 text-blue-500 mr-3" />
              <div>
                <h3 className="font-medium text-gray-900">Gerenciar Contatos</h3>
                <p className="text-sm text-gray-500">Adicionar e editar contatos</p>
              </div>
            </button>

            <button
              onClick={() => window.location.href = '/whatsapp'}
              className="flex items-center p-4 text-left hover:bg-gray-50 rounded-lg border border-gray-200 transition-colors"
            >
              <Phone className="h-8 w-8 text-green-500 mr-3" />
              <div>
                <h3 className="font-medium text-gray-900">Conectar WhatsApp</h3>
                <p className="text-sm text-gray-500">Configurar sessões</p>
              </div>
            </button>

            <button
              onClick={() => window.location.href = '/conversations'}
              className="flex items-center p-4 text-left hover:bg-gray-50 rounded-lg border border-gray-200 transition-colors"
            >
              <MessageSquare className="h-8 w-8 text-purple-500 mr-3" />
              <div>
                <h3 className="font-medium text-gray-900">Ver Conversas</h3>
                <p className="text-sm text-gray-500">Acompanhar mensagens</p>
              </div>
            </button>

            <button
              onClick={() => window.location.href = '/ai-config'}
              className="flex items-center p-4 text-left hover:bg-gray-50 rounded-lg border border-gray-200 transition-colors"
            >
              <Zap className="h-8 w-8 text-orange-500 mr-3" />
              <div>
                <h3 className="font-medium text-gray-900">Configurar IA</h3>
                <p className="text-sm text-gray-500">Ajustar automação</p>
              </div>
            </button>
          </div>
        </div>

        {/* Status */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Status do Sistema</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="flex items-center">
              <div className="h-3 w-3 bg-green-500 rounded-full mr-2"></div>
              <span className="text-sm text-gray-700">API Online</span>
            </div>
            <div className="flex items-center">
              <div className={`h-3 w-3 ${stats.connectedSessions > 0 ? 'bg-green-500' : 'bg-red-500'} rounded-full mr-2`}></div>
              <span className="text-sm text-gray-700">
                WhatsApp {stats.connectedSessions > 0 ? 'Conectado' : 'Desconectado'}
              </span>
            </div>
            <div className="flex items-center">
              <div className="h-3 w-3 bg-green-500 rounded-full mr-2"></div>
              <span className="text-sm text-gray-700">Database Online</span>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}