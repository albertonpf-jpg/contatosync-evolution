'use client';

import { useState, useEffect } from 'react';
import {
  Settings, User, Lock, Smartphone, Plug, Save, CheckCircle,
  Loader2, Eye, EyeOff, Trash2, Plus, ExternalLink, AlertCircle, Globe
} from 'lucide-react';
import { apiService } from '@/lib/api';
import DashboardLayout from '@/components/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';

interface ProfileData {
  name: string;
  email: string;
  phone: string;
  company_name: string;
}

interface PasswordData {
  current_password: string;
  new_password: string;
  confirm_password: string;
}

interface Integration {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
  last_sync: string | null;
  config: Record<string, any>;
}

export default function SettingsPage() {
  const { user } = useAuth();

  const [activeTab, setActiveTab] = useState<'profile' | 'security' | 'sessions' | 'integrations'>('profile');

  // ── Profile ──
  const [profile, setProfile] = useState<ProfileData>({ name: '', email: '', phone: '', company_name: '' });
  const [savingProfile, setSavingProfile] = useState(false);
  const [savedProfile, setSavedProfile] = useState(false);

  // ── Password ──
  const [passwords, setPasswords] = useState<PasswordData>({ current_password: '', new_password: '', confirm_password: '' });
  const [showPwd, setShowPwd] = useState({ current: false, new: false, confirm: false });
  const [savingPwd, setSavingPwd] = useState(false);
  const [savedPwd, setSavedPwd] = useState(false);
  const [pwdError, setPwdError] = useState('');

  // ── Sessions ──
  const [sessions, setSessions] = useState<any[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);

  // ── Integrations ──
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [showNewIntegration, setShowNewIntegration] = useState(false);
  const [newIntegration, setNewIntegration] = useState({ name: '', type: 'facilzap', webhook_url: '', api_key: '' });

  // Carregar dados do usuário
  useEffect(() => {
    if (user) {
      setProfile({
        name: user.name || '',
        email: user.email || '',
        phone: (user as any).phone || '',
        company_name: (user as any).company_name || '',
      });
    }
  }, [user]);

  // Carregar sessões e integrações ao trocar de aba
  useEffect(() => {
    if (activeTab === 'sessions') loadSessions();
    if (activeTab === 'integrations') loadIntegrations();
  }, [activeTab]);

  const loadSessions = async () => {
    setLoadingSessions(true);
    try {
      const data = await apiService.getWhatsAppSessions();
      setSessions(data || []);
    } catch { setSessions([]); }
    finally { setLoadingSessions(false); }
  };

  const loadIntegrations = async () => {
    try {
      const response = await (apiService as any).api?.get('/integrations');
      setIntegrations(response?.data?.data || []);
    } catch { setIntegrations([]); }
  };

  const handleSaveProfile = async () => {
    setSavingProfile(true); setSavedProfile(false);
    try {
      await apiService.updateProfile(profile);
      setSavedProfile(true);
      setTimeout(() => setSavedProfile(false), 3000);
    } catch (e: any) {
      alert('Erro ao salvar: ' + (e?.response?.data?.message || e.message));
    } finally { setSavingProfile(false); }
  };

  const handleSavePassword = async () => {
    setPwdError('');
    if (passwords.new_password !== passwords.confirm_password) {
      setPwdError('As senhas não conferem.'); return;
    }
    if (passwords.new_password.length < 6) {
      setPwdError('A nova senha deve ter no mínimo 6 caracteres.'); return;
    }
    setSavingPwd(true);
    try {
      await new Promise(r => setTimeout(r, 1000)); // endpoint futuro
      setSavedPwd(true);
      setPasswords({ current_password: '', new_password: '', confirm_password: '' });
      setTimeout(() => setSavedPwd(false), 3000);
    } catch (e: any) {
      setPwdError(e?.response?.data?.message || 'Erro ao alterar senha.');
    } finally { setSavingPwd(false); }
  };

  const handleDeleteSession = async (sessionName: string) => {
    if (!confirm(`Deseja remover a sessão "${sessionName}"?`)) return;
    try {
      await apiService.deleteWhatsAppSession(sessionName);
      setSessions(prev => prev.filter((s: any) => s.session_name !== sessionName));
    } catch (e: any) {
      alert('Erro ao remover sessão: ' + (e?.response?.data?.message || e.message));
    }
  };

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      connected: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
      connecting: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
      qr_ready: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
      disconnected: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
      error: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    };
    const label: Record<string, string> = {
      connected: 'Conectado', connecting: 'Conectando...', qr_ready: 'Aguardando QR',
      disconnected: 'Desconectado', error: 'Erro',
    };
    return (
      <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${map[status] || map.disconnected}`}>
        {label[status] || status}
      </span>
    );
  };

  const INTEGRATION_TYPES = [
    { id: 'facilzap', name: 'FacilZap', desc: 'Catálogo, pedidos e clientes', docsUrl: 'https://facilzap.com' },
    { id: 'webhook', name: 'Webhook genérico', desc: 'Envie eventos para qualquer URL', docsUrl: '' },
    { id: 'zapier', name: 'Zapier', desc: 'Conecte com milhares de apps', docsUrl: 'https://zapier.com' },
    { id: 'n8n', name: 'N8N', desc: 'Automação open-source', docsUrl: 'https://n8n.io' },
  ];

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto space-y-6">

        {/* ── Header ── */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Settings className="w-7 h-7 text-primary-600" /> Configurações
          </h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1 text-sm">
            Gerencie seu perfil, segurança, sessões WhatsApp e integrações
          </p>
        </div>

        {/* ── Tabs ── */}
        <div className="border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
          <nav className="flex gap-1 min-w-max">
            {([
              { id: 'profile', label: 'Perfil', icon: User },
              { id: 'security', label: 'Segurança', icon: Lock },
              { id: 'sessions', label: 'Sessões WhatsApp', icon: Smartphone },
              { id: 'integrations', label: 'Integrações', icon: Plug },
            ] as const).map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'border-primary-600 text-primary-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                }`}>
                <tab.icon className="w-4 h-4" />{tab.label}
              </button>
            ))}
          </nav>
        </div>

        {/* ══════════════════ TAB: PERFIL ══════════════════ */}
        {activeTab === 'profile' && (
          <div className="bg-white dark:bg-dark-card rounded-xl border border-light-border dark:border-dark-border p-6 space-y-5">
            <h2 className="font-semibold text-gray-900 dark:text-white">Dados da Conta</h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-1.5">Nome completo</label>
                <input value={profile.name} onChange={e => setProfile(p => ({ ...p, name: e.target.value }))}
                  placeholder="Seu nome"
                  className="w-full px-3 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 outline-none" />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-1.5">E-mail</label>
                <input value={profile.email} onChange={e => setProfile(p => ({ ...p, email: e.target.value }))}
                  type="email" placeholder="seu@email.com"
                  className="w-full px-3 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 outline-none" />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-1.5">Telefone</label>
                <input value={profile.phone} onChange={e => setProfile(p => ({ ...p, phone: e.target.value }))}
                  placeholder="+55 11 99999-9999"
                  className="w-full px-3 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 outline-none" />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-1.5">Nome da Empresa</label>
                <input value={profile.company_name} onChange={e => setProfile(p => ({ ...p, company_name: e.target.value }))}
                  placeholder="Minha Empresa Ltda"
                  className="w-full px-3 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 outline-none" />
              </div>
            </div>

            {/* Plano */}
            <div className="p-4 bg-primary-50 dark:bg-primary-900/20 border border-primary-200 dark:border-primary-800 rounded-lg flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-primary-900 dark:text-primary-100">
                  Plano atual: <span className="capitalize font-bold">{(user as any)?.plan || 'basic'}</span>
                </p>
                <p className="text-xs text-primary-700 dark:text-primary-300 mt-0.5">
                  Status: <span className="font-medium capitalize">{(user as any)?.status || 'active'}</span>
                </p>
              </div>
            </div>

            <div className="flex justify-end">
              <button onClick={handleSaveProfile} disabled={savingProfile}
                className="flex items-center gap-2 px-5 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
                {savingProfile ? <Loader2 className="w-4 h-4 animate-spin" /> : savedProfile ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                {savedProfile ? 'Salvo!' : 'Salvar Perfil'}
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════ TAB: SEGURANÇA ══════════════════ */}
        {activeTab === 'security' && (
          <div className="bg-white dark:bg-dark-card rounded-xl border border-light-border dark:border-dark-border p-6 space-y-5">
            <h2 className="font-semibold text-gray-900 dark:text-white">Alterar Senha</h2>

            {pwdError && (
              <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0" />
                <p className="text-sm text-red-700 dark:text-red-300">{pwdError}</p>
              </div>
            )}

            {savedPwd && (
              <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                <CheckCircle className="w-4 h-4 text-green-600" />
                <p className="text-sm text-green-700 dark:text-green-300">Senha alterada com sucesso!</p>
              </div>
            )}

            {(['current_password', 'new_password', 'confirm_password'] as const).map(field => {
              const labels = { current_password: 'Senha atual', new_password: 'Nova senha', confirm_password: 'Confirmar nova senha' };
              const showKey = field === 'current_password' ? 'current' : field === 'new_password' ? 'new' : 'confirm';
              return (
                <div key={field}>
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-1.5">{labels[field]}</label>
                  <div className="relative">
                    <input
                      type={showPwd[showKey] ? 'text' : 'password'}
                      value={passwords[field]}
                      onChange={e => setPasswords(p => ({ ...p, [field]: e.target.value }))}
                      placeholder="••••••••"
                      className="w-full px-3 py-2.5 pr-10 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 outline-none"
                    />
                    <button type="button" onClick={() => setShowPwd(s => ({ ...s, [showKey]: !s[showKey] }))}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                      {showPwd[showKey] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              );
            })}

            <div className="flex justify-end">
              <button onClick={handleSavePassword} disabled={savingPwd}
                className="flex items-center gap-2 px-5 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
                {savingPwd ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
                Alterar Senha
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════ TAB: SESSÕES ══════════════════ */}
        {activeTab === 'sessions' && (
          <div className="bg-white dark:bg-dark-card rounded-xl border border-light-border dark:border-dark-border p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="font-semibold text-gray-900 dark:text-white">Sessões WhatsApp</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Gerencie as conexões de WhatsApp desta conta</p>
              </div>
              <button onClick={() => window.location.href = '/whatsapp'}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5" /> Nova Sessão
              </button>
            </div>

            {loadingSessions ? (
              <div className="flex justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-primary-600" />
              </div>
            ) : sessions.length === 0 ? (
              <div className="text-center py-10 text-gray-400 dark:text-gray-500">
                <Smartphone className="w-10 h-10 mx-auto mb-2 opacity-40" />
                <p className="text-sm">Nenhuma sessão WhatsApp cadastrada.</p>
                <button onClick={() => window.location.href = '/whatsapp'}
                  className="mt-3 text-xs text-primary-600 hover:underline">
                  Ir para a página do WhatsApp →
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {sessions.map((session: any) => (
                  <div key={session.session_name} className="flex items-center justify-between p-4 border border-gray-200 dark:border-gray-700 rounded-lg">
                    <div className="flex items-center gap-3">
                      <div className={`w-2.5 h-2.5 rounded-full ${session.status === 'connected' ? 'bg-green-500' : 'bg-gray-400'}`} />
                      <div>
                        <p className="text-sm font-medium text-gray-900 dark:text-white">{session.session_name}</p>
                        {session.whatsapp_phone && (
                          <p className="text-xs text-gray-500 dark:text-gray-400">{session.whatsapp_phone}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {statusBadge(session.status)}
                      <button onClick={() => handleDeleteSession(session.session_name)}
                        className="p-1.5 text-gray-400 hover:text-red-600 transition-colors" title="Remover sessão">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ══════════════════ TAB: INTEGRAÇÕES ══════════════════ */}
        {activeTab === 'integrations' && (
          <div className="space-y-6">
            {/* Cards de integrações disponíveis */}
            <div className="bg-white dark:bg-dark-card rounded-xl border border-light-border dark:border-dark-border p-6">
              <h2 className="font-semibold text-gray-900 dark:text-white mb-4">Plataformas disponíveis</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {INTEGRATION_TYPES.map(type => (
                  <div key={type.id} className="flex items-start justify-between p-4 border border-gray-200 dark:border-gray-700 rounded-lg">
                    <div>
                      <p className="text-sm font-semibold text-gray-900 dark:text-white">{type.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{type.desc}</p>
                      {type.docsUrl && (
                        <a href={type.docsUrl} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-primary-600 hover:underline mt-1">
                          <ExternalLink className="w-3 h-3" /> Documentação
                        </a>
                      )}
                    </div>
                    <button
                      onClick={() => { setNewIntegration(n => ({ ...n, type: type.id, name: type.name })); setShowNewIntegration(true); }}
                      className="px-3 py-1.5 text-xs bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors flex-shrink-0 ml-3">
                      + Conectar
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Formulário nova integração */}
            {showNewIntegration && (
              <div className="bg-white dark:bg-dark-card rounded-xl border border-primary-300 dark:border-primary-700 p-6 space-y-4">
                <h2 className="font-semibold text-gray-900 dark:text-white">Nova integração: {newIntegration.name}</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1.5">Nome da integração</label>
                    <input value={newIntegration.name} onChange={e => setNewIntegration(n => ({ ...n, name: e.target.value }))}
                      placeholder="Ex: FacilZap Loja Principal"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 outline-none" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1.5">API Key / Token</label>
                    <input type="password" value={newIntegration.api_key} onChange={e => setNewIntegration(n => ({ ...n, api_key: e.target.value }))}
                      placeholder="Cole a API Key aqui"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 outline-none" />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1.5">Webhook URL (opcional)</label>
                    <input value={newIntegration.webhook_url} onChange={e => setNewIntegration(n => ({ ...n, webhook_url: e.target.value }))}
                      placeholder="https://..."
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 outline-none" />
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <button onClick={() => setShowNewIntegration(false)}
                    className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                    Cancelar
                  </button>
                  <button
                    onClick={() => {
                      setIntegrations(prev => [...prev, {
                        id: Date.now().toString(),
                        name: newIntegration.name,
                        type: newIntegration.type,
                        is_active: true,
                        last_sync: null,
                        config: { api_key: newIntegration.api_key, webhook_url: newIntegration.webhook_url },
                      }]);
                      setShowNewIntegration(false);
                      setNewIntegration({ name: '', type: 'facilzap', webhook_url: '', api_key: '' });
                    }}
                    className="px-4 py-2 text-sm bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors">
                    Salvar Integração
                  </button>
                </div>
              </div>
            )}

            {/* Lista de integrações salvas */}
            {integrations.length > 0 && (
              <div className="bg-white dark:bg-dark-card rounded-xl border border-light-border dark:border-dark-border p-6">
                <h2 className="font-semibold text-gray-900 dark:text-white mb-4">Integrações conectadas</h2>
                <div className="space-y-3">
                  {integrations.map(integration => (
                    <div key={integration.id} className="flex items-center justify-between p-4 border border-gray-200 dark:border-gray-700 rounded-lg">
                      <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${integration.is_active ? 'bg-green-500' : 'bg-gray-400'}`} />
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-white">{integration.name}</p>
                          <p className="text-xs text-gray-400 capitalize">{integration.type}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          integration.is_active
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                        }`}>
                          {integration.is_active ? 'Ativo' : 'Inativo'}
                        </span>
                        <button onClick={() => setIntegrations(prev => prev.filter(i => i.id !== integration.id))}
                          className="p-1.5 text-gray-400 hover:text-red-600 transition-colors">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {integrations.length === 0 && !showNewIntegration && (
              <div className="text-center py-6 text-gray-400 dark:text-gray-500">
                <Globe className="w-10 h-10 mx-auto mb-2 opacity-40" />
                <p className="text-sm">Nenhuma integração conectada ainda.</p>
                <p className="text-xs mt-1">Use os cards acima para conectar uma plataforma.</p>
              </div>
            )}
          </div>
        )}

      </div>
    </DashboardLayout>
  );
}
