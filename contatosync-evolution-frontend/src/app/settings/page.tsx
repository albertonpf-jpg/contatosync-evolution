'use client';

import { FormEvent, useEffect, useState } from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import { apiService } from '@/lib/api';
import { Loader2, Save, Settings, ShieldCheck, UserRound } from 'lucide-react';

interface ProfileForm {
  name: string;
  company_name: string;
  phone: string;
  openai_api_key: string;
  claude_api_key: string;
  ai_model: string;
  daily_ai_limit: number;
  auto_reply_enabled: boolean;
  working_hours_start: number;
  working_hours_end: number;
}

const defaultForm: ProfileForm = {
  name: '',
  company_name: '',
  phone: '',
  openai_api_key: '',
  claude_api_key: '',
  ai_model: 'gpt-4o-mini',
  daily_ai_limit: 50,
  auto_reply_enabled: true,
  working_hours_start: 9,
  working_hours_end: 18
};

export default function SettingsPage() {
  const [form, setForm] = useState<ProfileForm>(defaultForm);
  const [email, setEmail] = useState('');
  const [plan, setPlan] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      setError(null);
      const profile = await apiService.getClientProfile();
      const client = profile.client || {};
      const aiConfig = profile.aiConfig || {};

      setEmail(client.email || '');
      setPlan(client.plan || '');
      setForm({
        name: client.name || '',
        company_name: client.company_name || '',
        phone: client.phone || '',
        openai_api_key: client.openai_api_key === '***' ? '' : client.openai_api_key || '',
        claude_api_key: client.claude_api_key === '***' ? '' : client.claude_api_key || '',
        ai_model: client.ai_model || aiConfig.model || 'gpt-4o-mini',
        daily_ai_limit: client.daily_ai_limit || aiConfig.daily_limit || 50,
        auto_reply_enabled: client.auto_reply_enabled ?? true,
        working_hours_start: client.working_hours_start || aiConfig.hour_start || 9,
        working_hours_end: client.working_hours_end || aiConfig.hour_end || 18
      });
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Erro ao carregar configuracoes');
    } finally {
      setLoading(false);
    }
  };

  const updateField = <K extends keyof ProfileForm>(field: K, value: ProfileForm[K]) => {
    setForm(current => ({ ...current, [field]: value }));
  };

  const saveSettings = async (event: FormEvent) => {
    event.preventDefault();

    try {
      setSaving(true);
      setError(null);
      const payload: Partial<ProfileForm> = { ...form };
      if (!payload.openai_api_key) delete payload.openai_api_key;
      if (!payload.claude_api_key) delete payload.claude_api_key;

      await apiService.updateProfile(payload);
      setMessage('Configuracoes salvas.');
      await loadSettings();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Erro ao salvar configuracoes');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex min-h-96 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Configuracoes</h1>
          <p className="text-gray-600">Perfil, tokens de IA e comportamento operacional.</p>
        </div>

        {(error || message) && (
          <div className={`rounded-lg border p-4 text-sm ${error ? 'border-red-200 bg-red-50 text-red-700' : 'border-green-200 bg-green-50 text-green-700'}`}>
            {error || message}
          </div>
        )}

        <form onSubmit={saveSettings} className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
          <section className="space-y-5 rounded-lg border border-gray-200 bg-white p-6">
            <div className="flex items-center">
              <UserRound className="mr-3 h-6 w-6 text-blue-600" />
              <h2 className="text-lg font-semibold text-gray-900">Conta</h2>
            </div>

            <label className="block text-sm font-medium text-gray-700">
              Nome
              <input value={form.name} onChange={event => updateField('name', event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
            </label>
            <label className="block text-sm font-medium text-gray-700">
              Empresa
              <input value={form.company_name} onChange={event => updateField('company_name', event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
            </label>
            <label className="block text-sm font-medium text-gray-700">
              Telefone
              <input value={form.phone} onChange={event => updateField('phone', event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
            </label>
            <div className="rounded-lg bg-gray-50 p-4 text-sm text-gray-600">
              <p>Email: <span className="font-medium text-gray-900">{email}</span></p>
              <p>Plano: <span className="font-medium text-gray-900">{plan || 'basic'}</span></p>
            </div>
          </section>

          <section className="space-y-5 rounded-lg border border-gray-200 bg-white p-6">
            <div className="flex items-center">
              <ShieldCheck className="mr-3 h-6 w-6 text-green-600" />
              <h2 className="text-lg font-semibold text-gray-900">IA e Automacao</h2>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block text-sm font-medium text-gray-700">
                OpenAI API key
                <input type="password" value={form.openai_api_key} placeholder="Manter chave atual" onChange={event => updateField('openai_api_key', event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
              <label className="block text-sm font-medium text-gray-700">
                Claude API key
                <input type="password" value={form.claude_api_key} placeholder="Manter chave atual" onChange={event => updateField('claude_api_key', event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block text-sm font-medium text-gray-700">
                Modelo padrao
                <input value={form.ai_model} onChange={event => updateField('ai_model', event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
              <label className="block text-sm font-medium text-gray-700">
                Limite diario de IA
                <input type="number" min="1" max="1000" value={form.daily_ai_limit} onChange={event => updateField('daily_ai_limit', Number(event.target.value))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
              <label className="block text-sm font-medium text-gray-700">
                Inicio atendimento
                <input type="number" min="0" max="23" value={form.working_hours_start} onChange={event => updateField('working_hours_start', Number(event.target.value))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
              <label className="block text-sm font-medium text-gray-700">
                Fim atendimento
                <input type="number" min="0" max="23" value={form.working_hours_end} onChange={event => updateField('working_hours_end', Number(event.target.value))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
            </div>

            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={form.auto_reply_enabled} onChange={event => updateField('auto_reply_enabled', event.target.checked)} className="h-4 w-4" />
              Resposta automatica habilitada
            </label>

            <button disabled={saving} className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50">
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Salvar configuracoes
            </button>
          </section>
        </form>

        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="flex items-center">
            <Settings className="mr-3 h-6 w-6 text-gray-600" />
            <h2 className="text-lg font-semibold text-gray-900">Sincronia do sistema</h2>
          </div>
          <div className="mt-4 grid gap-3 text-sm text-gray-700 md:grid-cols-3">
            <div className="rounded-lg bg-green-50 p-3 text-green-800">Dashboard usa contatos, conversas e sessoes reais.</div>
            <div className="rounded-lg bg-blue-50 p-3 text-blue-800">IA Config salva limites, prompts e integracoes na API.</div>
            <div className="rounded-lg bg-gray-50 p-3 text-gray-800">Configuracoes guarda chaves e perfil sem expor tokens salvos.</div>
          </div>
        </section>
      </div>
    </DashboardLayout>
  );
}
