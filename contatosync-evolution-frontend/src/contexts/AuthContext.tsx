'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiService } from '@/lib/api';
import { AuthContextType, User, LoginCredentials, RegisterData } from '@/types/auth';

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth deve ser usado dentro de AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: React.ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  // Verificar autenticação no carregamento
  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const { token: storedToken, user: storedUser } = apiService.getStoredAuthData();

      if (storedToken && storedUser) {
        setToken(storedToken);
        setUser(storedUser);

        // Validar token fazendo uma chamada para o perfil
        try {
          const freshUserData = await apiService.getProfile();
          setUser(freshUserData);
        } catch (error: unknown) {
          // Token inválido, limpar dados
          apiService.clearAuth();
          setToken(null);
          setUser(null);
        }
      }
    } catch (error: unknown) {
      console.error('Erro ao verificar autenticação:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (credentials: LoginCredentials) => {
    setIsLoading(true);
    try {
      const response = await apiService.login(credentials);
      setToken(response.token);
      setUser(response.user);
      router.push('/');
    } catch (error: any) {
      const errorMessage = error.response?.data?.error || 'Erro ao fazer login';
      throw new Error(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const register = async (data: RegisterData) => {
    setIsLoading(true);
    try {
      const response = await apiService.register(data);
      setToken(response.token);
      setUser(response.user);
      router.push('/');
    } catch (error: any) {
      const errorMessage = error.response?.data?.error || 'Erro ao fazer cadastro';
      throw new Error(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const logout = () => {
    apiService.clearAuth();
    setToken(null);
    setUser(null);
    router.push('/login');
  };

  const value: AuthContextType = {
    user,
    token,
    login,
    register,
    logout,
    isLoading,
    isAuthenticated: !!token && !!user,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};