'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { apiService } from '@/lib/api';
import DashboardLayout from '@/components/DashboardLayout';
import {
  MessageSquare,
  Users,
  Brain,
  Phone
} from 'lucide-react';

interface DashboardStats {
  totalContacts: number;
  totalConversations: number;
  aiResponses: number;
  messagesSent: number;
}

export default function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState<DashboardStats>({
    totalContacts: 0,
    totalConversations: 0,
    aiResponses: 0,
    messagesSent: 0
  });
  const [isLoadingStats, setIsLoadingStats] = useState(true);

  // Carregar estatísticas da API
  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    try {
      setIsLoadingStats(true);

      // Por enquanto, usar dados do perfil do usuário para estatísticas
      const userProfile = await apiService.getProfile();

      setStats({
        totalContacts: userProfile.total_contacts_saved || 0,
        totalConversations: 0, // Será implementado quando criar endpoint
        aiResponses: userProfile.total_ai_responses || 0,
        messagesSent: userProfile.total_messages_sent || 0
      });
    } catch (error) {
      console.error('Erro ao carregar estatísticas:', error);
      // Usar dados básicos em caso de erro
      setStats({
        totalContacts: 0,
        totalConversations: 0,
        aiResponses: 0,
        messagesSent: 0
      });
    } finally {
      setIsLoadingStats(false);
    }
  };

  return (
    <DashboardLayout>
      <div>
        {/* Welcome Section */}
        <div className="mb-8">
          <h1 className="text-4xl font-display font-bold text-gray-900 dark:text-white mb-4 animate-fade-in">
            Bem-vindo, {user?.name || 'Usuário'}! 👋
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-400 animate-fade-in" style={{animationDelay: '0.1s'}}>
            Gerencie suas conversas WhatsApp com inteligência artificial avançada
          </p>
        </div>
          {/* Welcome Section */}
          <div className="mb-8">
            <h1 className="text-4xl font-display font-bold text-gray-900 dark:text-white mb-4 animate-fade-in">
              Bem-vindo, {user?.name || 'Usuário'}! 👋
            </h1>
            <p className="text-lg text-gray-600 dark:text-gray-400 animate-fade-in" style={{animationDelay: '0.1s'}}>
              Gerencie suas conversas WhatsApp com inteligência artificial avançada
            </p>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            {/* Total Contatos */}
            <div className="card animate-fade-in" style={{animationDelay: '0.2s'}}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Total Contatos</p>
                  <p className="text-3xl font-bold text-gray-900 dark:text-white">{stats.totalContacts.toLocaleString()}</p>
                </div>
                <div className="p-3 bg-blue-100 dark:bg-blue-900/20 rounded-lg">
                  <Users className="w-8 h-8 text-blue-600 dark:text-blue-400" />
                </div>
              </div>
              <div className="mt-4 flex items-center">
                <span className="text-green-500 text-sm font-medium">+12%</span>
                <span className="text-gray-500 text-sm ml-2">vs mês passado</span>
              </div>
            </div>

            {/* Conversas Ativas */}
            <div className="card animate-fade-in" style={{animationDelay: '0.3s'}}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Conversas Ativas</p>
                  <p className="text-3xl font-bold text-gray-900 dark:text-white">{stats.totalConversations}</p>
                </div>
                <div className="p-3 bg-green-100 dark:bg-green-900/20 rounded-lg">
                  <MessageSquare className="w-8 h-8 text-green-600 dark:text-green-400" />
                </div>
              </div>
              <div className="mt-4 flex items-center">
                <span className="text-green-500 text-sm font-medium">+8%</span>
                <span className="text-gray-500 text-sm ml-2">vs semana passada</span>
              </div>
            </div>

            {/* Respostas IA */}
            <div className="card animate-fade-in" style={{animationDelay: '0.4s'}}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Respostas IA</p>
                  <p className="text-3xl font-bold text-gray-900 dark:text-white">{stats.aiResponses}</p>
                </div>
                <div className="p-3 bg-purple-100 dark:bg-purple-900/20 rounded-lg">
                  <Brain className="w-8 h-8 text-purple-600 dark:text-purple-400" />
                </div>
              </div>
              <div className="mt-4 flex items-center">
                <span className="text-green-500 text-sm font-medium">+24%</span>
                <span className="text-gray-500 text-sm ml-2">hoje</span>
              </div>
            </div>

            {/* Mensagens Enviadas */}
            <div className="card animate-fade-in" style={{animationDelay: '0.5s'}}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600 dark:text-gray-400">Mensagens Enviadas</p>
                  <p className="text-3xl font-bold text-gray-900 dark:text-white">{stats.messagesSent.toLocaleString()}</p>
                </div>
                <div className="p-3 bg-orange-100 dark:bg-orange-900/20 rounded-lg">
                  <Phone className="w-8 h-8 text-orange-600 dark:text-orange-400" />
                </div>
              </div>
              <div className="mt-4 flex items-center">
                <span className="text-green-500 text-sm font-medium">+18%</span>
                <span className="text-gray-500 text-sm ml-2">este mês</span>
              </div>
            </div>
          </div>

          {/* Recent Activity & Quick Actions */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Recent Activity */}
            <div className="card animate-fade-in" style={{animationDelay: '0.6s'}}>
              <h3 className="text-xl font-heading font-semibold text-gray-900 dark:text-white mb-6">
                Atividades Recentes
              </h3>
              <div className="space-y-4">
                {[1, 2, 3].map((item) => (
                  <div key={item} className="flex items-center space-x-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">
                        Nova conversa iniciada
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        há 2 minutos
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Quick Actions */}
            <div className="card animate-fade-in" style={{animationDelay: '0.7s'}}>
              <h3 className="text-xl font-heading font-semibold text-gray-900 dark:text-white mb-6">
                Ações Rápidas
              </h3>
              <div className="space-y-3">
                <button className="btn-primary w-full text-left flex items-center">
                  <MessageSquare className="w-5 h-5 mr-3" />
                  Nova Conversa
                </button>
                <button className="w-full p-3 text-left border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors flex items-center">
                  <Users className="w-5 h-5 mr-3 text-gray-600 dark:text-gray-400" />
                  Importar Contatos
                </button>
                <button className="w-full p-3 text-left border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors flex items-center">
                  <Brain className="w-5 h-5 mr-3 text-gray-600 dark:text-gray-400" />
                  Configurar IA
                </button>
              </div>
            </div>
          </div>
      </div>
    </DashboardLayout>
  );
}