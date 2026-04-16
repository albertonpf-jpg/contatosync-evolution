'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useRouter, usePathname } from 'next/navigation';
import ProtectedRoute from '@/components/ProtectedRoute';
import {
  MessageSquare,
  Users,
  Brain,
  TrendingUp,
  Settings,
  Menu,
  X,
  Sun,
  Moon,
  Smartphone
} from 'lucide-react';

interface DashboardLayoutProps {
  children: React.ReactNode;
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  const { user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [darkMode, setDarkMode] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // Toggle dark mode
  const toggleDarkMode = () => {
    setDarkMode(!darkMode);
    document.documentElement.classList.toggle('dark');
  };

  const navigationItems = [
    { name: 'Dashboard', path: '/', icon: TrendingUp },
    { name: 'Contatos', path: '/contacts', icon: Users },
    { name: 'WhatsApp', path: '/whatsapp', icon: Smartphone },
    { name: 'Conversas', path: '/conversations', icon: MessageSquare },
    { name: 'IA Config', path: '/ai-config', icon: Brain },
    { name: 'Configurações', path: '/settings', icon: Settings },
  ];

  const handleNavigation = (path: string) => {
    router.push(path);
    setSidebarOpen(false); // Fechar sidebar em mobile após navegação
  };

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-light-bg dark:bg-dark-bg transition-colors duration-300">
      {/* Sidebar */}
      <div className={`fixed inset-y-0 left-0 z-50 w-64 bg-white dark:bg-dark-card border-r border-light-border dark:border-dark-border transform ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0 transition-transform duration-300 ease-in-out`}>
        <div className="flex items-center justify-between h-16 px-6 border-b border-light-border dark:border-dark-border">
          <h1 className="text-xl font-heading font-bold text-primary-600">ContatoSync</h1>
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <nav className="mt-8 px-4 space-y-2">
          {navigationItems.map((item) => (
            <button
              key={item.name}
              onClick={() => handleNavigation(item.path)}
              className={`w-full flex items-center px-4 py-3 rounded-lg transition-colors duration-200 text-left ${
                pathname === item.path
                  ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              <item.icon className="w-5 h-5 mr-3" />
              <span className="font-medium">{item.name}</span>
            </button>
          ))}
        </nav>
      </div>

      {/* Main Content */}
      <div className="lg:ml-64">
        {/* Header */}
        <header className="bg-white dark:bg-dark-card border-b border-light-border dark:border-dark-border">
          <div className="flex items-center justify-between h-16 px-6">
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden"
            >
              <Menu className="w-6 h-6" />
            </button>

            <div className="flex items-center space-x-4">
              <button
                onClick={toggleDarkMode}
                className="p-2 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              >
                {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>

              <div className="relative">
                <button
                  onClick={() => setUserMenuOpen(!userMenuOpen)}
                  className="w-8 h-8 bg-primary-600 rounded-full flex items-center justify-center cursor-pointer hover:bg-primary-700 transition-colors"
                >
                  <span className="text-white text-sm font-semibold">
                    {user?.name?.[0]?.toUpperCase() || 'U'}
                  </span>
                </button>

                {/* Dropdown Menu */}
                {userMenuOpen && (
                  <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-dark-card border border-light-border dark:border-dark-border rounded-lg shadow-lg z-50">
                    <div className="p-3 border-b border-light-border dark:border-dark-border">
                      <p className="font-medium text-gray-900 dark:text-white">{user?.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{user?.email}</p>
                    </div>
                    <button
                      onClick={() => {
                        setUserMenuOpen(false);
                        logout();
                      }}
                      className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-b-lg transition-colors"
                    >
                      Sair
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="p-6">
          {children}
        </main>
      </div>

      {/* Mobile Overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        ></div>
      )}

      {/* User Menu Overlay */}
      {userMenuOpen && (
        <div
          className="fixed inset-0 z-10"
          onClick={() => setUserMenuOpen(false)}
        ></div>
      )}
      </div>
    </ProtectedRoute>
  );
}