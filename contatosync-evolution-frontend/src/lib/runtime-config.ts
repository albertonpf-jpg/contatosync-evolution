const FALLBACK_API_URL = 'https://web-production-50297.up.railway.app/api';
const FALLBACK_SOCKET_URL = 'https://web-production-50297.up.railway.app';

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
