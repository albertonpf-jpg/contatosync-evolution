'use client';

import { useState, useEffect } from 'react';
import { MessageSquare } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';

export default function ConversationsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Simular carregamento sem API calls
    setTimeout(() => {
      setLoading(false);
      console.log('Conversas página carregada com sucesso');
    }, 1000);
  }, []);

  if (error) {
    return (
      <DashboardLayout>
        <div className="p-6">
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <h2 className="text-red-800 font-semibold">Erro</h2>
            <p className="text-red-700">{error}</p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="p-6">
        <div className="bg-white rounded-lg shadow-sm border p-6">
          <div className="text-center">
            <MessageSquare className="h-16 w-16 text-blue-500 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Conversas WhatsApp</h1>

            {loading ? (
              <div>
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-2"></div>
                <p className="text-gray-600">Carregando conversas...</p>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-green-600 font-semibold">✅ Página carregou com sucesso!</p>
                <p className="text-gray-600">Versão debug - sem API calls</p>

                <div className="bg-blue-50 border border-blue-200 rounded p-4 text-left">
                  <h3 className="font-semibold text-blue-900 mb-2">Debug Info:</h3>
                  <ul className="text-blue-800 text-sm space-y-1">
                    <li>✅ Imports funcionando</li>
                    <li>✅ DashboardLayout funcionando</li>
                    <li>✅ useState/useEffect funcionando</li>
                    <li>✅ TailwindCSS funcionando</li>
                    <li>🔄 Próximo: testar API calls</li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}