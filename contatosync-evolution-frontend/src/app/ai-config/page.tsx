'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import DashboardLayout from '@/components/DashboardLayout';
import { apiService } from '@/lib/api';
import { Bot, CheckCircle2, FileText, KeyRound, Loader2, Plus, RefreshCw, Save, Trash2, Upload, Zap } from 'lucide-react';

interface AIConfig {
  enabled: boolean;
  ai_engine?: 'local_multi_agent' | 'dify' | 'hybrid';
  semantic_intent_enabled?: boolean;
  intent_classifier_model?: string;
  intent_confidence_threshold?: number;
  department_agents_enabled?: boolean;
  department_agent_config?: Record<string, DepartmentConfig>;
  queue_settings?: QueueSettings;
  model: string;
  max_tokens: number;
  temperature: number;
  working_hours_enabled: boolean;
  timezone: string;
  working_days: number[];
  hour_start: number;
  hour_end: number;
  daily_limit: number;
  reply_delay_seconds: number;
  monthly_limit: number;
  product_catalog_url: string;
  product_source_urls: string[];
  knowledge_files: KnowledgeFile[];
  product_search_enabled: boolean;
  system_prompt: string;
  greeting_message: string;
  fallback_message: string;
  trigger_keywords: string[];
  blacklist_keywords: string[];
}

interface DepartmentConfig {
  enabled?: boolean;
  name?: string;
  intents?: string[];
  objective?: string;
  semanticDescription?: string;
  activationExamples?: string[];
  systemPrompt?: string;
  model?: string;
  temperature?: number | null;
  allowedSources?: string[];
  allowedIntegrationTypes?: string[];
  allowedIntegrationIds?: string[];
  allowedSourceUrls?: string[];
  allowedKnowledgeFileIds?: string[];
  sourceUseRules?: string[];
  sourcePriority?: string[];
  responseRules?: string[];
  handoffKeywords?: string[];
  maxEvidence?: number;
}

interface QueueSettings {
  max_parallel_per_client?: number;
  max_parallel_per_session?: number;
  idle_collapse_seconds?: number;
}

interface AIOperations {
  engine: string;
  enabled: boolean;
  departmentAgentsEnabled: boolean;
  semanticIntentEnabled?: boolean;
  intentClassifierModel?: string;
  intentConfidenceThreshold?: number;
  departments: Record<string, DepartmentConfig>;
  departmentRouting?: Record<string, {
    id: string;
    label: string;
    intents: string[];
    triggerSummary: string;
  }>;
  queueSettings: QueueSettings;
  aiQueue?: {
    timers?: Array<{ key: string; messages: number; version: number; incomingMessageIds: number }>;
    processingQueues?: Array<{ key: string; running: number; queued: number; settings?: QueueSettings; lastStartedAt?: string; lastFinishedAt?: string }>;
    clientConcurrency?: Array<{ clientId: string; running: number }>;
    metrics?: {
      enqueued: number;
      processed: number;
      failed: number;
      lastError?: string;
      lastProcessedAt?: string | null;
    };
  };
  last24h: {
    success: number;
    errors: number;
    localAgentResponses: number;
    difyResponses: number;
    averageLocalProcessingMs: number;
  };
}

interface AIRouteDiagnosis {
  route: {
    intent: string;
    confidence: number;
    reason: string;
    routerMode: string;
    fallbackIntent?: string;
    inferredDepartmentId?: string;
    semanticDepartmentId?: string;
    configuredDepartmentId?: string;
    routingConflict?: boolean;
    semantic?: {
      intent: string;
      departmentId?: string;
      confidence: number;
      reason: string;
      missingInfo?: string[];
      ambiguity?: string;
      nextBestDepartments?: string[];
    } | null;
    configured?: {
      intent: string;
      departmentId?: string;
      confidence: number;
      reason: string;
      ambiguity?: string;
      nextBestDepartments?: string[];
      scores?: Array<{ id: string; intent: string; score: number }>;
    } | null;
    semanticSkippedReason?: string;
    explicitHumanRequest?: boolean;
    requiredSources?: string[];
  };
  department: {
    id: string;
    name: string;
    objective?: string;
    model?: string;
    temperature?: number | null;
  };
  retrievalPlan: {
    executeSources: string[];
    skippedSources: string[];
    sourcePriority: string[];
    maxEvidence?: number;
    reason?: string;
  };
  sourceBindings: {
    allowedSources: string[];
    allowedIntegrationTypes: string[];
    allowedIntegrationIds: string[];
    allowedSourceUrls: string[];
    allowedKnowledgeFileIds: string[];
    sourceUseRules: string[];
    responseRules: string[];
  };
  safety: {
    willHandoff: boolean;
    willUseSemanticClassifier: boolean;
    needsClarificationLikely: boolean;
  };
}

interface AIRouteDiagnosticsSuite {
  generatedAt: string;
  total: number;
  passed: number;
  failed: number;
  score: number;
  results: Array<{
    id: string;
    label: string;
    message: string;
    passed: boolean;
    checks: Array<{
      id: string;
      passed: boolean;
      expected: unknown;
      actual: unknown;
    }>;
    diagnosis: AIRouteDiagnosis;
  }>;
}

interface Integration {
  id: string;
  integration_type: string;
  integration_name: string;
  api_endpoint: string;
  api_key?: string;
  api_secret?: string;
  config?: IntegrationConfig;
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
  config_fields?: string[];
  default_config?: IntegrationConfig;
}

interface IntegrationConfig {
  auth_type?: string;
  products_path?: string;
  catalog_path?: string;
  orders_path?: string;
  order_status_path?: string;
  tracking_path?: string;
  customers_path?: string;
  stock_path?: string;
  query_param?: string;
  phone_param?: string;
  order_param?: string;
  token_param?: string;
  public_catalog_url?: string;
}

const defaultIntegrationForm = {
  integration_type: 'facilzap',
  integration_name: '',
  api_endpoint: '',
  api_key: '',
  api_secret: '',
  config: {
    auth_type: 'bearer',
    products_path: '/produtos',
    catalog_path: '/catalogos',
    orders_path: '/pedidos',
    order_status_path: '/pedidos/{pedido}',
    tracking_path: '/pedidos/{pedido}/codigo-rastreio',
    customers_path: '/clientes',
    stock_path: '/produtos',
    query_param: 'q',
    phone_param: 'telefone',
    order_param: 'codigo',
    public_catalog_url: ''
  } as IntegrationConfig,
  enabled: true
};

const models = [
  { value: 'gpt-5.2', label: 'GPT-5.2 (mais avancado)' },
  { value: 'gpt-5-mini', label: 'GPT-5 mini (equilibrado)' },
  { value: 'gpt-5-nano', label: 'GPT-5 nano (menor custo)' },
  { value: 'gpt-4.1', label: 'GPT-4.1 (alta qualidade)' },
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini (rapido)' },
  { value: 'gpt-4o', label: 'GPT-4o (multimodal)' },
  { value: 'gpt-4o-mini', label: 'GPT-4o mini (economico)' },
  { value: 'claude-3-haiku', label: 'Claude 3 Haiku' },
  { value: 'claude-3-sonnet', label: 'Claude 3 Sonnet' }
];

function FieldHelp({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-xs leading-5 text-gray-500">{children}</p>;
}

interface KnowledgeFile {
  id: string;
  fileName?: string;
  originalName?: string;
  mimetype?: string;
  size?: number;
  uploadedAt?: string;
}

function listToText(items?: string[]) {
  return (items || []).join(', ');
}

function textToList(value: string) {
  return value.split(/[\n,]+/).map(item => item.trim()).filter(Boolean);
}

function formatSync(value?: string) {
  if (!value) return 'Nunca';
  return new Date(value).toLocaleString('pt-BR');
}

function formatFileSize(value?: number) {
  const size = Number(value || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

const departmentOrder = ['sales', 'support', 'billing', 'scheduling', 'handoff'];
const sourceOptions = ['catalog', 'api', 'rag', 'file', 'site', 'conversation_memory'];

export default function AIConfigPage() {
  const [config, setConfig] = useState<AIConfig | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [operations, setOperations] = useState<AIOperations | null>(null);
  const [integrationTypes, setIntegrationTypes] = useState<IntegrationType[]>([]);
  const [integrationForm, setIntegrationForm] = useState(defaultIntegrationForm);
  const [showIntegrationForm, setShowIntegrationForm] = useState(false);
  const [triggerText, setTriggerText] = useState('');
  const [blacklistText, setBlacklistText] = useState('');
  const [productSourceText, setProductSourceText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [routeTestMessage, setRouteTestMessage] = useState('Quero saber se meu pagamento ja liberou');
  const [routeDiagnosis, setRouteDiagnosis] = useState<AIRouteDiagnosis | null>(null);
  const [routeSuite, setRouteSuite] = useState<AIRouteDiagnosticsSuite | null>(null);
  const [diagnosingRoute, setDiagnosingRoute] = useState(false);
  const [runningRouteSuite, setRunningRouteSuite] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedIntegrationType = useMemo(
    () => integrationTypes.find(item => item.type === integrationForm.integration_type),
    [integrationForm.integration_type, integrationTypes]
  );
  const requiresToken = selectedIntegrationType?.fields.includes('api_key') ?? true;
  const requiresSecret = selectedIntegrationType?.fields.includes('api_secret') ?? false;
  const supportsEndpointConfig = (selectedIntegrationType?.config_fields || []).length > 0;
  const queueTimers = operations?.aiQueue?.timers?.length ?? 0;
  const queuedJobs = operations?.aiQueue?.processingQueues?.reduce((sum, queue) => sum + (queue.queued || 0), 0) ?? 0;
  const runningJobs = operations?.aiQueue?.processingQueues?.reduce((sum, queue) => sum + (queue.running || 0), 0) ?? 0;

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
      apiService.getAIOperations().then(setOperations).catch(() => setOperations(null));
      setConfig(aiConfig);
      setTriggerText(listToText(aiConfig.trigger_keywords));
      setBlacklistText(listToText(aiConfig.blacklist_keywords));
      setProductSourceText((aiConfig.product_source_urls || []).join('\n'));
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
        ai_engine: 'local_multi_agent',
        semantic_intent_enabled: config.semantic_intent_enabled !== false,
        intent_classifier_model: config.intent_classifier_model || config.model || 'gpt-4o-mini',
        intent_confidence_threshold: Number(config.intent_confidence_threshold || 0.68),
        department_agents_enabled: config.department_agents_enabled !== false,
        department_agent_config: config.department_agent_config || operations?.departments || {},
        queue_settings: config.queue_settings || operations?.queueSettings || {},
        product_catalog_url: (config.product_catalog_url || '').trim(),
        product_source_urls: textToList(productSourceText),
        working_days: [1, 2, 3, 4, 5, 6, 7],
        trigger_keywords: textToList(triggerText),
        blacklist_keywords: textToList(blacklistText)
      });
      setConfig(updated);
      setMessage('Configuracao de IA salva.');
      await loadPage();
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
        config: {
          ...integrationForm.config,
          public_catalog_url: (integrationForm.config?.public_catalog_url || '').trim()
        },
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

  const changeIntegrationType = (type: string) => {
    const selectedType = integrationTypes.find(item => item.type === type);
    setIntegrationForm({
      ...integrationForm,
      integration_type: type,
      api_endpoint: type === 'facilzap' && !integrationForm.api_endpoint.trim() ? 'https://api.facilzap.app.br' : integrationForm.api_endpoint,
      config: selectedType?.default_config || {}
    });
  };

  const updateIntegrationConfig = <K extends keyof IntegrationConfig>(field: K, value: IntegrationConfig[K]) => {
    setIntegrationForm(current => ({
      ...current,
      config: {
        ...(current.config || {}),
        [field]: value
      }
    }));
  };

  const uploadKnowledgeFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    try {
      setUploadingFiles(true);
      setError(null);
      await Promise.all(Array.from(files).map(file => apiService.uploadAIKnowledgeFile(file)));
      setMessage('Arquivo(s) adicionados para consulta da IA.');
      await loadPage();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Erro ao enviar arquivo');
    } finally {
      setUploadingFiles(false);
    }
  };

  const deleteKnowledgeFile = async (file: KnowledgeFile) => {
    if (!confirm(`Remover o arquivo "${file.originalName || file.fileName || file.id}"?`)) return;

    try {
      setError(null);
      await apiService.deleteAIKnowledgeFile(file.id);
      setMessage('Arquivo removido.');
      await loadPage();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Erro ao remover arquivo');
    }
  };

  const diagnoseRoute = async () => {
    if (!routeTestMessage.trim()) {
      setError('Informe uma mensagem para simular o roteamento.');
      return;
    }

    try {
      setDiagnosingRoute(true);
      setError(null);
      const result = await apiService.diagnoseAIRoute({ message: routeTestMessage.trim() });
      setRouteDiagnosis(result);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Erro ao diagnosticar roteamento');
    } finally {
      setDiagnosingRoute(false);
    }
  };

  const runRouteDiagnosticsSuite = async () => {
    try {
      setRunningRouteSuite(true);
      setError(null);
      const result = await apiService.runAIRouteDiagnosticsSuite();
      setRouteSuite(result);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Erro ao rodar suite de roteamento');
    } finally {
      setRunningRouteSuite(false);
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
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Motor de IA</h2>
                  <p className="mt-1 text-sm text-gray-500">Defina como a IA deve responder no WhatsApp, quando ela pode atuar e quais limites ela deve respeitar.</p>
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={config.enabled} onChange={event => updateConfigField('enabled', event.target.checked)} className="h-4 w-4" />
                Ativa
              </label>
            </div>

            <div className="grid gap-3 rounded-lg border border-blue-100 bg-blue-50 p-4 md:grid-cols-5">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-blue-700">Motor</p>
                <p className="mt-1 text-sm font-semibold text-blue-950">{operations?.engine || config.ai_engine || 'local_multi_agent'}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-blue-700">Departamentos</p>
                <p className="mt-1 text-sm font-semibold text-blue-950">{config.department_agents_enabled === false ? 'Inativos' : 'Ativos'}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-blue-700">Respostas 24h</p>
                <p className="mt-1 text-sm font-semibold text-blue-950">{operations?.last24h.localAgentResponses ?? 0} local / {operations?.last24h.difyResponses ?? 0} Dify</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-blue-700">Tempo medio</p>
                <p className="mt-1 text-sm font-semibold text-blue-950">{operations?.last24h.averageLocalProcessingMs ?? 0} ms</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-blue-700">Fila agora</p>
                <p className="mt-1 text-sm font-semibold text-blue-950">{runningJobs} rodando / {queuedJobs + queueTimers} aguardando</p>
              </div>
            </div>

            <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-emerald-950">Classificador semantico de intencao</h3>
                  <p className="mt-1 text-sm text-emerald-800">Quando ativo, a IA entende a intencao por contexto e sinonimos antes de cair no fallback por regras.</p>
                </div>
                <label className="flex items-center gap-2 text-sm font-medium text-emerald-900">
                  <input
                    type="checkbox"
                    checked={config.semantic_intent_enabled !== false}
                    onChange={event => updateConfigField('semantic_intent_enabled', event.target.checked)}
                    className="h-4 w-4"
                  />
                  Ativo
                </label>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-[1fr_160px]">
                <label className="text-sm font-medium text-emerald-950">
                  Modelo do classificador
                  <select
                    value={config.intent_classifier_model || config.model || 'gpt-4o-mini'}
                    onChange={event => updateConfigField('intent_classifier_model', event.target.value)}
                    className="mt-1 w-full rounded-lg border border-emerald-200 bg-white px-3 py-2"
                  >
                    {models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
                  </select>
                </label>
                <label className="text-sm font-medium text-emerald-950">
                  Confianca minima
                  <input
                    type="number"
                    min="0.4"
                    max="0.95"
                    step="0.01"
                    value={config.intent_confidence_threshold || 0.68}
                    onChange={event => updateConfigField('intent_confidence_threshold', Number(event.target.value))}
                    className="mt-1 w-full rounded-lg border border-emerald-200 bg-white px-3 py-2"
                  />
                </label>
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">Agentes departamentais e roteamento</h3>
                  <p className="mt-1 text-xs text-gray-500">A IA primeiro classifica a intencao da mensagem e entao escolhe o agente do setor correspondente.</p>
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={config.department_agents_enabled !== false}
                    onChange={event => updateConfigField('department_agents_enabled', event.target.checked)}
                    className="h-4 w-4"
                  />
                  Ativos
                </label>
              </div>

              <div className="mb-4 rounded-lg border border-indigo-100 bg-indigo-50 p-4">
                <h4 className="text-sm font-semibold text-indigo-950">Como o sistema escolhe cada agente</h4>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {departmentOrder.map(id => {
                    const routing = operations?.departmentRouting?.[id];
                    const department = (config.department_agent_config || operations?.departments || {})[id];
                    if (!routing && !department) return null;
                    return (
                      <div key={id} className="rounded-lg border border-indigo-100 bg-white p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-gray-900">{department?.name || routing?.label || id}</p>
                          <span className={`rounded-full px-2 py-1 text-xs ${department?.enabled === false ? 'bg-gray-100 text-gray-600' : 'bg-green-100 text-green-700'}`}>
                            {department?.enabled === false ? 'Inativo' : 'Ativo'}
                          </span>
                        </div>
                        <p className="mt-2 text-sm text-gray-600">{routing?.triggerSummary || 'Roteamento automatico pela intencao da mensagem.'}</p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {(routing?.intents || []).map(intent => (
                            <span key={intent} className="rounded-full bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700">{intent}</span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                  <label className="flex-1 text-sm font-medium text-slate-900">
                    Simular roteamento com a configuracao salva
                    <textarea
                      value={routeTestMessage}
                      onChange={event => setRouteTestMessage(event.target.value)}
                      rows={2}
                      className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-gray-900"
                    />
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row lg:flex-col">
                    <button
                      type="button"
                      onClick={() => void diagnoseRoute()}
                      disabled={diagnosingRoute}
                      className="inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
                    >
                      {diagnosingRoute ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Bot className="mr-2 h-4 w-4" />}
                      Diagnosticar
                    </button>
                    <button
                      type="button"
                      onClick={() => void runRouteDiagnosticsSuite()}
                      disabled={runningRouteSuite}
                      className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-800 hover:bg-slate-100 disabled:opacity-50"
                    >
                      {runningRouteSuite ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                      Rodar suite
                    </button>
                  </div>
                </div>
                {routeDiagnosis && (
                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    <div className="rounded-lg border border-slate-200 bg-white p-3">
                      <p className="text-xs font-medium uppercase text-slate-500">Intencao</p>
                      <p className="mt-1 text-sm font-semibold text-slate-950">{routeDiagnosis.route.intent}</p>
                      <p className="mt-1 text-xs text-slate-600">{Math.round((routeDiagnosis.route.confidence || 0) * 100)}% · {routeDiagnosis.route.routerMode}</p>
                      {routeDiagnosis.route.semantic && (
                        <p className="mt-2 text-xs text-emerald-700">Semantico: {routeDiagnosis.route.semantic.intent} ({Math.round(routeDiagnosis.route.semantic.confidence * 100)}%)</p>
                      )}
                      {routeDiagnosis.route.configured && (
                        <p className="mt-2 text-xs text-blue-700">Config: {routeDiagnosis.route.configured.intent} ({Math.round(routeDiagnosis.route.configured.confidence * 100)}%)</p>
                      )}
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white p-3">
                      <p className="text-xs font-medium uppercase text-slate-500">Agente</p>
                      <p className="mt-1 text-sm font-semibold text-slate-950">{routeDiagnosis.department.name}</p>
                      <p className="mt-1 text-xs text-slate-600">{routeDiagnosis.department.model || 'modelo global'} · temp {routeDiagnosis.department.temperature ?? 'global'}</p>
                      {(routeDiagnosis.route.semanticDepartmentId || routeDiagnosis.route.configuredDepartmentId || routeDiagnosis.route.inferredDepartmentId) && (
                        <p className="mt-1 text-xs text-slate-600">Decisao: {routeDiagnosis.route.semanticDepartmentId || routeDiagnosis.route.configuredDepartmentId || routeDiagnosis.route.inferredDepartmentId}</p>
                      )}
                      {routeDiagnosis.safety.willHandoff && <p className="mt-2 text-xs font-medium text-amber-700">Encaminha para humano</p>}
                      {routeDiagnosis.route.routingConflict && <p className="mt-2 text-xs font-medium text-amber-700">Conflito entre intencao e setor</p>}
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white p-3">
                      <p className="text-xs font-medium uppercase text-slate-500">Fontes usadas</p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {(routeDiagnosis.retrievalPlan.executeSources || []).map(source => (
                          <span key={source} className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">{source}</span>
                        ))}
                      </div>
                      {routeDiagnosis.safety.needsClarificationLikely && <p className="mt-2 text-xs text-amber-700">Pode pedir mais detalhes</p>}
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white p-3 md:col-span-3">
                      <p className="text-xs font-medium uppercase text-slate-500">Por que decidiu assim</p>
                      <p className="mt-1 text-sm text-slate-700">{routeDiagnosis.route.reason}</p>
                      {routeDiagnosis.route.semantic?.ambiguity && (
                        <p className="mt-2 text-xs text-amber-700">Ambiguidade: {routeDiagnosis.route.semantic.ambiguity}</p>
                      )}
                      {routeDiagnosis.route.configured?.ambiguity && (
                        <p className="mt-2 text-xs text-amber-700">Fallback configurado: {routeDiagnosis.route.configured.ambiguity}</p>
                      )}
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <div>
                          <p className="text-xs font-medium uppercase text-slate-500">Vinculos deste agente</p>
                          <p className="mt-1 text-xs text-slate-600">Integracoes: {(routeDiagnosis.sourceBindings.allowedIntegrationTypes || []).join(', ') || 'todas permitidas'}</p>
                          <p className="mt-1 text-xs text-slate-600">URLs: {(routeDiagnosis.sourceBindings.allowedSourceUrls || []).join(', ') || 'todas permitidas'}</p>
                          <p className="mt-1 text-xs text-slate-600">Arquivos: {(routeDiagnosis.sourceBindings.allowedKnowledgeFileIds || []).join(', ') || 'todos permitidos'}</p>
                        </div>
                        <div>
                          <p className="text-xs font-medium uppercase text-slate-500">Regras aplicadas</p>
                          <p className="mt-1 text-xs text-slate-600">{(routeDiagnosis.sourceBindings.responseRules || []).concat(routeDiagnosis.sourceBindings.sourceUseRules || []).slice(0, 4).join(' · ') || 'regras padrao do agente'}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                {routeSuite && (
                  <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-semibold text-slate-950">Suite operacional de roteamento</p>
                        <p className="mt-1 text-xs text-slate-500">{routeSuite.passed}/{routeSuite.total} cenarios aprovados</p>
                      </div>
                      <span className={`rounded-full px-3 py-1 text-sm font-semibold ${routeSuite.failed ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-700'}`}>
                        {routeSuite.score}%
                      </span>
                    </div>
                    <div className="mt-3 grid gap-2">
                      {routeSuite.results.map(result => (
                        <div key={result.id} className={`rounded-lg border p-3 ${result.passed ? 'border-green-100 bg-green-50' : 'border-amber-100 bg-amber-50'}`}>
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <p className="text-sm font-semibold text-slate-950">{result.label}</p>
                              <p className="mt-1 text-xs text-slate-600">{result.message}</p>
                              <p className="mt-1 text-xs text-slate-600">
                                {result.diagnosis.route.intent} {'>'} {result.diagnosis.department.name} {'>'} {(result.diagnosis.retrievalPlan.executeSources || []).join(', ') || 'sem fonte'}
                              </p>
                            </div>
                            <span className={`rounded-full px-2 py-1 text-xs font-medium ${result.passed ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-800'}`}>
                              {result.passed ? 'Aprovado' : 'Revisar'}
                            </span>
                          </div>
                          {!result.passed && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {result.checks.filter(check => !check.passed).map(check => (
                                <span key={check.id} className="rounded-full bg-white px-2 py-1 text-xs text-amber-800">
                                  {check.id}: esperado {Array.isArray(check.expected) ? check.expected.join('/') : String(check.expected)}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <h4 className="mb-3 text-sm font-semibold text-gray-900">Configuracao detalhada dos agentes</h4>
              <div className="grid gap-3 md:grid-cols-2">
                {Object.entries(config.department_agent_config || operations?.departments || {}).map(([id, department]) => (
                  <div key={id} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <input
                        value={department.name || id}
                        onChange={event => updateConfigField('department_agent_config', {
                          ...(config.department_agent_config || operations?.departments || {}),
                          [id]: { ...department, name: event.target.value }
                        })}
                        className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-900"
                        aria-label={`Nome do agente ${id}`}
                      />
                      <input
                        type="checkbox"
                        checked={department.enabled !== false}
                        onChange={event => updateConfigField('department_agent_config', {
                          ...(config.department_agent_config || operations?.departments || {}),
                          [id]: { ...department, enabled: event.target.checked }
                        })}
                        className="h-4 w-4"
                      />
                    </div>
                    <div className="mt-2 rounded-lg border border-gray-200 bg-white p-3">
                      <p className="text-xs font-medium uppercase text-gray-500">Acionado por</p>
                      <p className="mt-1 text-sm text-gray-700">{operations?.departmentRouting?.[id]?.triggerSummary || 'Intencao classificada automaticamente.'}</p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {(operations?.departmentRouting?.[id]?.intents || []).map(intent => (
                          <span key={intent} className="rounded-full bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">{intent}</span>
                        ))}
                      </div>
                    </div>
                    <label className="mt-3 block text-xs font-medium uppercase text-gray-500">
                      Quando este agente deve ser acionado
                      <textarea
                        value={department.semanticDescription || ''}
                        onChange={event => updateConfigField('department_agent_config', {
                          ...(config.department_agent_config || operations?.departments || {}),
                          [id]: { ...department, semanticDescription: event.target.value }
                        })}
                        rows={3}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm normal-case text-gray-900"
                      />
                    </label>
                    <label className="mt-3 block text-xs font-medium uppercase text-gray-500">
                      Exemplos de mensagens deste setor
                      <textarea
                        value={(department.activationExamples || []).join('\n')}
                        onChange={event => updateConfigField('department_agent_config', {
                          ...(config.department_agent_config || operations?.departments || {}),
                          [id]: { ...department, activationExamples: textToList(event.target.value) }
                        })}
                        rows={3}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm normal-case text-gray-900"
                      />
                    </label>
                    <label className="mt-3 block text-xs font-medium uppercase text-gray-500">
                      Prompt system do agente
                      <textarea
                        value={department.systemPrompt || ''}
                        onChange={event => updateConfigField('department_agent_config', {
                          ...(config.department_agent_config || operations?.departments || {}),
                          [id]: { ...department, systemPrompt: event.target.value }
                        })}
                        rows={3}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm normal-case text-gray-900"
                      />
                    </label>
                    <label className="mt-3 block text-xs font-medium uppercase text-gray-500">
                      Objetivo operacional
                      <textarea
                        value={department.objective || ''}
                        onChange={event => updateConfigField('department_agent_config', {
                          ...(config.department_agent_config || operations?.departments || {}),
                          [id]: { ...department, objective: event.target.value }
                        })}
                        rows={2}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm normal-case text-gray-900"
                      />
                    </label>
                    <label className="mt-3 block text-xs font-medium uppercase text-gray-500">
                      Regras de resposta
                      <textarea
                        value={(department.responseRules || []).join('\n')}
                        onChange={event => updateConfigField('department_agent_config', {
                          ...(config.department_agent_config || operations?.departments || {}),
                          [id]: { ...department, responseRules: textToList(event.target.value) }
                        })}
                        rows={3}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm normal-case text-gray-900"
                      />
                    </label>
                    <div className="mt-3 grid gap-2 sm:grid-cols-[110px_1fr]">
                      <label className="text-xs font-medium uppercase text-gray-500">
                        Evidencias
                        <input
                          type="number"
                          min="1"
                          max="10"
                          value={department.maxEvidence || 5}
                          onChange={event => updateConfigField('department_agent_config', {
                            ...(config.department_agent_config || operations?.departments || {}),
                            [id]: { ...department, maxEvidence: Number(event.target.value) }
                          })}
                          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm normal-case text-gray-900"
                        />
                      </label>
                      <label className="text-xs font-medium uppercase text-gray-500">
                        Prioridade de fontes
                        <input
                          value={listToText(department.allowedSources)}
                          onChange={event => updateConfigField('department_agent_config', {
                            ...(config.department_agent_config || operations?.departments || {}),
                            [id]: { ...department, allowedSources: textToList(event.target.value) }
                          })}
                          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm normal-case text-gray-900"
                        />
                        <p className="mt-1 text-[11px] normal-case text-gray-500">{sourceOptions.join(', ')}</p>
                      </label>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <label className="text-xs font-medium uppercase text-gray-500">
                        Tipos de integracao permitidos
                        <input
                          value={listToText(department.allowedIntegrationTypes)}
                          onChange={event => updateConfigField('department_agent_config', {
                            ...(config.department_agent_config || operations?.departments || {}),
                            [id]: { ...department, allowedIntegrationTypes: textToList(event.target.value) }
                          })}
                          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm normal-case text-gray-900"
                          placeholder="facilzap, ecommerce, crm"
                        />
                      </label>
                      <label className="text-xs font-medium uppercase text-gray-500">
                        IDs/nomes de integracoes
                        <input
                          value={listToText(department.allowedIntegrationIds)}
                          onChange={event => updateConfigField('department_agent_config', {
                            ...(config.department_agent_config || operations?.departments || {}),
                            [id]: { ...department, allowedIntegrationIds: textToList(event.target.value) }
                          })}
                          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm normal-case text-gray-900"
                          placeholder="vazio permite todas"
                        />
                      </label>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <label className="text-xs font-medium uppercase text-gray-500">
                        URLs permitidas
                        <textarea
                          value={(department.allowedSourceUrls || []).join('\n')}
                          onChange={event => updateConfigField('department_agent_config', {
                            ...(config.department_agent_config || operations?.departments || {}),
                            [id]: { ...department, allowedSourceUrls: textToList(event.target.value) }
                          })}
                          rows={3}
                          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm normal-case text-gray-900"
                          placeholder="vazio permite todas as URLs configuradas"
                        />
                      </label>
                      <label className="text-xs font-medium uppercase text-gray-500">
                        IDs/nomes de arquivos permitidos
                        <textarea
                          value={(department.allowedKnowledgeFileIds || []).join('\n')}
                          onChange={event => updateConfigField('department_agent_config', {
                            ...(config.department_agent_config || operations?.departments || {}),
                            [id]: { ...department, allowedKnowledgeFileIds: textToList(event.target.value) }
                          })}
                          rows={3}
                          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm normal-case text-gray-900"
                          placeholder="vazio permite todos os arquivos"
                        />
                      </label>
                    </div>
                    <label className="mt-3 block text-xs font-medium uppercase text-gray-500">
                      Quando usar cada fonte
                      <textarea
                        value={(department.sourceUseRules || []).join('\n')}
                        onChange={event => updateConfigField('department_agent_config', {
                          ...(config.department_agent_config || operations?.departments || {}),
                          [id]: { ...department, sourceUseRules: textToList(event.target.value) }
                        })}
                        rows={3}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm normal-case text-gray-900"
                      />
                    </label>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <label className="text-xs font-medium uppercase text-gray-500">
                        Modelo do agente
                        <select
                          value={department.model || ''}
                          onChange={event => updateConfigField('department_agent_config', {
                            ...(config.department_agent_config || operations?.departments || {}),
                            [id]: { ...department, model: event.target.value }
                          })}
                          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm normal-case text-gray-900"
                        >
                          <option value="">Usar modelo global</option>
                          {models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
                        </select>
                      </label>
                      <label className="text-xs font-medium uppercase text-gray-500">
                        Temperatura
                        <input
                          type="number"
                          min="0"
                          max="2"
                          step="0.1"
                          value={department.temperature ?? ''}
                          placeholder="global"
                          onChange={event => updateConfigField('department_agent_config', {
                            ...(config.department_agent_config || operations?.departments || {}),
                            [id]: { ...department, temperature: event.target.value === '' ? null : Number(event.target.value) }
                          })}
                          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm normal-case text-gray-900"
                        />
                      </label>
                    </div>
                    <label className="mt-3 block text-xs font-medium uppercase text-gray-500">
                      Prioridade das fontes permitidas
                      <input
                        value={listToText(department.sourcePriority)}
                        onChange={event => updateConfigField('department_agent_config', {
                          ...(config.department_agent_config || operations?.departments || {}),
                          [id]: { ...department, sourcePriority: textToList(event.target.value) }
                        })}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm normal-case text-gray-900"
                      />
                    </label>
                    <label className="mt-3 block text-xs font-medium uppercase text-gray-500">
                      Palavras de encaminhamento humano
                      <input
                        value={listToText(department.handoffKeywords)}
                        onChange={event => updateConfigField('department_agent_config', {
                          ...(config.department_agent_config || operations?.departments || {}),
                          [id]: { ...department, handoffKeywords: textToList(event.target.value) }
                        })}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm normal-case text-gray-900"
                      />
                    </label>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="text-sm font-medium text-gray-700">
                Modelo
                <select value={config.model} onChange={event => updateConfigField('model', event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2">
                  {models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
                </select>
                <FieldHelp>Escolha o modelo que vai gerar as respostas. Para OpenAI, GPT-5 mini e GPT-5 nano sao boas opcoes iniciais por custo e velocidade; GPT-5.2 e GPT-4.1 servem para respostas mais completas. O modelo precisa ser compativel com a chave cadastrada em Configuracoes.</FieldHelp>
              </label>
              <label className="text-sm font-medium text-gray-700">
                Temperatura
                <input type="number" min="0" max="2" step="0.1" value={config.temperature} onChange={event => updateConfigField('temperature', Number(event.target.value))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
                <FieldHelp>Controla a criatividade. Use 0.2 a 0.5 para atendimento mais direto e previsivel; use 0.7 ou mais para respostas mais flexiveis. Para vendas e suporte, normalmente 0.4 a 0.7 funciona melhor.</FieldHelp>
              </label>
              <label className="text-sm font-medium text-gray-700">
                Max tokens
                <input type="number" min="1" max="4000" value={config.max_tokens} onChange={event => updateConfigField('max_tokens', Number(event.target.value))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
                <FieldHelp>Limite maximo de tamanho da resposta da IA. Quanto maior, mais longa e mais cara pode ficar a resposta. Para WhatsApp, use algo entre 300 e 800; aumente apenas se a IA precisar explicar muitos detalhes.</FieldHelp>
              </label>
              <label className="text-sm font-medium text-gray-700">
                Limite diario
                <input type="number" min="1" max="1000" value={config.daily_limit} onChange={event => updateConfigField('daily_limit', Number(event.target.value))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
                <FieldHelp>Quantidade maxima de respostas de IA por dia. Use para controlar custo e evitar uso indevido. Comece com um limite baixo, como 50 ou 100, e aumente depois de acompanhar o volume real no dashboard.</FieldHelp>
              </label>
              <label className="text-sm font-medium text-gray-700">
                Delay para responder
                <input type="number" min="1" max="60" value={config.reply_delay_seconds || 8} onChange={event => updateConfigField('reply_delay_seconds', Number(event.target.value))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
                <FieldHelp>Tempo que a IA espera antes de responder. Se o cliente mandar duas ou mais mensagens seguidas nesse intervalo, o sistema junta tudo e gera uma unica resposta. Use 6 a 12 segundos para atendimento natural.</FieldHelp>
              </label>
            </div>

            <div className="rounded-lg border border-gray-200 p-4">
              <h3 className="text-sm font-semibold text-gray-900">Fila e worker da IA</h3>
              <div className="mt-3 grid gap-4 md:grid-cols-3">
                <label className="text-sm font-medium text-gray-700">
                  Paralelo por cliente
                  <input
                    type="number"
                    min="1"
                    max="5"
                    value={config.queue_settings?.max_parallel_per_client || 1}
                    onChange={event => updateConfigField('queue_settings', {
                      ...(config.queue_settings || {}),
                      max_parallel_per_client: Number(event.target.value)
                    })}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                  />
                  <FieldHelp>Limite global de respostas de IA processadas ao mesmo tempo para a mesma conta.</FieldHelp>
                </label>
                <label className="text-sm font-medium text-gray-700">
                  Paralelo por sessao
                  <input
                    type="number"
                    min="1"
                    max="3"
                    value={config.queue_settings?.max_parallel_per_session || 1}
                    onChange={event => updateConfigField('queue_settings', {
                      ...(config.queue_settings || {}),
                      max_parallel_per_session: Number(event.target.value)
                    })}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                  />
                  <FieldHelp>Limite de respostas simultaneas dentro da mesma sessao WhatsApp.</FieldHelp>
                </label>
                <label className="text-sm font-medium text-gray-700">
                  Janela de agrupamento
                  <input
                    type="number"
                    min="1"
                    max="60"
                    value={config.queue_settings?.idle_collapse_seconds || config.reply_delay_seconds || 8}
                    onChange={event => updateConfigField('queue_settings', {
                      ...(config.queue_settings || {}),
                      idle_collapse_seconds: Number(event.target.value)
                    })}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                  />
                  <FieldHelp>Tempo para juntar mensagens seguidas do mesmo contato antes de gerar a resposta.</FieldHelp>
                </label>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-4">
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <p className="text-xs font-medium uppercase text-gray-500">Timers</p>
                  <p className="mt-1 text-lg font-semibold text-gray-900">{queueTimers}</p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <p className="text-xs font-medium uppercase text-gray-500">Em execucao</p>
                  <p className="mt-1 text-lg font-semibold text-gray-900">{runningJobs}</p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <p className="text-xs font-medium uppercase text-gray-500">Aguardando</p>
                  <p className="mt-1 text-lg font-semibold text-gray-900">{queuedJobs}</p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <p className="text-xs font-medium uppercase text-gray-500">Falhas</p>
                  <p className="mt-1 text-lg font-semibold text-gray-900">{operations?.aiQueue?.metrics?.failed ?? 0}</p>
                </div>
              </div>
              {operations?.aiQueue?.metrics?.lastError && (
                <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{operations.aiQueue.metrics.lastError}</p>
              )}
            </div>

            <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-start">
              <label className="text-sm font-medium text-gray-700">
                Link do catalogo ou loja virtual
                <input type="url" placeholder="https://sualoja.com.br/produtos" value={config.product_catalog_url || ''} onChange={event => updateConfigField('product_catalog_url', event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
                <FieldHelp>Cole aqui a pagina publica da loja, catalogo ou produto que a IA deve consultar para buscar informacoes e fotos. Quando houver integracoes ativas, a IA consulta as APIs primeiro e depois este link. Essa busca funciona independente do modelo selecionado.</FieldHelp>
              </label>
              <label className="mt-7 flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={config.product_search_enabled !== false} onChange={event => updateConfigField('product_search_enabled', event.target.checked)} className="h-4 w-4" />
                Buscar produtos
              </label>
            </div>

            <label className="block text-sm font-medium text-gray-700">
              Links adicionais para consulta
              <textarea placeholder={'https://sualoja.com.br/vestidos\nhttps://sualoja.com.br/conjuntos\nhttps://catalogo.exemplo.com.br'} value={productSourceText} onChange={event => setProductSourceText(event.target.value)} rows={4} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              <FieldHelp>Coloque um link por linha. A IA consulta integracoes ativas, o link principal e todos estes links antes de responder sobre produtos, fotos, precos ou disponibilidade.</FieldHelp>
            </label>

            <div className="rounded-lg border border-gray-200 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start">
                  <FileText className="mr-3 mt-1 h-5 w-5 text-blue-600" />
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900">Arquivos para a IA consultar</h3>
                    <FieldHelp>Envie tabelas, textos, JSON, CSV, HTML, XML, PDF e outros documentos. Arquivos de texto ficam legiveis no contexto da IA; PDFs tambem podem ser analisados pelo modelo OpenAI.</FieldHelp>
                  </div>
                </div>
                <label className="inline-flex cursor-pointer items-center justify-center rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  {uploadingFiles ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                  Enviar arquivos
                  <input type="file" multiple disabled={uploadingFiles} onChange={event => void uploadKnowledgeFiles(event.target.files)} className="hidden" accept=".txt,.csv,.json,.md,.markdown,.html,.htm,.xml,.log,.pdf,.doc,.docx,.xls,.xlsx,image/*" />
                </label>
              </div>

              <div className="mt-4 space-y-2">
                {(config.knowledge_files || []).length === 0 ? (
                  <div className="rounded-lg border border-dashed border-gray-300 p-4 text-center text-sm text-gray-500">Nenhum arquivo cadastrado.</div>
                ) : config.knowledge_files.map(file => (
                  <div key={file.id} className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-gray-900">{file.originalName || file.fileName || 'Arquivo'}</p>
                      <p className="text-xs text-gray-500">{file.mimetype || 'tipo nao informado'} · {formatFileSize(file.size)}{file.uploadedAt ? ` · ${formatSync(file.uploadedAt)}` : ''}</p>
                    </div>
                    <button type="button" onClick={() => void deleteKnowledgeFile(file)} className="inline-flex items-center rounded-lg border border-red-200 px-2 py-1 text-sm text-red-600 hover:bg-red-50">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <label className="block text-sm font-medium text-gray-700">
              Prompt do sistema
              <textarea value={config.system_prompt} onChange={event => updateConfigField('system_prompt', event.target.value)} rows={5} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
              <FieldHelp>Explique para a IA quem ela e, como deve atender e quais regras deve seguir. Inclua tom de voz, horario, politicas, limites, quando chamar humano e informacoes do negocio. Exemplo: "Voce atende clientes da loja X, responde em portugues, nao inventa preco e chama um atendente quando nao souber".</FieldHelp>
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="text-sm font-medium text-gray-700">
                Saudacao
                <textarea value={config.greeting_message} onChange={event => updateConfigField('greeting_message', event.target.value)} rows={3} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
                <FieldHelp>Mensagem usada quando a IA inicia ou reconhece um atendimento. Preencha com uma frase curta e natural, como "Ola! Sou o assistente virtual. Como posso ajudar?".</FieldHelp>
              </label>
              <label className="text-sm font-medium text-gray-700">
                Mensagem fallback
                <textarea value={config.fallback_message} onChange={event => updateConfigField('fallback_message', event.target.value)} rows={3} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
                <FieldHelp>Mensagem usada quando a IA nao consegue responder com seguranca. Use para encaminhar para atendimento humano, por exemplo: "Nao consegui confirmar essa informacao. Vou chamar um atendente para ajudar".</FieldHelp>
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="text-sm font-medium text-gray-700">
                Palavras de gatilho
                <input value={triggerText} onChange={event => setTriggerText(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
                <FieldHelp>Palavras que ajudam a IA a identificar quando deve responder. Separe por virgulas. Exemplo: preco, entrega, produto, horario, pedido. Use termos que seus clientes costumam mandar no WhatsApp.</FieldHelp>
              </label>
              <label className="text-sm font-medium text-gray-700">
                Palavras bloqueadas
                <input value={blacklistText} onChange={event => setBlacklistText(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
                <FieldHelp>Palavras que impedem resposta automatica e indicam que deve chamar humano. Separe por virgulas. Exemplo: urgente, reclamacao, cancelamento, juridico, emergencia.</FieldHelp>
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
                <FieldHelp>Hora em que a IA pode comecar a responder. Use formato de 0 a 23. Exemplo: 9 para 09:00.</FieldHelp>
              </label>
              <label className="text-sm font-medium text-gray-700">
                Fim
                <input type="number" min="0" max="23" value={config.hour_end} onChange={event => updateConfigField('hour_end', Number(event.target.value))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
                <FieldHelp>Hora em que a IA deve parar de responder automaticamente. Use formato de 0 a 23. Exemplo: 18 para 18:00.</FieldHelp>
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
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Integracoes rapidas</h2>
                  <p className="mt-1 text-sm text-gray-500">Conecte APIs externas para a IA consultar informacoes reais, como catalogo, pedidos, clientes, CRM ou automacoes.</p>
                </div>
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
                  A IA consulta APIs de integracoes ativas antes do link do catalogo.
                </div>
                <div className="space-y-3">
                  <select value={integrationForm.integration_type} onChange={event => changeIntegrationType(event.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2">
                    {integrationTypes.map(type => <option key={type.type} value={type.type}>{type.name}</option>)}
                  </select>
                  <FieldHelp>Escolha o tipo conforme o sistema que sera conectado. FacilZap, CRM, e-commerce e email normalmente pedem token. Webhook e usado quando outro sistema recebe eventos do ContatoSync.</FieldHelp>
                  <div>
                    <input required placeholder="Nome da integracao" value={integrationForm.integration_name} onChange={event => setIntegrationForm({ ...integrationForm, integration_name: event.target.value })} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                    <FieldHelp>Use um nome facil de reconhecer, como "FacilZap loja principal" ou "CRM vendas". Esse nome aparece na lista e ajuda a saber qual conexao esta ativa.</FieldHelp>
                  </div>
                  <div>
                    <input required type="url" placeholder="https://api.seudominio.com/endpoint" value={integrationForm.api_endpoint} onChange={event => setIntegrationForm({ ...integrationForm, api_endpoint: event.target.value })} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                    <FieldHelp>Cole a URL base ou endpoint da API do sistema externo. Voce encontra isso na documentacao da plataforma, geralmente em areas chamadas API, Developers, Webhooks ou Integracoes. Deve comecar com https:// ou http://.</FieldHelp>
                  </div>
                  {requiresToken && (
                    <div>
                      <input required type="password" placeholder="Token ou API key" value={integrationForm.api_key} onChange={event => setIntegrationForm({ ...integrationForm, api_key: event.target.value })} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                      <FieldHelp>Cole o token de acesso gerado no sistema externo. Normalmente fica em Configuracoes, API, Desenvolvedores, Tokens ou Chaves de API. Esse token autoriza o ContatoSync a consultar ou enviar dados para essa API.</FieldHelp>
                    </div>
                  )}
                  {requiresSecret && (
                    <div>
                      <input type="password" placeholder="API secret" value={integrationForm.api_secret} onChange={event => setIntegrationForm({ ...integrationForm, api_secret: event.target.value })} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                      <FieldHelp>Preencha somente se a plataforma fornecer uma segunda chave chamada secret, client secret ou assinatura. Ela costuma ficar na mesma tela onde o token/API key foi criado.</FieldHelp>
                    </div>
                  )}
                  {supportsEndpointConfig && (
                    <div className="space-y-3 rounded-lg border border-orange-200 bg-white p-3">
                      <div>
                        <select value={integrationForm.config?.auth_type || 'bearer'} onChange={event => updateIntegrationConfig('auth_type', event.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2">
                          <option value="bearer">Bearer token</option>
                          <option value="x-api-key">x-api-key</option>
                          <option value="query">Token na URL</option>
                        </select>
                        <FieldHelp>Como a API espera receber o token. FacilZap normalmente usa token de API; se a documentacao pedir outro formato, ajuste aqui.</FieldHelp>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <input placeholder="/produtos" value={integrationForm.config?.products_path || ''} onChange={event => updateIntegrationConfig('products_path', event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2" />
                        <input placeholder="/catalogos" value={integrationForm.config?.catalog_path || ''} onChange={event => updateIntegrationConfig('catalog_path', event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2" />
                        <input placeholder="/pedidos" value={integrationForm.config?.orders_path || ''} onChange={event => updateIntegrationConfig('orders_path', event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2" />
                        <input placeholder="/pedidos/{pedido}" value={integrationForm.config?.order_status_path || ''} onChange={event => updateIntegrationConfig('order_status_path', event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2" />
                        <input placeholder="/pedidos/{pedido}/codigo-rastreio" value={integrationForm.config?.tracking_path || ''} onChange={event => updateIntegrationConfig('tracking_path', event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2" />
                        <input placeholder="/clientes" value={integrationForm.config?.customers_path || ''} onChange={event => updateIntegrationConfig('customers_path', event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2" />
                        <input placeholder="/produtos" value={integrationForm.config?.stock_path || ''} onChange={event => updateIntegrationConfig('stock_path', event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2" />
                        <input placeholder="telefone" value={integrationForm.config?.phone_param || ''} onChange={event => updateIntegrationConfig('phone_param', event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2" />
                        <input placeholder="pedido" value={integrationForm.config?.order_param || ''} onChange={event => updateIntegrationConfig('order_param', event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2" />
                        <input placeholder="q" value={integrationForm.config?.query_param || ''} onChange={event => updateIntegrationConfig('query_param', event.target.value)} className="rounded-lg border border-gray-300 px-3 py-2" />
                      </div>
                      <FieldHelp>Use caminhos relativos à URL base. Em endpoints de pedido/rastreio, use {'{pedido}'} onde o numero do pedido deve entrar. Para APIs externas, deixe vazio o que a plataforma nao oferecer.</FieldHelp>
                      {integrationForm.integration_type === 'facilzap' && (
                        <div>
                          <label className="block text-sm font-medium text-gray-700">
                            URL pública do catálogo
                            <input
                              type="url"
                              placeholder="https://sualoja.com.br/c/atacado/NUMERO"
                              value={integrationForm.config?.public_catalog_url || ''}
                              onChange={event => updateIntegrationConfig('public_catalog_url', event.target.value)}
                              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
                            />
                          </label>
                          <FieldHelp>Usado no botão &ldquo;Ver produto&rdquo; dos cards do WhatsApp. Exemplo: https://cabiderosakids.com.br/c/atacado/11991280903. Deixe vazio para não exibir botão.</FieldHelp>
                        </div>
                      )}
                    </div>
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
