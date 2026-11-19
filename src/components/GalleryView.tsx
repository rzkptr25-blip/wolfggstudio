import React, { useMemo, useState } from 'react';
import {
  Download,
  Film,
  Play,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { apiRequest, formatDateTime, jobStatusLabel } from '../lib/api';
import { AppView, VideoJob } from '../types';

interface GalleryViewProps {
  jobs: VideoJob[];
  onReusePrompt: (prompt: string) => void;
  onJobDeleted: (jobId: string) => void;
  onJobUpdated: (job: VideoJob) => void;
  onCreditsUpdated: (credits: number) => void;
  onNavigate: (view: AppView) => void;
  onNotify: (kind: 'info' | 'success' | 'error', message: string) => void;
}

export function GalleryView({
  jobs,
  onReusePrompt,
  onJobDeleted,
  onJobUpdated,
  onCreditsUpdated,
  onNavigate,
  onNotify,
}: GalleryViewProps) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'completed' | 'active' | 'failed'>('all');
  const [modalJob, setModalJob] = useState<VideoJob | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const filteredJobs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return jobs.filter((job) => {
      if (filter === 'completed' && job.status !== 'completed') return false;
      if (filter === 'active' && !['queued', 'uploading', 'running'].includes(job.status)) return false;
      if (filter === 'failed' && job.status !== 'failed') return false;
      if (q) {
        return (
          job.prompt.toLowerCase().includes(q) ||
          job.id.toLowerCase().includes(q) ||
          job.aspectRatio.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [jobs, search, filter]);

  async function handleDelete(job: VideoJob) {
    setBusyId(job.id);
    try {
      await apiRequest(`/api/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
      onJobDeleted(job.id);
      if (modalJob?.id === job.id) setModalJob(null);
      onNotify('info', 'Riwayat video telah dihapus.');
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Gagal menghapus video.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleCancel(job: VideoJob) {
    setBusyId(job.id);
    try {
      const res = await apiRequest<{ job: VideoJob | null; credits?: number }>(
        `/api/jobs/${encodeURIComponent(job.id)}/cancel`,
        { method: 'POST' }
      );
      if (res.job) onJobUpdated(res.job);
      if (typeof res.credits === 'number') onCreditsUpdated(res.credits);
      onNotify('info', 'Antrean dibatalkan dan kredit dikembalikan.');
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Gagal membatalkan antrean.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-bold text-white">Galeri & Riwayat Render</h1>
          <p className="text-sm text-slate-400">
            Seluruh hasil generasi Ref-to-Video dan status antrean akun Anda.
          </p>
        </div>

        {/* Search & Filter controls */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari prompt atau ID job..."
              className="h-9 pl-9 pr-3 w-56 bg-[#121721] border border-[#232C3D] rounded-lg text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div className="flex items-center gap-1 p-1 bg-[#121721] border border-[#232C3D] rounded-lg">
            {(
              [
                ['all', 'Semua'],
                ['completed', 'Selesai'],
                ['active', 'Proses'],
                ['failed', 'Gagal'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  filter === key ? 'bg-[#181F2C] text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {filteredJobs.length === 0 ? (
        <div className="bg-[#121721] border border-[#232C3D] rounded-xl py-16 px-6 flex flex-col items-center justify-center text-center space-y-4">
          <Film className="w-8 h-8 text-slate-500" />
          <div className="space-y-1 max-w-sm">
            <h2 className="font-display text-base font-semibold text-white">
              {jobs.length === 0 ? 'Belum ada video yang dirender' : 'Tidak ada hasil yang cocok'}
            </h2>
            <p className="text-sm text-slate-400">
              {jobs.length === 0
                ? 'Mulai buat video pertama Anda dari gambar referensi di Studio.'
                : 'Ubah kata kunci pencarian atau pilih filter status lainnya.'}
            </p>
          </div>
          {jobs.length === 0 && (
            <button
              type="button"
              onClick={() => onNavigate('studio')}
              className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-[#071117] font-semibold text-sm rounded-lg transition-colors cursor-pointer"
            >
              Buka Studio Ref-to-Video
            </button>
          )}
        </div>
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-5">
          {filteredJobs.map((job) => {
            const st = jobStatusLabel(job.status);
            return (
              <article
                key={job.id}
                className="bg-[#121721] border border-[#232C3D] rounded-xl overflow-hidden flex flex-col"
              >
                {/* Media preview */}
                <div className="relative aspect-video bg-[#0B0E14] border-b border-[#1E2636] overflow-hidden">
                  <img
                    src={job.refImageUrl}
                    alt={job.refImageOriginalName}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover opacity-85"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent" />

                  {job.status === 'completed' && job.outputVideoUrl && (
                    <button
                      type="button"
                      onClick={() => setModalJob(job)}
                      aria-label="Putar video"
                      className="absolute inset-0 flex items-center justify-center group cursor-pointer"
                    >
                      <span className="w-12 h-12 rounded-full bg-black/70 border border-white/25 flex items-center justify-center text-white group-hover:scale-105 transition-transform">
                        <Play className="w-5 h-5 fill-white ml-0.5" />
                      </span>
                    </button>
                  )}

                  {['queued', 'uploading', 'running'].includes(job.status) && (
                    <div className="absolute inset-x-4 bottom-4 space-y-1.5">
                      <div className="flex items-center justify-between text-xs text-white font-mono tabular-nums">
                        <span className="truncate pr-2">{job.statusMessage || st.label}</span>
                        <span>{job.progress}%</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-white/15 overflow-hidden">
                        <div
                          className="h-full bg-cyan-400 transition-all duration-300"
                          style={{ width: `${Math.max(5, job.progress)}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {job.status === 'completed' && (
                    <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-xs text-slate-200 font-mono tabular-nums">
                      <span>{job.durationSec} detik · {job.resolution} · {job.aspectRatio}</span>
                      <span>{job.width}×{job.height}</span>
                    </div>
                  )}
                </div>

                {/* Metadata & Actions */}
                <div className="p-4 flex-1 flex flex-col justify-between gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`font-medium ${st.colorClass}`}>{st.label}</span>
                      <span className="text-slate-600" aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums text-slate-400">
                        {job.creditsCost} kredit
                        {job.creditsRefunded ? ' (dikembalikan)' : ''}
                      </span>
                      <span className="text-slate-600" aria-hidden="true">·</span>
                      <span className="text-slate-500 font-mono tabular-nums truncate">
                        {formatDateTime(job.createdAt)}
                      </span>
                    </div>

                    <p className="text-sm text-slate-200 line-clamp-2 leading-relaxed">
                      {job.prompt}
                    </p>

                    {job.status === 'failed' && job.errorMessage && (
                      <p className="text-xs text-rose-400 line-clamp-2">{job.errorMessage}</p>
                    )}
                  </div>

                  <div className="pt-3 border-t border-[#1E2636] flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {job.status === 'completed' && job.outputVideoUrl && (
                        <>
                          <button
                            type="button"
                            onClick={() => setModalJob(job)}
                            className="px-2.5 py-1.5 text-xs font-medium text-white bg-[#181F2C] hover:bg-[#222B3C] border border-[#2A3548] rounded-md cursor-pointer whitespace-nowrap"
                          >
                            Putar
                          </button>
                          <a
                            href={job.outputVideoUrl}
                            download={`${job.id}.mp4`}
                            className="p-1.5 text-slate-300 hover:text-white bg-[#181F2C] border border-[#2A3548] rounded-md"
                            title="Unduh MP4"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </a>
                        </>
                      )}

                      {job.status === 'queued' && (
                        <button
                          type="button"
                          disabled={busyId === job.id}
                          onClick={() => handleCancel(job)}
                          className="px-2.5 py-1.5 text-xs font-medium text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 rounded-md cursor-pointer whitespace-nowrap"
                        >
                          Batalkan
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => onReusePrompt(job.prompt)}
                        className="p-1.5 text-slate-400 hover:text-cyan-400 rounded-md transition-colors cursor-pointer"
                        title="Gunakan ulang prompt di Studio"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {!['uploading', 'running'].includes(job.status) && (
                      <button
                        type="button"
                        disabled={busyId === job.id}
                        onClick={() => handleDelete(job)}
                        className="p-1.5 text-slate-500 hover:text-rose-400 rounded-md transition-colors cursor-pointer"
                        title="Hapus riwayat"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Video Player Modal */}
      {modalJob && modalJob.outputVideoUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setModalJob(null)}
        >
          <div
            className="bg-[#121721] border border-[#232C3D] rounded-xl max-w-4xl w-full overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-[#1E2636] flex items-center justify-between gap-4">
              <div>
                <h3 className="font-display text-base font-semibold text-white">Pemutar Video</h3>
                <p className="text-xs font-mono tabular-nums text-slate-400 mt-0.5">
                  {modalJob.id} · {modalJob.durationSec} detik · {modalJob.resolution} ({modalJob.width}×{modalJob.height}) · Seed {modalJob.seed}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={modalJob.outputVideoUrl}
                  download={`${modalJob.id}.mp4`}
                  className="px-3 py-1.5 text-xs font-medium bg-cyan-500 hover:bg-cyan-400 text-[#071117] rounded-md inline-flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Unduh MP4</span>
                </a>
                <button
                  type="button"
                  onClick={() => setModalJob(null)}
                  className="p-1.5 text-slate-400 hover:text-white rounded-md cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="bg-black flex items-center justify-center">
              <video
                src={modalJob.outputVideoUrl}
                controls
                autoPlay
                playsInline
                className="w-full max-h-[70vh]"
              />
            </div>

            <div className="px-5 py-4 border-t border-[#1E2636] text-sm text-slate-300">
              {modalJob.prompt}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
