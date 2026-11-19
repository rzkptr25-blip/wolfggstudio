import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Clapperboard,
  Coins,
  CreditCard,
  Film,
  LogOut,
  Menu,
  Plug,
  User as UserIcon,
  Users,
  X,
} from 'lucide-react';
import { AccountView } from './components/AccountView';
import { AdminComfyView } from './components/AdminComfyView';
import { AdminUsersView } from './components/AdminUsersView';
import { AuthScreen } from './components/AuthScreen';
import { BillingView } from './components/BillingView';
import { GalleryView } from './components/GalleryView';
import { StudioView } from './components/StudioView';
import { apiRequest, getClientWebSocketUrl, setStoredToken } from './lib/api';
import {
  AppView,
  StudioConfig,
  ToastNotice,
  User,
  VideoJob,
  WorkerRuntimeStatus,
} from './types';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState<AppView>('studio');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [studioConfig, setStudioConfig] = useState<StudioConfig | null>(null);
  const [workerStatus, setWorkerStatus] = useState<WorkerRuntimeStatus | null>(null);
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [prefillPrompt, setPrefillPrompt] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastNotice[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  const notify = useCallback((kind: 'info' | 'success' | 'error', message: string) => {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev.slice(-3), { id, kind, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  // Load initial tab from URL query (e.g. Midtrans finish callback ?tab=billing)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    if (tab === 'billing') setView('billing');
    else if (tab === 'gallery') setView('gallery');
  }, []);

  // Check existing session on startup
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await apiRequest<{ user: User }>('/api/auth/me');
        if (active) setUser(res.user);
      } catch {
        setStoredToken(null);
      } finally {
        if (active) setBooting(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Fetch studio config & user's jobs whenever authenticated
  const loadWorkspaceData = useCallback(async () => {
    try {
      const [cfgRes, jobsRes] = await Promise.all([
        apiRequest<StudioConfig>('/api/studio/config'),
        apiRequest<{ jobs: VideoJob[] }>('/api/jobs'),
      ]);
      setStudioConfig(cfgRes);
      setWorkerStatus(cfgRes.workerStatus);
      setJobs(jobsRes.jobs);
    } catch {
      // Handled gracefully
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void loadWorkspaceData();
  }, [user?.id, loadWorkspaceData]);

  // Authenticated real-time WebSocket (/ws/client) with auto-reconnect
  useEffect(() => {
    if (!user) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      return;
    }

    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(getClientWebSocketUrl());
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            type: string;
            data?: unknown;
          };

          if (msg.type === 'job:update' && msg.data) {
            const incoming = msg.data as VideoJob;
            setJobs((prev) => {
              const exists = prev.some((j) => j.id === incoming.id);
              if (exists) {
                return prev.map((j) => (j.id === incoming.id ? incoming : j));
              }
              if (incoming.userId === user.id) {
                return [incoming, ...prev];
              }
              return prev;
            });
            if (incoming.userId === user.id && incoming.status === 'completed') {
              notify('success', `Video ${incoming.id} selesai dirender!`);
            }
          } else if (msg.type === 'balance:update' && msg.data) {
            const data = msg.data as { userId: string; credits: number; reason?: string };
            if (data.userId === user.id) {
              setUser((prev) => (prev ? { ...prev, credits: data.credits } : prev));
              if (data.reason) {
                notify('info', data.reason);
              }
            }
          } else if (msg.type === 'worker:status' && msg.data) {
            setWorkerStatus(msg.data as WorkerRuntimeStatus);
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (!cancelled) {
          reconnectTimerRef.current = window.setTimeout(connect, 3500);
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [user?.id, notify]);

  async function handleLogout() {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    setStoredToken(null);
    setUser(null);
    setJobs([]);
    setStudioConfig(null);
    setView('studio');
  }

  function handleJobCreated(job: VideoJob, newCredits: number) {
    setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
    setUser((prev) => (prev ? { ...prev, credits: newCredits } : prev));
  }

  function handleJobUpdated(job: VideoJob) {
    setJobs((prev) => prev.map((j) => (j.id === job.id ? job : j)));
  }

  function handleJobDeleted(jobId: string) {
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
  }

  function handleCreditsUpdated(credits: number) {
    setUser((prev) => (prev ? { ...prev, credits } : prev));
  }

  function handleReusePrompt(prompt: string) {
    setPrefillPrompt(prompt);
    setView('studio');
  }

  if (booting) {
    return (
      <div className="min-h-screen bg-[#0B0E14] flex items-center justify-center">
        <div className="text-sm text-slate-400 font-mono">Memuat Kinetik Studio...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <AuthScreen
        onAuthenticated={(loggedInUser, bonusMsg) => {
          setUser(loggedInUser);
          if (bonusMsg) notify('success', bonusMsg);
        }}
      />
    );
  }

  const navItems: Array<{ id: AppView; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'studio', label: 'Studio Ref-to-Video', icon: Clapperboard },
    { id: 'gallery', label: 'Galeri Video', icon: Film },
    { id: 'billing', label: 'Top-Up & Saldo', icon: CreditCard },
    { id: 'account', label: 'Pengaturan Akun', icon: UserIcon },
  ];

  const adminItems: Array<{ id: AppView; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'admin-users', label: 'Manajemen Akun', icon: Users },
    { id: 'admin-comfy', label: 'Koneksi ComfyUI', icon: Plug },
  ];

  const breadcrumbMap: Record<AppView, string> = {
    studio: 'Studio Ref-to-Video',
    gallery: 'Galeri Video',
    billing: 'Top-Up & Saldo Midtrans',
    account: 'Pengaturan Akun',
    'admin-users': 'Admin / Manajemen Akun',
    'admin-comfy': 'Admin / Koneksi ComfyUI',
  };

  const comfyReady = workerStatus
    ? workerStatus.mode === 'bridge'
      ? workerStatus.connectedWorkers.length > 0
      : Boolean(workerStatus.tunnelUrl)
    : false;

  const sidebarContent = (
    <div className="flex flex-col h-full">
      <div className="h-16 px-5 border-b border-[#1E2636] flex items-center justify-between">
        <span className="font-display text-base font-bold tracking-tight text-white whitespace-nowrap">
          Kinetik Studio
        </span>
        <button
          type="button"
          onClick={() => setMobileNavOpen(false)}
          className="lg:hidden p-1 text-slate-400 hover:text-white cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <nav className="flex-1 p-3 space-y-6 overflow-y-auto">
        <div className="space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setView(item.id);
                  setMobileNavOpen(false);
                }}
                className={`w-full px-3 py-2.5 rounded-lg text-sm font-medium flex items-center gap-3 transition-colors cursor-pointer whitespace-nowrap ${
                  active
                    ? 'bg-[#181F2C] text-white'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-[#121721]'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-cyan-400' : 'text-slate-500'}`} />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </div>

        {user.role === 'admin' && (
          <div className="space-y-1 pt-4 border-t border-[#1E2636]">
            <p className="px-3 pb-1 text-xs font-medium text-slate-500">Administrator</p>
            {adminItems.map((item) => {
              const Icon = item.icon;
              const active = view === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setView(item.id);
                    setMobileNavOpen(false);
                  }}
                  className={`w-full px-3 py-2.5 rounded-lg text-sm font-medium flex items-center gap-3 transition-colors cursor-pointer whitespace-nowrap ${
                    active
                      ? 'bg-[#181F2C] text-white'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-[#121721]'
                  }`}
                >
                  <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-cyan-400' : 'text-slate-500'}`} />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </nav>

      {/* Real ComfyUI bridge/tunnel connection status (only real live state) */}
      <div className="px-4 py-3 border-t border-[#1E2636] text-xs space-y-1">
        <div className="flex items-center justify-between text-slate-400">
          <span>ComfyUI</span>
          <span className={comfyReady ? 'text-emerald-400 font-medium' : 'text-amber-400 font-medium'}>
            {comfyReady
              ? workerStatus?.mode === 'bridge'
                ? `${workerStatus.connectedWorkers.length} Worker Aktif`
                : 'Tunnel Aktif'
              : 'Belum Terhubung'}
          </span>
        </div>
        <p className="text-[11px] text-slate-500 font-mono">
          {workerStatus?.mode === 'tunnel' ? 'Mode Direct Tunnel' : 'Mode Bridge WebSocket'}
        </p>
      </div>

      {/* User profile footer */}
      <div className="p-3 border-t border-[#1E2636] flex items-center justify-between gap-2">
        <div className="min-w-0 px-1">
          <p className="text-sm font-medium text-white truncate">{user.name}</p>
          <p className="text-xs text-slate-500 truncate">{user.email}</p>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="p-2 text-slate-400 hover:text-rose-400 rounded-lg transition-colors cursor-pointer shrink-0"
          title="Keluar"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0B0E14] text-[#F1F5F9] flex">
      {/* Desktop Sidebar (256px) */}
      <aside className="hidden lg:block w-64 shrink-0 bg-[#0E121B] border-r border-[#1E2636] sticky top-0 h-screen">
        {sidebarContent}
      </aside>

      {/* Mobile Drawer */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-50 lg:hidden bg-black/70 backdrop-blur-xs flex"
          onClick={() => setMobileNavOpen(false)}
        >
          <aside
            className="w-64 bg-[#0E121B] border-r border-[#1E2636] h-full"
            onClick={(e) => e.stopPropagation()}
          >
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Clean single-row Top Bar */}
        <header className="h-16 px-4 sm:px-8 border-b border-[#1E2636] bg-[#0B0E14]/95 sticky top-0 z-30 flex items-center justify-between gap-6">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-300 hover:text-white cursor-pointer"
              aria-label="Buka navigasi"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm truncate">
              <span className="text-slate-500 hidden sm:inline">Kinetik</span>
              <span className="text-slate-600 hidden sm:inline" aria-hidden="true">/</span>
              <span className="font-medium text-white truncate">{breadcrumbMap[view]}</span>
            </div>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <div className="flex items-center gap-2 text-sm whitespace-nowrap">
              <Coins className="w-4 h-4 text-cyan-400 shrink-0" />
              <span className="font-mono font-semibold tabular-nums text-white">
                {user.credits.toLocaleString('id-ID')}
              </span>
              <span className="text-xs text-slate-400 hidden sm:inline">kredit</span>
            </div>

            <button
              type="button"
              onClick={() => setView('billing')}
              className="h-9 px-4 bg-cyan-500 hover:bg-cyan-400 text-[#071117] font-semibold text-xs rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              Top-Up Kredit
            </button>
          </div>
        </header>

        {/* Active Viewport */}
        <main className="flex-1 px-4 sm:px-8 py-6 sm:py-8 max-w-[1400px] w-full mx-auto">
          {view === 'studio' && (
            <StudioView
              user={user}
              studioConfig={studioConfig}
              workerStatus={workerStatus}
              jobs={jobs}
              prefillPrompt={prefillPrompt}
              onConsumePrefill={() => setPrefillPrompt(null)}
              onJobCreated={handleJobCreated}
              onJobUpdated={handleJobUpdated}
              onCreditsUpdated={handleCreditsUpdated}
              onNavigate={setView}
              onNotify={notify}
            />
          )}

          {view === 'gallery' && (
            <GalleryView
              jobs={jobs}
              onReusePrompt={handleReusePrompt}
              onJobDeleted={handleJobDeleted}
              onJobUpdated={handleJobUpdated}
              onCreditsUpdated={handleCreditsUpdated}
              onNavigate={setView}
              onNotify={notify}
            />
          )}

          {view === 'billing' && (
            <BillingView
              user={user}
              onCreditsUpdated={handleCreditsUpdated}
              onNotify={notify}
            />
          )}

          {view === 'account' && (
            <AccountView
              user={user}
              onUserUpdated={setUser}
              onNotify={notify}
            />
          )}

          {view === 'admin-users' && user.role === 'admin' && (
            <AdminUsersView
              currentUser={user}
              onCurrentUserCreditsChanged={handleCreditsUpdated}
              onNotify={notify}
            />
          )}

          {view === 'admin-comfy' && user.role === 'admin' && (
            <AdminComfyView
              liveWorkerStatus={workerStatus}
              onNotify={notify}
            />
          )}
        </main>
      </div>

      {/* Toast Notifications */}
      {toasts.length > 0 && (
        <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`pointer-events-auto px-4 py-3 rounded-lg border text-sm shadow-lg flex items-start justify-between gap-3 ${
                t.kind === 'success'
                  ? 'bg-[#121721] border-emerald-500/40 text-emerald-200'
                  : t.kind === 'error'
                    ? 'bg-[#121721] border-rose-500/40 text-rose-200'
                    : 'bg-[#121721] border-cyan-500/40 text-slate-200'
              }`}
            >
              <span className="leading-snug">{t.message}</span>
              <button
                type="button"
                onClick={() => setToasts((prev) => prev.filter((item) => item.id !== t.id))}
                className="text-slate-500 hover:text-white shrink-0 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
