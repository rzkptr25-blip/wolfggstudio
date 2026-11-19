import React, { useCallback, useEffect, useState } from 'react';
import { Coins, RefreshCw, Search, Shield, UserCheck, UserX, X } from 'lucide-react';
import { apiRequest, formatDateTime, formatIdr } from '../lib/api';
import { AdminOverview, User } from '../types';

interface AdminUsersViewProps {
  currentUser: User;
  onCurrentUserCreditsChanged: (credits: number) => void;
  onNotify: (kind: 'info' | 'success' | 'error', message: string) => void;
}

export function AdminUsersView({
  currentUser,
  onCurrentUserCreditsChanged,
  onNotify,
}: AdminUsersViewProps) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  // Credit adjustment modal state
  const [creditTarget, setCreditTarget] = useState<User | null>(null);
  const [deltaInput, setDeltaInput] = useState('50');
  const [reasonInput, setReasonInput] = useState('');
  const [adjusting, setAdjusting] = useState(false);

  const loadData = useCallback(async (query = '') => {
    try {
      const qs = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
      const [ovRes, usersRes] = await Promise.all([
        apiRequest<AdminOverview>('/api/admin/overview'),
        apiRequest<{ users: User[] }>(`/api/admin/users${qs}`),
      ]);
      setOverview(ovRes);
      setUsers(usersRes.users);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Gagal memuat data admin.');
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadData(search);
    }, 200);
    return () => clearTimeout(timer);
  }, [search, loadData]);

  async function toggleUserField(target: User, patch: Partial<Pick<User, 'role' | 'status'>>) {
    setBusyUserId(target.id);
    try {
      const res = await apiRequest<{ user: User }>(`/api/admin/users/${encodeURIComponent(target.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setUsers((prev) => prev.map((u) => (u.id === target.id ? res.user : u)));
      onNotify('success', `Akun ${target.email} berhasil diperbarui.`);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Gagal memperbarui akun.');
    } finally {
      setBusyUserId(null);
    }
  }

  async function handleAdjustCredits(e: React.FormEvent) {
    e.preventDefault();
    if (!creditTarget) return;
    const delta = parseInt(deltaInput, 10);
    if (!Number.isInteger(delta) || delta === 0) {
      onNotify('error', 'Masukkan angka bulat selain 0 (misal 50 atau -10).');
      return;
    }

    setAdjusting(true);
    try {
      const res = await apiRequest<{ user: User }>(
        `/api/admin/users/${encodeURIComponent(creditTarget.id)}/credits`,
        {
          method: 'POST',
          body: JSON.stringify({ delta, reason: reasonInput }),
        }
      );
      setUsers((prev) => prev.map((u) => (u.id === creditTarget.id ? res.user : u)));
      if (creditTarget.id === currentUser.id) {
        onCurrentUserCreditsChanged(res.user.credits);
      }
      setCreditTarget(null);
      setReasonInput('');
      setDeltaInput('50');
      onNotify(
        'success',
        `Saldo ${res.user.email} diperbarui menjadi ${res.user.credits} kredit.`
      );
      void loadData(search);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Gagal menyesuaikan kredit.');
    } finally {
      setAdjusting(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-bold text-white">Manajemen Akun & Saldo</h1>
          <p className="text-sm text-slate-400">
            Kelola pengguna terdaftar, hak akses administrator, status akun, serta penyesuaian kredit manual.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadData(search)}
          className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#121721] hover:bg-[#181F2C] border border-[#232C3D] rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Muat Ulang</span>
        </button>
      </div>

      {/* 4-column flat KPI strip */}
      {overview && (
        <div className="grid grid-cols-2 lg:grid-cols-4 border border-[#232C3D] rounded-xl bg-[#121721] divide-y lg:divide-y-0 lg:divide-x divide-[#1E2636]">
          <div className="p-5 space-y-1">
            <p className="text-xs text-slate-400">Total Pengguna</p>
            <p className="font-mono text-2xl font-bold text-white tabular-nums">
              {overview.users.totalUsers}
            </p>
            <p className="text-xs text-slate-500 font-mono tabular-nums">
              {overview.users.activeUsers} aktif
            </p>
          </div>
          <div className="p-5 space-y-1">
            <p className="text-xs text-slate-400">Kredit Beredar</p>
            <p className="font-mono text-2xl font-bold text-cyan-400 tabular-nums">
              {overview.users.totalCreditsCirculating.toLocaleString('id-ID')}
            </p>
            <p className="text-xs text-slate-500 font-mono tabular-nums">
              {overview.revenue.totalCreditsSold.toLocaleString('id-ID')} terjual via Midtrans
            </p>
          </div>
          <div className="p-5 space-y-1">
            <p className="text-xs text-slate-400">Pendapatan Midtrans</p>
            <p className="font-mono text-2xl font-bold text-emerald-400 tabular-nums">
              {formatIdr(overview.revenue.totalRevenueIdr)}
            </p>
            <p className="text-xs text-slate-500 font-mono tabular-nums">
              {overview.revenue.settledCount} transaksi sukses
            </p>
          </div>
          <div className="p-5 space-y-1">
            <p className="text-xs text-slate-400">Total Render Video</p>
            <p className="font-mono text-2xl font-bold text-white tabular-nums">
              {overview.jobs.totalJobs}
            </p>
            <p className="text-xs text-slate-500 font-mono tabular-nums">
              {overview.jobs.completedJobs} selesai · {overview.jobs.activeJobs} aktif
            </p>
          </div>
        </div>
      )}

      {/* User Directory Table */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-base font-semibold text-white">Daftar Pengguna</h2>
          <div className="relative">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari nama atau email..."
              className="h-9 pl-9 pr-3 w-64 bg-[#121721] border border-[#232C3D] rounded-lg text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
            />
          </div>
        </div>

        <div className="bg-[#121721] border border-[#232C3D] rounded-xl overflow-hidden">
          {loading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-11 bg-[#181F2C] rounded animate-pulse" />
              ))}
            </div>
          ) : users.length === 0 ? (
            <div className="py-12 px-6 text-center text-sm text-slate-400">
              Tidak ada pengguna ditemukan.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#1E2636] text-xs text-slate-400 font-medium">
                    <th className="py-3 px-4">Pengguna</th>
                    <th className="py-3 px-4">Peran</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Saldo Kredit</th>
                    <th className="py-3 px-4">Terdaftar</th>
                    <th className="py-3 px-4 text-right">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E2636] text-sm">
                  {users.map((u) => {
                    const isSelf = u.id === currentUser.id;
                    return (
                      <tr key={u.id} className="hover:bg-[#181F2C]/40 transition-colors">
                        <td className="py-3 px-4">
                          <p className="font-medium text-white">
                            {u.name}
                            {isSelf && <span className="text-xs text-slate-500 ml-2">(Anda)</span>}
                          </p>
                          <p className="text-xs text-slate-400">{u.email}</p>
                        </td>
                        <td className="py-3 px-4 text-xs whitespace-nowrap">
                          <span className={u.role === 'admin' ? 'text-cyan-400 font-medium' : 'text-slate-300'}>
                            {u.role === 'admin' ? 'Administrator' : 'Pengguna'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-xs whitespace-nowrap">
                          <span className={u.status === 'active' ? 'text-emerald-400' : 'text-rose-400'}>
                            {u.status === 'active' ? 'Aktif' : 'Ditangguhkan'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-white whitespace-nowrap">
                          {u.credits.toLocaleString('id-ID')}
                        </td>
                        <td className="py-3 px-4 text-xs font-mono tabular-nums text-slate-400 whitespace-nowrap">
                          {formatDateTime(u.created_at)}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setCreditTarget(u);
                                setDeltaInput('50');
                                setReasonInput('');
                              }}
                              className="px-2.5 py-1.5 text-xs font-medium text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/25 rounded-md inline-flex items-center gap-1 cursor-pointer"
                            >
                              <Coins className="w-3.5 h-3.5" />
                              <span>Kredit</span>
                            </button>

                            {!isSelf && (
                              <>
                                <button
                                  type="button"
                                  disabled={busyUserId === u.id}
                                  onClick={() =>
                                    void toggleUserField(u, {
                                      role: u.role === 'admin' ? 'user' : 'admin',
                                    })
                                  }
                                  className="px-2.5 py-1.5 text-xs text-slate-300 hover:text-white bg-[#181F2C] border border-[#2A3548] rounded-md inline-flex items-center gap-1 cursor-pointer"
                                  title="Ubah peran pengguna"
                                >
                                  <Shield className="w-3.5 h-3.5" />
                                  <span>{u.role === 'admin' ? 'Jadikan User' : 'Jadikan Admin'}</span>
                                </button>

                                <button
                                  type="button"
                                  disabled={busyUserId === u.id}
                                  onClick={() =>
                                    void toggleUserField(u, {
                                      status: u.status === 'active' ? 'suspended' : 'active',
                                    })
                                  }
                                  className={`px-2.5 py-1.5 text-xs rounded-md inline-flex items-center gap-1 border cursor-pointer ${
                                    u.status === 'active'
                                      ? 'text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 border-rose-500/25'
                                      : 'text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/25'
                                  }`}
                                >
                                  {u.status === 'active' ? (
                                    <>
                                      <UserX className="w-3.5 h-3.5" />
                                      <span>Tangguhkan</span>
                                    </>
                                  ) : (
                                    <>
                                      <UserCheck className="w-3.5 h-3.5" />
                                      <span>Aktifkan</span>
                                    </>
                                  )}
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Adjust Credit Modal */}
      {creditTarget && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setCreditTarget(null)}
        >
          <form
            onSubmit={handleAdjustCredits}
            onClick={(e) => e.stopPropagation()}
            className="bg-[#121721] border border-[#232C3D] rounded-xl max-w-md w-full p-6 space-y-5"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-base font-semibold text-white">
                  Sesuaikan Saldo Kredit
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {creditTarget.name} · {creditTarget.email}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCreditTarget(null)}
                className="p-1 text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-3.5 py-2.5 rounded-lg bg-[#0B0E14] border border-[#1E2636] flex items-center justify-between text-xs">
              <span className="text-slate-400">Saldo saat ini</span>
              <span className="font-mono tabular-nums font-semibold text-white">
                {creditTarget.credits} kredit
              </span>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="adj-delta" className="block text-xs font-medium text-slate-300">
                Jumlah Perubahan Kredit (positif untuk tambah, negatif untuk kurangi)
              </label>
              <input
                id="adj-delta"
                type="number"
                required
                value={deltaInput}
                onChange={(e) => setDeltaInput(e.target.value)}
                className="w-full h-10 px-3.5 bg-[#0B0E14] border border-[#232C3D] rounded-lg text-sm font-mono tabular-nums text-white focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="adj-reason" className="block text-xs font-medium text-slate-300">
                Catatan Audit (tampil di buku besar pengguna)
              </label>
              <input
                id="adj-reason"
                type="text"
                required
                minLength={3}
                value={reasonInput}
                onChange={(e) => setReasonInput(e.target.value)}
                placeholder="Contoh: Bonus promosi atau koreksi pembayaran manual"
                className="w-full h-10 px-3.5 bg-[#0B0E14] border border-[#232C3D] rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCreditTarget(null)}
                className="h-9 px-4 text-xs font-medium text-slate-300 hover:text-white cursor-pointer"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={adjusting}
                className="h-9 px-4 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-[#071117] font-semibold text-xs rounded-lg cursor-pointer"
              >
                {adjusting ? 'Menyimpan...' : 'Terapkan Perubahan'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
