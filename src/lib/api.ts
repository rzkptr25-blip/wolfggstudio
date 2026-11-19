const TOKEN_STORAGE_KEY = 'kinetik_auth_token';

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export async function apiRequest<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(options.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!(options.body instanceof FormData) && options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });

  const text = await res.text();
  let json: Record<string, unknown> = {};
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { error: text };
    }
  }

  if (!res.ok) {
    throw new Error(String(json.error || `Permintaan gagal (HTTP ${res.status})`));
  }

  return json as T;
}

export function formatIdr(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const normalized = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function getClientWebSocketUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getStoredToken();
  const base = `${proto}//${window.location.host}/ws/client`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function jobStatusLabel(status: string): { label: string; colorClass: string } {
  switch (status) {
    case 'completed':
      return { label: 'Selesai', colorClass: 'text-emerald-400' };
    case 'running':
      return { label: 'Merender', colorClass: 'text-cyan-400' };
    case 'uploading':
      return { label: 'Mengunggah', colorClass: 'text-cyan-300' };
    case 'queued':
      return { label: 'Antrean', colorClass: 'text-amber-400' };
    case 'failed':
      return { label: 'Gagal', colorClass: 'text-rose-400' };
    default:
      return { label: status, colorClass: 'text-slate-400' };
  }
}

export function paymentStatusLabel(status: string): { label: string; colorClass: string } {
  switch (status) {
    case 'settlement':
      return { label: 'Berhasil', colorClass: 'text-emerald-400' };
    case 'pending':
      return { label: 'Menunggu Bayar', colorClass: 'text-amber-400' };
    case 'expire':
      return { label: 'Kedaluwarsa', colorClass: 'text-slate-400' };
    case 'cancel':
      return { label: 'Dibatalkan', colorClass: 'text-slate-400' };
    case 'deny':
    case 'failure':
      return { label: 'Ditolak', colorClass: 'text-rose-400' };
    default:
      return { label: status, colorClass: 'text-slate-400' };
  }
}
