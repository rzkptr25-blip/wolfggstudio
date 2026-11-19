import React, { useState } from 'react';
import { ArrowRight, Film, Lock, Mail, User as UserIcon } from 'lucide-react';
import { apiRequest, setStoredToken } from '../lib/api';
import { User } from '../types';

interface AuthScreenProps {
  onAuthenticated: (user: User, bonusMessage?: string) => void;
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === 'register') {
        const res = await apiRequest<{ user: User; token: string; bonusCredits: number }>(
          '/api/auth/register',
          {
            method: 'POST',
            body: JSON.stringify({ name, email, password }),
          }
        );
        setStoredToken(res.token);
        onAuthenticated(
          res.user,
          `Akun dibuat. Bonus +${res.bonusCredits} kredit gratis telah masuk ke saldo Anda.`
        );
      } else {
        const res = await apiRequest<{ user: User; token: string }>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
        setStoredToken(res.token);
        onAuthenticated(res.user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Autentikasi gagal.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0B0E14] text-[#F1F5F9] flex flex-col">
      <header className="h-16 px-6 lg:px-10 border-b border-[#1E2636] flex items-center justify-between gap-8">
        <span className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0">
          Kinetik Studio
        </span>
        <div className="flex items-center gap-6 text-sm text-slate-400">
          <span className="hidden sm:inline whitespace-nowrap">MiniMax H3 Ref-to-Video</span>
          <span className="hidden sm:inline text-slate-600" aria-hidden="true">·</span>
          <span className="hidden sm:inline font-mono tabular-nums text-slate-300 whitespace-nowrap">
            480p 1 kr · 720p 2 kr · 1080p 3 kr / detik
          </span>
        </div>
      </header>

      <main className="flex-1 grid lg:grid-cols-12 max-w-[1360px] w-full mx-auto px-6 lg:px-10 py-10 lg:py-16 gap-12 items-center">
        {/* Left editorial overview */}
        <section className="lg:col-span-7 space-y-8">
          <div className="space-y-4 max-w-2xl">
            <p className="text-sm text-cyan-400 font-medium">
              ComfyUI WebSocket Cloud Bridge · Pembayaran Otomatis Midtrans
            </p>
            <h1 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-white leading-[1.12]">
              Jalankan workflow Ref-to-Video lokal Anda sebagai studio web berbasis kredit.
            </h1>
            <p className="text-base text-slate-400 leading-relaxed max-w-xl">
              Unggah gambar referensi, tulis arahan adegan, dan render video beserta audio langsung dari GPU ComfyUI lokal melalui koneksi WebSocket real-time dengan manajemen saldo otomatis.
            </p>
          </div>

          <div className="grid sm:grid-cols-3 gap-6 pt-6 border-t border-[#1E2636] max-w-2xl">
            <div className="space-y-1.5">
              <p className="font-mono text-2xl font-semibold text-white tabular-nums">10 kredit</p>
              <p className="text-sm text-slate-400">Bonus saldo gratis otomatis untuk setiap pendaftaran akun baru.</p>
            </div>
            <div className="space-y-1.5">
              <p className="font-mono text-2xl font-semibold text-white tabular-nums">1–3 kr/dtk</p>
              <p className="text-sm text-slate-400">480p (1 kr), 720p (2 kr), 1080p (3 kr) per detik dengan refund otomatis jika gagal.</p>
            </div>
            <div className="space-y-1.5">
              <p className="font-mono text-2xl font-semibold text-white tabular-nums">2 Mode</p>
              <p className="text-sm text-slate-400">Mendukung Bridge Agent WebSocket lokal dan URL Tunnel langsung.</p>
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs text-slate-500 pt-2">
            <Film className="w-4 h-4 text-slate-400 shrink-0" />
            <span>
              Akun pertama yang didaftarkan pada server ini otomatis memperoleh hak akses Administrator.
            </span>
          </div>
        </section>

        {/* Right auth surface */}
        <section className="lg:col-span-5 w-full max-w-md lg:ml-auto">
          <div className="bg-[#121721] border border-[#232C3D] rounded-xl p-6 sm:p-8 space-y-6">
            {/* Mode Switcher */}
            <div className="grid grid-cols-2 p-1 bg-[#0B0E14] border border-[#1E2636] rounded-lg">
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setError(null);
                }}
                className={`py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                  mode === 'login'
                    ? 'bg-[#181F2C] text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Masuk
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('register');
                  setError(null);
                }}
                className={`py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                  mode === 'register'
                    ? 'bg-[#181F2C] text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Daftar Akun
              </button>
            </div>

            <div className="space-y-1">
              <h2 className="font-display text-xl font-semibold text-white">
                {mode === 'login' ? 'Masuk ke Studio' : 'Buat Akun Kinetik'}
              </h2>
              <p className="text-sm text-slate-400">
                {mode === 'login'
                  ? 'Gunakan email dan kata sandi akun Anda.'
                  : 'Dapatkan 10 kredit gratis untuk mencoba generasi Ref-to-Video.'}
              </p>
            </div>

            {error && (
              <div className="px-4 py-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-sm text-rose-300">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              {mode === 'register' && (
                <div className="space-y-1.5">
                  <label htmlFor="auth-name" className="block text-xs font-medium text-slate-300">
                    Nama Lengkap
                  </label>
                  <div className="relative">
                    <UserIcon className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="auth-name"
                      type="text"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Nama Anda"
                      className="w-full h-11 pl-10 pr-3.5 bg-[#0B0E14] border border-[#232C3D] rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
                    />
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <label htmlFor="auth-email" className="block text-xs font-medium text-slate-300">
                  Alamat Email
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="auth-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="nama@domain.com"
                    className="w-full h-11 pl-10 pr-3.5 bg-[#0B0E14] border border-[#232C3D] rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="auth-password" className="block text-xs font-medium text-slate-300">
                  Kata Sandi
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="auth-password"
                    type="password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimal 6 karakter"
                    className="w-full h-11 pl-10 pr-3.5 bg-[#0B0E14] border border-[#232C3D] rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full h-11 mt-2 px-4 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-[#071117] font-semibold text-sm rounded-lg flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <span>
                  {loading
                    ? 'Memproses...'
                    : mode === 'login'
                      ? 'Masuk ke Studio'
                      : 'Daftar & Klaim 10 Kredit'}
                </span>
                {!loading && <ArrowRight className="w-4 h-4" />}
              </button>
            </form>
          </div>
        </section>
      </main>
    </div>
  );
}
