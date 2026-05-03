'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import { apiService } from '@/lib/api';
import { Bot, CheckCircle2, KeyRound, Loader2, Plus, RefreshCw, Save, Trash2, Zap } from 'lucide-react';

interface AIConfig {
  enabled: boolean;
  model: string;
  max_tokens: number;
  temperature: number;
  working_hours_enabled: boolean;
  timezone: string;
  working_days: number[];
  hour_start: number;
  hour_end: number;
  daily_limit: number;
  monthly_limit: number;
  system_prompt: string;
  greeting_message: string;
  fallback_message: string;
  trigger_keywords: string[];
  blacklist_keywords: string[];
}

interface Integration {
  id: string;
  integration_type: string;
  integration_name: string;
  api_endpoint: string;
  api_key?: string;
  api_secret?: string;
  enabled: boolean;
  status?: string;
  last_sync?: string;
  last_error?: string;
}

interface IntegrationType {
  type: string;
  name: string;
  description: string;
  fields: string[];
}

const defaultIntegrationForm = {
  integration_type: 'facilzap',
  integration_name: '',
  api_endpoint: '',
  api_key: '',
  api_secret: '',
  enabled: true
};

const models = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'claude-3-haiku', 'claude-3-sonnet'];

function listToText(items?: string[]) {
  return (items || []).join(', ');
}

function textToList(value: string) {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function formatSync(value?: string) {
  if (!value) return 'Nunca';
  return new Date(value).toLocaleString('pt-BR');
}

export default function AIConfigPage() {
  const [config, setConfig] = useState<AIConfig | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [integrationTypes, setIntegrationTypes] = useState<IntegrationType[]>([]);
  const [integrationForm, setIntegrationForm] = useState(defaultIntegrationForm);
  const [showIntegrationForm, setShowIntegrationForm] = useState(false);
  const [triggerText, setTriggerText] = useState('');
  const [blacklistText, setBlacklistText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedIntegrationType = useMemo(
    () => integrationTypes.find(item => item.type === integrationForm.integration_type),
    [integrationForm.integration_type, integrationTypes]
  );
  const requiresToken = selectedIntegrationType?.fields.includes('api_key') ?? true;
  const requiresSecret = selectedIntegrationType?.fields.includes('api_secret') ?? false;

  useEffect(() => {
    void loadPage();
  }, []);

  const loadPage = async () => {
    try {
      setLoading(true);
      setError(null);
      const [aiConfig, integrationList, typeList] = await Promise.all([
        apiService.getAIConfig(),
        apiService.getIntegrations(),
        apiService.getIntegrationTypes()
      ]);
      setConfig(aiConfig);
      setTriggerText(listToText(aiConfig.trigger_keywords));
      setBlacklistText(listToText(aiConfig.blacklist_keywords));
      setIntegrations(integrationList || []);
      setIntegrationTypes(typeList || []);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Erro ao carregar IA Config');
    } finally {
      setLoading(false);
    }
  };

  const updateConfigField = <K extends keyof AIConfig>(field: K, value: AIConfig[K]) => {
    setConfig(current => current ? { ...current, [field]: value } : current);
  };

  const saveAIConfig = async (event: FormEvent) => {
    event.preventDefault();
    if (!config) return;

    try {
      setSaving(true);
      setError(null);
      const updated = await apiService.updateAIConfig({
        ...config,
        trigger_keywords: textToList(triggerText),
        blacklist_keywords: textToList(blacklistText)
      });
      setConfig(updated);
      setMessage('Configuracao de IA salva.');
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Erro ao salvar configuracao');
    } finally {
      setSaving(false);
    }
  };

  const createIntegration = async () => {
    if (requiresToken && !integrationForm.api_key.trim()) {
      setError('Informe o token/API key da integracao.');
      return;
    }

    try {
      setSaving(true);
      setError(null);
      await apiService.createIntegration({
        integration_type: integrationForm.integration_type,
        integration_name: integrationForm.integration_name.trim(),
        api_endpoint: integrationForm.api_endpoint.trim(),
        api_key: integrationForm.api_key.trim(),
        api_secret: integrationForm.api_secret.trim(),
        enabled: integrationForm.enabled
      });
      setIntegrationForm(defaultIntegrationForm);
      setShowIntegrationForm(false);
      setMessage('Integracao criada.');
      await loadPage();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Erro ao criar integracao');
    } finally {
      setSaving(false);
    }
  };

  const testIntegration = async (id: string) => {
    try {
      setTestingId(id);
      setError(null);
      const result = await apiService.testIntegration(id);
      setMessage(result?.message || 'Integracao testada.');
      await loadPage();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Erro no teste de integracao');
      await loadPage();
    } finally {
      setTestingId(null);
    }
  };

  const deleteIntegration = async (integration: Integration) => {
    if (!confirm(`Excluir a integracao "${integration.integration_name}"?`)) return;

    try {
      setError(null);
      await apiService.deleteIntegration(integration.id);
      setMessage('Integracao removida.');
      await loadPage();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Erro ao remover integracao');
    }
  };

  if (loading || !config) {
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
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">IA Config</h1>
            <p className="text-gray-600">Automacao, limites e fontes externas usadas pela IA.</p>
          </div>
          <button onClick={loadPage} className="inline-flex items-center rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
            <RefreshCw className="mr-2 h-4 w-4" />
            Atualizar
          </button>
        </div>

        {(error || message) && (
          <div className={`rounded-lg border p-4 text-sm ${error ? 'border-red-200 bg-red-50 text-red-700' : 'border-green-200 bg-green-50 text-green-700'}`}>
            {error || message}
          </div>
        )}

        <form onSubmit={saveAIConfig} className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <section className="space-y-5 rounded-lg border border-gray-200 bg-white p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <Bot className="mr-3 h-6 w-6 text-blue-600" />
                <h2 className="text-lg font-semibold text-gray-900">Motor de IA</h2>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={config.enabled} onChange={event => updateConfigField('enabled', event.target.checked)} className="h-4 w-4" />
                Ativa
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="text-sm font-medium text-gray-700">
                Modelo
                <select value={config.model} onChange={event => updateConfigField('model', event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2">
                  {models.map(model => <option key={model} value={model}>{model}</option>)}
                </select>
              </label>
              <label className="text-sm font-medium text-gray-700">
                Temperatura
                <input type="number" min="0" max="2" step="0.1" value={config.temperature} onChange={event => updateConfigField('temperature', Number(event.target.value))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
              <label className="text-sm font-medium text-gray-700">
                Max tokens
                <input type="number" min="1" max="4000" value={config.max_tokens} onChange={event => updateConfigField('max_tokens', Number(event.target.value))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
              <label className="text-sm font-medium text-gray-700">
                Limite diario
                <input type="number" min="1" max="1000" value={config.daily_limit} onChange={event => updateConfigField('daily_limit', Number(event.target.value))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
            </div>

            <label className="block text-sm font-medium text-gray-700">
              Prompt do sistema
              <textarea value={config.system_prompt} onChange={event => updateConfigField('system_prompt', event.target.value)} rows={5} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="text-sm font-medium text-gray-700">
                Saudacao
                <textarea value={config.greeting_message} onChange={event => updateConfigField('greeting_message', event.target.value)} rows={3} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
              <label className="text-sm font-medium text-gray-700">
                Mensagem fallback
                <textarea value={config.fallback_message} onChange={event => updateConfigField('fallback_message', event.target.value)} rows={3} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="text-sm font-medium text-gray-700">
                Palavras de gatilho
                <input value={triggerText} onChange={event => setTriggerText(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
              <label className="text-sm font-medium text-gray-700">
                Palavras bloqueadas
                <input value={blacklistText} onChange={event => setBlacklistText(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={config.working_hours_enabled} onChange={event => updateConfigField('working_hours_enabled', event.target.checked)} className="h-4 w-4" />
                Usar horario
              </label>
              <label className="text-sm font-medium text-gray-700">
                Inicio
                <input type="number" min="0" max="23" value={config.hour_start} onChange={event => updateConfigField('hour_start', Number(event.target.value))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
              <label className="text-sm font-medium text-gray-700">
                Fim
                <input type="number" min="0" max="23" value={config.hour_end} onChange={event => updateConfigField('hour_end', Number(event.target.value))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              </label>
            </div>

            <button disabled={saving} className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50">
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Salvar IA
            </button>
          </section>

          <section className="space-y-5 rounded-lg border border-gray-200 bg-white p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <Zap className="mr-3 h-6 w-6 text-orange-600" />
                <h2 className="text-lg font-semibold text-gray-900">Integracoes rapidas</h2>
              </div>
              <button type="button" onClick={() => setShowIntegrationForm(value => !value)} className="inline-flex items-center rounded-lg bg-orange-600 px-3 py-2 text-sm text-white hover:bg-orange-700">
                <Plus className="mr-2 h-4 w-4" />
                Adicionar
              </button>
            </div>

            {showIntegrationForm && (
              <div className="rounded-lg border border-orange-200 bg-orange-50 p-4">
                <div className="mb-3 flex items-center text-sm font-medium text-orange-900">
                  <KeyRound className="mr-2 h-4 w-4" />
                  URL e token sao obrigatorios para conexoes via API.
                </div>
                <div className="space-y-3">
                  <select value={integrationForm.integration_type} onChange={event => setIntegrationForm({ ...integrationForm, integration_type: event.target.value })} className="w-full rounded-lg border border-gray-300 px-3 py-2">
                    {integrationTypes.map(type => <option key={type.type} value={type.type}>{type.name}</option>)}
                  </select>
                  <input required placeholder="Nome da integracao" value={integrationForm.integration_name} onChange={event => setIntegrationForm({ ...integrationForm, integration_name: event.target.value })} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                  <input required type="url" placeholder="https://api.seudominio.com/endpoint" value={integrationForm.api_endpoint} onChange={event => setIntegrationForm({ ...integrationForm, api_endpoint: event.target.value })} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                  {requiresToken && (
                    <input required type="password" placeholder="Token ou API key" value={integrationForm.api_key} onChange={event => setIntegrationForm({ ...integrationForm, api_key: event.target.value })} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                  )}
                  {requiresSecret && (
                    <input type="password" placeholder="API secret" value={integrationForm.api_secret} onChange={event => setIntegrationForm({ ...integrationForm, api_secret: event.target.value })} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                  )}
                  <button type="button" onClick={() => void createIntegration()} disabled={saving} className="inline-flex items-center rounded-lg bg-orange-600 px-4 py-2 text-sm text-white hover:bg-orange-700 disabled:opacity-50">
                    {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    Salvar integracao
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-3">
              {integrations.length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">Nenhuma integracao cadastrada.</div>
              ) : integrations.map(integration => (
                <div key={integration.id} className="rounded-lg border border-gray-200 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-medium text-gray-900">{integration.integration_name}</h3>
                      <p className="truncate text-sm text-gray-500">{integration.api_endpoint}</p>
                      <p className="mt-1 text-xs text-gray-500">Ultima sync: {formatSync(integration.last_sync)}</p>
                      {integration.last_error && <p className="mt-1 text-xs text-red-600">{integration.last_error}</p>}
                    </div>
                    <span className={`rounded-full px-2 py-1 text-xs ${integration.status === 'error' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                      {integration.status || 'active'}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => testIntegration(integration.id)} disabled={testingId === integration.id} className="inline-flex items-center rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                      {testingId === integration.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                      Testar
                    </button>
                    <button type="button" onClick={() => deleteIntegration(integration)} className="inline-flex items-center rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50">
                      <Trash2 className="mr-2 h-4 w-4" />
                      Remover
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </form>
      </div>
    </DashboardLayout>
  );
}
