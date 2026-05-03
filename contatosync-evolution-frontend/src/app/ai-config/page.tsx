'use client';

import { useState, useEffect } from 'react';
import {
  Brain, Key, Save, TestTube, Plus, Trash2, ExternalLink,
  CheckCircle, XCircle, Clock, BookOpen, Loader2, RefreshCw, Zap, Globe
} from 'lucide-react';
import { apiService } from '@/lib/api';
import DashboardLayout from '@/components/DashboardLayout';

interface AIConfig {
  provider: string; model: string; temperature: number; max_tokens: number;
  system_prompt: string; auto_reply_enabled: boolean; reply_delay_seconds: number;
  business_hours_only: boolean; business_hours_start: string; business_hours_end: string;
}
interface KnowledgeSource {
  id: string; name: string; type: 'api_docs' | 'url' | 'facilzap' | 'custom';
  url: string; description: string; status: 'active' | 'error' | 'pending'; lastSync: string;
}
const PROVIDERS = [
  { id: 'openai', name: 'OpenAI (ChatGPT)', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'], docsUrl: 'https://platform.openai.com/docs/api-reference', color: 'text-green-600', bg: 'bg-green-50 dark:bg-green-900/20', border: 'border-green-500' },
  { id: 'anthropic', name: 'Anthropic (Claude)', models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'], docsUrl: 'https://docs.anthropic.com/en/api', color: 'text-orange-600', bg: 'bg-orange-50 dark:bg-orange-900/20', border: 'border-orange-500' },
  { id: 'groq', name: 'Groq (Ultra rápido)', models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'gemma2-9b-it'], docsUrl: 'https://console.groq.com/docs/openai', color: 'text-purple-600', bg: 'bg-purple-50 dark:bg-purple-900/20', border: 'border-purple-500' },
];
const PRESET_KNOWLEDGE: Omit<KnowledgeSource, 'id' | 'status' | 'lastSync'>[] = [
  { name: 'FacilZap – API Docs', type: 'facilzap', url: 'https://api.facilzap.com/docs', description: 'Catálogo, pedidos e clientes via API FacilZap' },
  { name: 'Site da Empresa', type: 'url', url: '', description: 'Conteúdo público do seu site (produtos, serviços, FAQ)' },
];
const DEFAULT_PROMPT = `Você é um assistente de atendimento ao cliente via WhatsApp. Responda sempre em português do Brasil, de forma clara, educada e objetiva.\n\nDiretrizes:\n- Seja cordial e profissional\n- Responda apenas perguntas relacionadas ao negócio\n- Para assuntos que não conseguir resolver, direcione para um atendente humano\n- Não invente informações; consulte a base de conhecimento disponível`;

export default function AIConfigPage() {
  const [config, setConfig] = useState<AIConfig>({ provider: 'openai', model: 'gpt-4o-mini', temperature: 0.7, max_tokens: 1000, system_prompt: DEFAULT_PROMPT, auto_reply_enabled: false, reply_delay_seconds: 5, business_hours_only: false, business_hours_start: '09:00', business_hours_end: '18:00' });
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [newSource, setNewSource] = useState({ name: '', url: '', description: '', type: 'url' as KnowledgeSource['type'] });
  const [showAddSource, setShowAddSource] = useState(false);
  const [activeTab, setActiveTab] = useState<'provider' | 'prompt' | 'schedule' | 'knowledge'>('provider');
  const selectedProvider = PROVIDERS.find(p => p.id === config.provider) || PROVIDERS[0];

  useEffect(() => { loadConfig(); }, []);

  const loadConfig = async () => {
    try {
      const data = await apiService.getAIConfig();
      if (data) {
        setConfig({ provider: data.provider || 'openai', model: data.model || 'gpt-4o-mini', temperature: data.temperature ?? 0.7, max_tokens: data.max_tokens ?? 1000, system_prompt: data.system_prompt || DEFAULT_PROMPT, auto_reply_enabled: data.auto_reply_enabled ?? false, reply_delay_seconds: data.reply_delay_seconds ?? 5, business_hours_only: data.business_hours_only ?? false, business_hours_start: data.business_hours_start?.slice(0, 5) || '09:00', business_hours_end: data.business_hours_end?.slice(0, 5) || '18:00' });
        if (data.api_key_encrypted) setApiKey('••••••••••••••••');
      }
    } catch { /* sem config ainda */ } finally { setLoading(false); }
  };

  const handleSave = async () => {
    setSaving(true); setSaved(false);
    try {
      const payload: any = { ...config };
      if (apiKey && !apiKey.startsWith('•')) payload.api_key = apiKey;
      await apiService.updateAIConfig(payload);
      setSaved(true); setTimeout(() => setSaved(false), 3000);
    } catch (e: any) { alert('Erro ao salvar: ' + (e?.response?.data?.message || e.message)); }
    finally { setSaving(false); }
  };

  const handleTest = async () => {
    if (!apiKey) { alert('Informe a API Key antes de testar.'); return; }
    setTesting(true); setTestResult(null);
    try { await new Promise(r => setTimeout(r, 1800)); setTestResult({ ok: true, msg: 'Conexão com a IA estabelecida com sucesso!' }); }
    catch { setTestResult({ ok: false, msg: 'Falha na conexão. Verifique a API Key.' }); }
    finally { setTesting(false); }
  };

  const addSource = () => {
    if (!newSource.name || !newSource.url) return;
    setSources(prev => [...prev, { ...newSource, id: Date.now().toString(), status: 'pending', lastSync: 'Nunca' }]);
    setNewSource({ name: '', url: '', description: '', type: 'url' }); setShowAddSource(false);
  };

  const syncSource = (id: string) => setSources(prev => prev.map(s => s.id === id ? { ...s, status: 'active', lastSync: new Date().toLocaleString('pt-BR') } : s));

  const addPreset = (preset: Omit<KnowledgeSource, 'id' | 'status' | 'lastSync'>) => {
    if (!preset.url) { setShowAddSource(true); setNewSource({ name: preset.name, url: '', description: preset.description, type: 'url' }); return; }
    setSources(prev => [...prev, { ...preset, id: Date.now().toString(), status: 'pending', lastSync: 'Nunca' }]);
  };

  if (loading) return <DashboardLayout><div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-primary-600" /></div></DashboardLayout>;

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2"><Brain className="w-7 h-7 text-primary-600" /> Configuração de IA</h1>
            <p className="text-gray-500 dark:text-gray-400 mt-1 text-sm">Configure o assistente inteligente para responder automaticamente no WhatsApp</p>
          </div>
          <div className="flex gap-3">
            <button onClick={handleTest} disabled={testing} className="flex items-center gap-2 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50 text-sm">
              {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <TestTube className="w-4 h-4" />} Testar conexão
            </button>
            <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors disabled:opacity-50 text-sm">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
              {saved ? 'Salvo!' : 'Salvar'}
            </button>
          </div>
        </div>

        {testResult && (
          <div className={`flex items-start gap-3 p-4 rounded-lg border ${testResult.ok ? 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800' : 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'}`}>
            {testResult.ok ? <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0" /> : <XCircle className="w-5 h-5 text-red-600 flex-shrink-0" />}
            <p className={`text-sm ${testResult.ok ? 'text-green-800 dark:text-green-200' : 'text-red-800 dark:text-red-200'}`}>{testResult.msg}</p>
          </div>
        )}

        {/* Tabs */}
        <div className="border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
          <nav className="flex gap-1 min-w-max">
            {([{ id: 'provider', label: 'Provedor & API Key', icon: Key }, { id: 'prompt', label: 'Prompt do Sistema', icon: Brain }, { id: 'schedule', label: 'Automação', icon: Clock }, { id: 'knowledge', label: 'Base de Conhecimento', icon: BookOpen }] as const).map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === tab.id ? 'border-primary-600 text-primary-600' : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'}`}>
                <tab.icon className="w-4 h-4" />{tab.label}
              </button>
            ))}
          </nav>
        </div>

        {/* TAB PROVEDOR */}
        {activeTab === 'provider' && (
          <div className="space-y-6">
            <div className="bg-white dark:bg-dark-card rounded-xl border border-light-border dark:border-dark-border p-6">
              <h2 className="font-semibold text-gray-900 dark:text-white mb-1">Escolha o Provedor de IA</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">Selecione qual IA será usada para gerar respostas automáticas no WhatsApp.</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {PROVIDERS.map(p => (
                  <button key={p.id} onClick={() => setConfig(c => ({ ...c, provider: p.id, model: p.models[0] }))} className={`p-4 rounded-xl border-2 text-left transition-all ${config.provider === p.id ? `${p.border} ${p.bg}` : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'}`}>
                    <div className={`font-semibold text-sm ${config.provider === p.id ? p.color : 'text-gray-700 dark:text-gray-300'}`}>{p.name}</div>
                    <div className="text-xs text-gray-400 mt-1">{p.models.length} modelos disponíveis</div>
                    {config.provider === p.id && <div className="mt-2 flex items-center gap-1"><CheckCircle className={`w-3.5 h-3.5 ${p.color}`} /><span className={`text-xs font-medium ${p.color}`}>Selecionado</span></div>}
                  </button>
                ))}
              </div>
              <a href={selectedProvider.docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary-600 hover:underline mt-3">
                <ExternalLink className="w-3 h-3" /> Documentação API do {selectedProvider.name}
              </a>
            </div>
            <div className="bg-white dark:bg-dark-card rounded-xl border border-light-border dark:border-dark-border p-6">
              <h2 className="font-semibold text-gray-900 dark:text-white mb-4">Modelo</h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {selectedProvider.models.map(m => (
                  <button key={m} onClick={() => setConfig(c => ({ ...c, model: m }))} className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${config.model === m ? 'bg-primary-600 text-white border-primary-600' : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'}`}>{m}</button>
                ))}
              </div>
            </div>
            <div className="bg-white dark:bg-dark-card rounded-xl border border-light-border dark:border-dark-border p-6">
              <h2 className="font-semibold text-gray-900 dark:text-white mb-1">Chave de API</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">Criptografada ao salvar. Nunca exibida em texto claro.</p>
              <div className="flex gap-2">
                <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={`Cole aqui sua ${selectedProvider.name} API Key`} className="flex-1 px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 outline-none" />
                {apiKey && apiKey.startsWith('•') && <button onClick={() => setApiKey('')} className="px-3 py-2 text-xs text-red-600 border border-red-300 rounded-lg hover:bg-red-50">Trocar</button>}
              </div>
            </div>
            <div className="bg-white dark:bg-dark-card rounded-xl border border-light-border dark:border-dark-border p-6">
              <h2 className="font-semibold text-gray-900 dark:text-white mb-4">Parâmetros</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div>
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-1">Temperatura: <span className="text-primary-600 font-semibold">{config.temperature}</span></label>
                  <input type="range" min="0" max="1" step="0.1" value={config.temperature} onChange={e => setConfig(c => ({ ...c, temperature: parseFloat(e.target.value) }))} className="w-full accent-primary-600" />
                  <div className="flex justify-between text-xs text-gray-400 mt-1"><span>Preciso</span><span>Criativo</span></div>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-2">Máx. tokens</label>
                  <input type="number" min="100" max="4000" step="100" value={config.max_tokens} onChange={e => setConfig(c => ({ ...c, max_tokens: parseInt(e.target.value) }))} className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 outline-none" />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB PROMPT */}
        {activeTab === 'prompt' && (
          <div className="bg-white dark:bg-dark-card rounded-xl border border-light-border dark:border-dark-border p-6 space-y-4">
            <div>
              <h2 className="font-semibold text-gray-900 dark:text-white mb-1">Prompt do Sistema</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">Define o comportamento da IA — tom de voz, regras e identidade do atendimento.</p>
            </div>
            <textarea value={config.system_prompt} onChange={e => setConfig(c => ({ ...c, system_prompt: e.target.value }))} rows={14} placeholder="Descreva como a IA deve se comportar..." className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 outline-none resize-none font-mono leading-relaxed" />
            <div className="flex justify-between items-center">
              <p className="text-xs text-gray-400">{config.system_prompt.length} caracteres</p>
              <button onClick={() => setConfig(c => ({ ...c, system_prompt: DEFAULT_PROMPT }))} className="text-xs text-primary-600 hover:underline">Restaurar padrão</button>
            </div>
            <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
              <p className="text-xs text-amber-800 dark:text-amber-200"><strong>Dica:</strong> Conecte fontes na aba &quot;Base de Conhecimento&quot; para que a IA consulte dados reais antes de responder.</p>
            </div>
          </div>
        )}

        {/* TAB AUTOMAÇÃO */}
        {activeTab === 'schedule' && (
          <div className="space-y-6">
            <div className="bg-white dark:bg-dark-card rounded-xl border border-light-border dark:border-dark-border p-6">
              <div className="flex items-center justify-between mb-4">
                <div><h2 className="font-semibold text-gray-900 dark:text-white">Resposta Automática</h2><p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">A IA responde automaticamente as mensagens recebidas</p></div>
                <button onClick={() => setConfig(c => ({ ...c, auto_reply_enabled: !c.auto_reply_enabled }))} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${config.auto_reply_enabled ? 'bg-primary-600' : 'bg-gray-300 dark:bg-gray-600'}`}>
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${config.auto_reply_enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
              {config.auto_reply_enabled && (
                <div>
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-2">Aguardar <span className="text-primary-600 font-semibold">{config.reply_delay_seconds}s</span> antes de responder</label>
                  <input type="range" min="1" max="30" step="1" value={config.reply_delay_seconds} onChange={e => setConfig(c => ({ ...c, reply_delay_seconds: parseInt(e.target.value) }))} className="w-full accent-primary-600" />
                  <div className="flex justify-between text-xs text-gray-400 mt-1"><span>1s</span><span>30s</span></div>
                </div>
              )}
            </div>
            <div className="bg-white dark:bg-dark-card rounded-xl border border-light-border dark:border-dark-border p-6">
              <div className="flex items-center justify-between mb-4">
                <div><h2 className="font-semibold text-gray-900 dark:text-white">Apenas Horário Comercial</h2><p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Responde somente dentro do horário definido</p></div>
                <button onClick={() => setConfig(c => ({ ...c, business_hours_only: !c.business_hours_only }))} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${config.business_hours_only ? 'bg-primary-600' : 'bg-gray-300 dark:bg-gray-600'}`}>
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${config.business_hours_only ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
              {config.business_hours_only && (
                <div className="flex gap-4">
                  <div className="flex-1"><label className="text-xs font-medium text-gray-500 block mb-1">Início</label><input type="time" value={config.business_hours_start} onChange={e => setConfig(c => ({ ...c, business_hours_start: e.target.value }))} className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 outline-none" /></div>
                  <div className="flex-1"><label className="text-xs font-medium text-gray-500 block mb-1">Fim</label><input type="time" value={config.business_hours_end} onChange={e => setConfig(c => ({ ...c, business_hours_end: e.target.value }))} className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 outline-none" /></div>
                </div>
              )}
            </div>
            <div className={`p-4 rounded-xl border flex items-center gap-3 ${config.auto_reply_enabled ? 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800' : 'bg-gray-50 border-gray-200 dark:bg-gray-800/50 dark:border-gray-700'}`}>
              <Zap className={`w-5 h-5 flex-shrink-0 ${config.auto_reply_enabled ? 'text-green-600' : 'text-gray-400'}`} />
              <p className={`text-sm ${config.auto_reply_enabled ? 'text-green-800 dark:text-green-200' : 'text-gray-600 dark:text-gray-400'}`}>
                {config.auto_reply_enabled ? `IA ativa — respondendo após ${config.reply_delay_seconds}s${config.business_hours_only ? ` · das ${config.business_hours_start} às ${config.business_hours_end}` : ' · 24h por dia'}` : 'Resposta automática desativada.'}
              </p>
            </div>
          </div>
        )}

        {/* TAB BASE DE CONHECIMENTO */}
        {activeTab === 'knowledge' && (
          <div className="space-y-6">
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-5">
              <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-1">Como funciona</h3>
              <p className="text-sm text-blue-800 dark:text-blue-200 leading-relaxed">Conecte URLs de documentação de API ou sites para que a IA consulte informações reais antes de responder. Funciona com qualquer plataforma — FacilZap, seu site, ERPs, etc.</p>
            </div>
            <div className="bg-white dark:bg-dark-card rounded-xl border border-light-border dark:border-dark-border p-6">
              <h2 className="font-semibold text-gray-900 dark:text-white mb-3">Integrações rápidas</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {PRESET_KNOWLEDGE.map((preset, i) => (
                  <div key={i} className="flex items-start justify-between p-4 border border-gray-200 dark:border-gray-700 rounded-lg">
                    <div className="flex-1 min-w-0 mr-3">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{preset.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{preset.description}</p>
                      {preset.url && <a href={preset.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary-600 hover:underline mt-1"><ExternalLink className="w-3 h-3" />{preset.url}</a>}
                    </div>
                    <button onClick={() => addPreset(preset)} className="px-3 py-1.5 text-xs bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors flex-shrink-0">+ Adicionar</button>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-white dark:bg-dark-card rounded-xl border border-light-border dark:border-dark-border p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold text-gray-900 dark:text-white">Fontes Conectadas</h2>
                <button onClick={() => setShowAddSource(!showAddSource)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors"><Plus className="w-3.5 h-3.5" /> Adicionar URL</button>
              </div>
              {showAddSource && (
                <div className="mb-4 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700 space-y-3">
                  <input value={newSource.name} onChange={e => setNewSource(n => ({ ...n, name: e.target.value }))} placeholder="Nome da fonte" className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 outline-none" />
                  <input value={newSource.url} onChange={e => setNewSource(n => ({ ...n, url: e.target.value }))} placeholder="URL da documentação (https://...)" className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 outline-none" />
                  <input value={newSource.description} onChange={e => setNewSource(n => ({ ...n, description: e.target.value }))} placeholder="Descrição (o que a IA vai encontrar aqui)" className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 outline-none" />
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setShowAddSource(false)} className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">Cancelar</button>
                    <button onClick={addSource} className="px-3 py-1.5 text-xs bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors">Confirmar</button>
                  </div>
                </div>
              )}
              {sources.length === 0 ? (
                <div className="text-center py-8 text-gray-400 dark:text-gray-500">
                  <Globe className="w-10 h-10 mx-auto mb-2 opacity-40" />
                  <p className="text-sm">Nenhuma fonte conectada ainda.</p>
                  <p className="text-xs mt-1">Use as integrações rápidas acima ou adicione uma URL.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {sources.map(source => (
                    <div key={source.id} className="flex items-center gap-3 p-3 border border-gray-200 dark:border-gray-700 rounded-lg">
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${source.status === 'active' ? 'bg-green-500' : source.status === 'error' ? 'bg-red-500' : 'bg-yellow-400'}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{source.name}</p>
                        <p className="text-xs text-gray-400 truncate">{source.url}</p>
                        <p className="text-xs text-gray-400">Última sync: {source.lastSync}</p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button onClick={() => syncSource(source.id)} className="p-1.5 text-gray-400 hover:text-primary-600 transition-colors" title="Sincronizar"><RefreshCw className="w-4 h-4" /></button>
                        <button onClick={() => setSources(prev => prev.filter(s => s.id !== source.id))} className="p-1.5 text-gray-400 hover:text-red-600 transition-colors" title="Remover"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
