import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { LoginCredentials, RegisterData, AuthResponse, User } from '@/types/auth';

class ApiService {
  private api: AxiosInstance;

  constructor() {
    // Auto-detectar URL da API baseado no ambiente
    const getApiUrl = () => {
      if (process.env.NEXT_PUBLIC_API_URL) {
        return process.env.NEXT_PUBLIC_API_URL;
      }

      // Em produção, usar Railway URL do Evolution
      if (typeof window !== 'undefined' && window.location.hostname !== 'localhost') {
        return 'https://web-production-50297.up.railway.app/api';
      }

      // Local development
      return 'http://localhost:3003/api';
    };

    this.api = axios.create({
      baseURL: getApiUrl(),
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    // Interceptor para adicionar token automaticamente
    this.api.interceptors.request.use(
      (config) => {
        const token = this.getStoredToken();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Interceptor para lidar com respostas
    this.api.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) {
          this.clearStoredAuth();
          window.location.href = '/login';
        }
        return Promise.reject(error);
      }
    );
  }

  // Autenticação
  async login(credentials: LoginCredentials): Promise<AuthResponse> {
    const response: AxiosResponse<any> = await this.api.post('/auth/login', credentials);
    const authData = {
      token: response.data.data.token,
      user: response.data.data.client
    };
    this.setStoredAuth(authData.token, authData.user);
    return authData;
  }

  async register(data: RegisterData): Promise<AuthResponse> {
    const response: AxiosResponse<any> = await this.api.post('/auth/register', data);
    const authData = {
      token: response.data.data.token,
      user: response.data.data.client
    };
    this.setStoredAuth(authData.token, authData.user);
    return authData;
  }

  // Perfil do usuário
  async getProfile(): Promise<User> {
    const response: AxiosResponse<{ data: User }> = await this.api.get('/auth/me');
    return response.data.data;
  }

  async updateProfile(data: Partial<User>): Promise<User> {
    const response: AxiosResponse<{ user: User }> = await this.api.put('/clients/profile', data);
    return response.data.user;
  }

  // Estatísticas serão implementadas quando o endpoint for criado na API

  // Contatos
  async getContacts(page = 1, limit = 50, search = '') {
    const response = await this.api.get('/contacts', {
      params: { page, limit, search }
    });
    return response.data.data;
  }

  async createContact(data: {
    phone: string;
    name?: string;
    email?: string;
    whatsapp_number?: string;
    notes?: string;
    status?: 'active' | 'inactive' | 'blocked';
  }) {
    const response = await this.api.post('/contacts', data);
    return response.data.data;
  }

  async updateContact(id: string, data: {
    name?: string;
    phone?: string;
    email?: string;
    whatsapp_number?: string;
    notes?: string;
    status?: 'active' | 'inactive' | 'blocked';
  }) {
    const response = await this.api.put(`/contacts/${id}`, data);
    return response.data.data;
  }

  async deleteContact(id: string) {
    const response = await this.api.delete(`/contacts/${id}`);
    return response.data.data;
  }

  // WhatsApp
  async getWhatsAppSessions() {
    const response = await this.api.get('/whatsapp/sessions');
    return response.data.data;
  }

  async createWhatsAppSession(sessionName: string) {
    const response = await this.api.post('/whatsapp/sessions', { session_name: sessionName });
    return response.data.data;
  }

  async getQRCode(sessionName: string) {
    const response = await this.api.get(`/whatsapp/sessions/${sessionName}/qrcode`, {
      timeout: 60000, // QR code pode levar ate 40s para gerar
    });
    return response.data.data;
  }

  async getSessionStatus(sessionName: string) {
    const response = await this.api.get(`/whatsapp/sessions/${sessionName}/status`);
    return response.data.data;
  }

  async deleteWhatsAppSession(sessionName: string) {
    const response = await this.api.delete(`/whatsapp/sessions/${sessionName}`);
    return response.data.data;
  }

  async sendWhatsAppMessage(sessionName: string, phone: string, message: string, contactId?: string) {
    const response = await this.api.post('/whatsapp/send-message', {
      session_name: sessionName,
      phone,
      message,
      contact_id: contactId
    });
    return response.data.data;
  }

  // Conversas
  async getConversations(page = 1, limit = 20, status = 'active') {
    const response = await this.api.get('/conversations', {
      params: { page, limit, status }
    });
    return response.data.data;
  }

  // Mensagens
  async getMessages(conversationId: string, page = 1, limit = 50) {
    const response = await this.api.get(`/messages/conversation/${conversationId}`, {
      params: { page, limit }
    });
    return response.data.data;
  }

  async sendMessage(data: {
    conversation_id: string;
    content: string;
    message_type?: string;
  }) {
    // Enviar via webhook de conversas diretamente
    const response = await this.api.post('/messages/send', {
      conversation_id: data.conversation_id,
      content: data.content,
      message_type: data.message_type || 'text'
    });
    return response.data.data;
  }

  // Configuração da IA
  async getAIConfig() {
    const response = await this.api.get('/ai/config');
    return response.data.data;
  }

  async updateAIConfig(data: any) {
    const response = await this.api.put('/ai/config', data);
    return response.data.data;
  }

  // Health check
  async healthCheck() {
    const response = await this.api.get('/health');
    return response.data.data;
  }

  // Gerenciamento de token
  private getStoredToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('contatosync_token');
  }

  private getStoredUser(): User | null {
    if (typeof window === 'undefined') return null;
    const userData = localStorage.getItem('contatosync_user');
    return userData ? JSON.parse(userData) : null;
  }

  private setStoredAuth(token: string, user: User): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem('contatosync_token', token);
    localStorage.setItem('contatosync_user', JSON.stringify(user));
  }

  private clearStoredAuth(): void {
    if (typeof window === 'undefined') return;
    localStorage.removeItem('contatosync_token');
    localStorage.removeItem('contatosync_user');
  }

  // Getters públicos para o estado atual
  getStoredAuthData(): { token: string | null; user: User | null } {
    return {
      token: this.getStoredToken(),
      user: this.getStoredUser(),
    };
  }

  clearAuth(): void {
    this.clearStoredAuth();
  }
}

export const apiService = new ApiService();