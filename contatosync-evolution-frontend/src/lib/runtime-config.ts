const FALLBACK_API_URL = 'https://web-production-50297.up.railway.app/api';
const FALLBACK_SOCKET_URL = 'https://web-production-50297.up.railway.app';
const FALLBACK_SUPABASE_URL = 'https://uznrpziouttnncozxpvf.supabase.co';
const FALLBACK_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6bnJwemlvdXR0bm5jb3p4cHZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1NTc1OTQsImV4cCI6MjA5MDEzMzU5NH0.o3DH-R2JsI68BhECBAx-s5pEL6qXqNAgQpPpUq0rzZk';

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function getApiUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_API_URL?.trim();

  if (envUrl) {
    return trimTrailingSlash(envUrl);
  }

  if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
    return 'http://localhost:3003/api';
  }

  return FALLBACK_API_URL;
}

export function getSocketUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_SOCKET_URL?.trim();

  if (envUrl) {
    return trimTrailingSlash(envUrl);
  }

  const apiUrl = getApiUrl();
  return apiUrl.endsWith('/api') ? apiUrl.slice(0, -4) : FALLBACK_SOCKET_URL;
}

export function getSupabaseUrl(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || FALLBACK_SUPABASE_URL;
}

export function getSupabaseAnonKey(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || FALLBACK_SUPABASE_ANON_KEY;
}
