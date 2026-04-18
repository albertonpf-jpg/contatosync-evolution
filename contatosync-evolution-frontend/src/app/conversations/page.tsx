'use client';

import DashboardLayout from '@/components/DashboardLayout';

export default function ConversationsPage() {
  return (
    <DashboardLayout>
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-4">Conversas WhatsApp</h1>
        <div className="bg-white rounded-lg shadow p-6">
          <p className="text-gray-600">Página de conversas em desenvolvimento...</p>
          <div className="mt-4">
            <div className="bg-blue-50 border border-blue-200 rounded p-4">
              <p className="text-blue-800">Esta página está sendo testada.</p>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}