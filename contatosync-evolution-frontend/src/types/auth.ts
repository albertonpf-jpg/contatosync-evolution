export interface User {
  id: string;
  email: string;
  name: string;
  company?: string;
  phone?: string;
  plan: 'basic' | 'pro' | 'enterprise';
  status: 'active' | 'inactive' | 'trial' | 'suspended';
  ai_enabled: boolean;
  created_at: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData {
  email: string;
  password: string;
  name: string;
  company?: string;
  phone?: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (credentials: LoginCredentials) => Promise<void>;
  register: (data: RegisterData) => Promise<void>;
  logout: () => void;
  isLoading: boolean;
  isAuthenticated: boolean;
}