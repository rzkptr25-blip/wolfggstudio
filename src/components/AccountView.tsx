import React, { useState } from 'react';
import { KeyRound, Save, User as UserIcon } from 'lucide-react';
import { apiRequest, formatDateTime } from '../lib/api';
import { User } from '../types';

interface AccountViewProps {
  user: User;
  onUserUpdated: (user: User) => void;
  onNotify: (kind: 'info' | 'success' | 'error', message: string) => void;
}

export function AccountView({ user, onUserUpdated, onNotify }: AccountViewProps) {
  const [name, setName] = useState(user.name);
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const res = await apiRequest<{ user: User }>('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      onUserUpdated(res.user);
      onNotify('success', 'Profil akun berhasil diperbarui.');
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Gagal memperbarui profil.');
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      onNotify('error', 'Konfirmasi kata sandi baru tidak cocok.');
      return;
    }
    setSavingPassword(true);
    try {
      await apiRequest('/api/auth/password', {
        method: 'PATCH',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      onNotify('success', 'Kata sandi berhasil diperbarui.');
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Gagal mengubah kata sandi.');
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="max-w-4xl space-y-8">
      <div className="space-y-1">
        <h1 className="font-display text-2xl font-bold text-white">Pengaturan Akun</h1>
        <p className="text-sm text-slate-400">
          Kelola identitas akun, keamanan kata sandi, dan ringkasan saldo Anda.
        </p>
      </div>

      {/* Account Metadata Strip */}
      <div className="grid sm:grid-cols-3 gap-6 py-5 border-y border-[#1E2636]">
        <div>
          <p className="text-xs text-slate-400">Email Terdaftar</p>
          <p className="text-sm font-medium text-white mt-1 truncate">{user.email}</p>
        </div>
        <div>
          <p className="text-xs text-slate-400">Peran & Status</p>
          <p className="text-sm font-medium text-white mt-1">
            {user.role === 'admin' ? 'Administrator' : 'Pengguna'}
            <span className="text-slate-600 mx-2" aria-hidden="true">·</span>
            <span className="text-emerald-400">{user.status === 'active' ? 'Aktif' : 'Ditangguhkan'}</span>
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-400">Bergabung Sejak</p>
          <p className="text-sm font-mono tabular-nums text-slate-200 mt-1">
            {formatDateTime(user.created_at)}
          </p>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Profile form */}
        <form
          onSubmit={handleSaveProfile}
          className="bg-[#121721] border border-[#232C3D] rounded-xl p-6 space-y-5"
        >
          <div className="flex items-center gap-2.5">
            <UserIcon className="w-4 h-4 text-cyan-400" />
            <h2 className="font-display text-base font-semibold text-white">Informasi Profil</h2>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="profile-name" className="block text-xs font-medium text-slate-300">
              Nama Tampilan
            </label>
            <input
              id="profile-name"
              type="text"
              required
              minLength={2}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full h-10 px-3.5 bg-[#0B0E14] border border-[#232C3D] rounded-lg text-sm text-white focus:outline-none focus:border-cyan-500 transition-colors"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">ID Pengguna</label>
            <input
              type="text"
              readOnly
              value={user.id}
              className="w-full h-10 px-3.5 bg-[#0B0E14]/60 border border-[#1E2636] rounded-lg text-xs font-mono text-slate-400"
            />
          </div>

          <button
            type="submit"
            disabled={savingProfile}
            className="h-10 px-4 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-[#071117] font-semibold text-sm rounded-lg inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Save className="w-4 h-4" />
            <span>{savingProfile ? 'Menyimpan...' : 'Simpan Profil'}</span>
          </button>
        </form>

        {/* Password form */}
        <form
          onSubmit={handleChangePassword}
          className="bg-[#121721] border border-[#232C3D] rounded-xl p-6 space-y-5"
        >
          <div className="flex items-center gap-2.5">
            <KeyRound className="w-4 h-4 text-cyan-400" />
            <h2 className="font-display text-base font-semibold text-white">Ubah Kata Sandi</h2>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="cur-pass" className="block text-xs font-medium text-slate-300">
              Kata Sandi Saat Ini
            </label>
            <input
              id="cur-pass"
              type="password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full h-10 px-3.5 bg-[#0B0E14] border border-[#232C3D] rounded-lg text-sm text-white focus:outline-none focus:border-cyan-500 transition-colors"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="new-pass" className="block text-xs font-medium text-slate-300">
              Kata Sandi Baru
            </label>
            <input
              id="new-pass"
              type="password"
              required
              minLength={6}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Minimal 6 karakter"
              className="w-full h-10 px-3.5 bg-[#0B0E14] border border-[#232C3D] rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="confirm-pass" className="block text-xs font-medium text-slate-300">
              Ulangi Kata Sandi Baru
            </label>
            <input
              id="confirm-pass"
              type="password"
              required
              minLength={6}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full h-10 px-3.5 bg-[#0B0E14] border border-[#232C3D] rounded-lg text-sm text-white focus:outline-none focus:border-cyan-500 transition-colors"
            />
          </div>

          <button
            type="submit"
            disabled={savingPassword}
            className="h-10 px-4 bg-[#181F2C] hover:bg-[#222B3C] border border-[#2A3548] disabled:opacity-50 text-white font-medium text-sm rounded-lg inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap"
          >
            <span>{savingPassword ? 'Memperbarui...' : 'Perbarui Kata Sandi'}</span>
          </button>
        </form>
      </div>
    </div>
  );
}
