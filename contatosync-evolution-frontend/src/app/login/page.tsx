'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { LoginCredentials } from '@/types/auth';
import {
  MessageSquare,
  Eye,
  EyeOff,
  Mail,
  Lock,
  Brain,
  Users,
  TrendingUp
} from 'lucide-react';
import Link from 'next/link';

export default function LoginPage() {
  const router = useRouter();
  const { login, isLoading } = useAuth();
  const [credentials, setCredentials] = useState<LoginCredentials>({
    email: '',
    password: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      await login(credentials);
    } catch (error: any) {
      setError(error.message);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setCredentials(prev => ({
      ...prev,
      [name]: value
    }));
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 to-accent-50 dark:from-dark-bg dark:to-dark-card flex items-center justify-center px-6 py-12">
      {/* Background Pattern */}
      <div className="absolute inset-0 opacity-5 dark:opacity-10">
        <div className="absolute inset-0" style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%234F46E5' fill-opacity='0.1'%3E%3Cpath d='m36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`
        }}></div>
      </div>

      <div className="w-full max-w-6xl mx-auto flex flex-col lg:flex-row items-center gap-12 lg:gap-20" style={{zIndex: 10, position: 'relative'}}>
        {/* Left Side - Branding & Features */}
        <div className="flex-1 text-center lg:text-left animate-fade-in">
          {/* Logo & Title */}
          <div className="mb-8">
            <div className="flex items-center justify-center lg:justify-start mb-6">
              <div className="w-12 h-12 bg-primary-600 rounded-xl flex items-center justify-center mr-4">
                <MessageSquare className="w-7 h-7 text-white" />
              </div>
              <h1 className="text-3xl font-display font-bold text-gray-900 dark:text-white">
                ContatoSync Evolution
              </h1>
            </div>
            <p className="text-xl text-gray-600 dark:text-gray-400 mb-8 max-w-2xl">
              Sistema multi-cliente de gestão WhatsApp com CRM e IA.
              Transforme conversas em relacionamentos duradouros.
            </p>
          </div>

          {/* Features Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div className="text-center p-6 bg-white/50 dark:bg-dark-card/50 rounded-xl backdrop-blur-sm border border-light-border dark:border-dark-border animate-fade-in" style={{animationDelay: '0.1s'}}>
              <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/20 rounded-lg flex items-center justify-center mx-auto mb-4">
                <Users className="w-6 h-6 text-blue-600 dark:text-blue-400" />
              </div>
              <h3 className="font-heading font-semibold text-gray-900 dark:text-white mb-2">Multi-Cliente</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">Gerencie múltiplos clientes em uma só plataforma</p>
            </div>

            <div className="text-center p-6 bg-white/50 dark:bg-dark-card/50 rounded-xl backdrop-blur-sm border border-light-border dark:border-dark-border animate-fade-in" style={{animationDelay: '0.2s'}}>
              <div className="w-12 h-12 bg-purple-100 dark:bg-purple-900/20 rounded-lg flex items-center justify-center mx-auto mb-4">
                <Brain className="w-6 h-6 text-purple-600 dark:text-purple-400" />
              </div>
              <h3 className="font-heading font-semibold text-gray-900 dark:text-white mb-2">IA Integrada</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">Respostas automáticas inteligentes com OpenAI</p>
            </div>

            <div className="text-center p-6 bg-white/50 dark:bg-dark-card/50 rounded-xl backdrop-blur-sm border border-light-border dark:border-dark-border animate-fade-in" style={{animationDelay: '0.3s'}}>
              <div className="w-12 h-12 bg-green-100 dark:bg-green-900/20 rounded-lg flex items-center justify-center mx-auto mb-4">
                <TrendingUp className="w-6 h-6 text-green-600 dark:text-green-400" />
              </div>
              <h3 className="font-heading font-semibold text-gray-900 dark:text-white mb-2">Analytics</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">Relatórios e métricas em tempo real</p>
            </div>
          </div>
        </div>

        {/* Right Side - Login Form */}
        <div className="w-full max-w-md animate-fade-in" style={{animationDelay: '0.4s'}}>
          <div className="bg-white dark:bg-dark-card rounded-2xl p-8 shadow-card-dark border border-light-border dark:border-dark-border">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-heading font-bold text-gray-900 dark:text-white mb-2">
                Entrar na Conta
              </h2>
              <p className="text-gray-600 dark:text-gray-400">
                Acesse seu dashboard e gerencie suas conversas
              </p>
            </div>

            {error && (
              <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Email Field */}
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  E-mail
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Mail className="h-5 w-5 text-gray-400" />
                  </div>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={credentials.email}
                    onChange={handleInputChange}
                    className="block w-full pl-10 pr-3 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-dark-bg text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-colors"
                    placeholder="seu@email.com"
                  />
                </div>
              </div>

              {/* Password Field */}
              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Senha
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Lock className="h-5 w-5 text-gray-400" />
                  </div>
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    value={credentials.password}
                    onChange={handleInputChange}
                    className="block w-full pl-10 pr-10 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-dark-bg text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-colors"
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center"
                  >
                    {showPassword ? (
                      <EyeOff className="h-5 w-5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" />
                    ) : (
                      <Eye className="h-5 w-5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" />
                    )}
                  </button>
                </div>
              </div>

              {/* Login Button */}
              <button
                type="submit"
                disabled={isLoading}
                className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
              >
                {isLoading ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mr-3"></div>
                    Entrando...
                  </>
                ) : (
                  'Entrar'
                )}
              </button>
            </form>

            {/* Register Link */}
            <div className="mt-8 text-center">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Não tem uma conta?{' '}
                <button
                  onClick={() => router.push('/register')}
                  className="font-medium text-primary-600 hover:text-primary-500 transition-colors cursor-pointer relative z-50"
                >
                  Cadastre-se aqui
                </button>
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="mt-8 text-center">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Desenvolvido por{' '}
              <span className="font-medium text-primary-600">Planned Mídia</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}