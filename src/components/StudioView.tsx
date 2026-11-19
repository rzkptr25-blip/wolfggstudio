import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Download,
  Film,
  ImagePlus,
  Loader2,
  Play,
  RotateCcw,
  Settings2,
  Upload,
  X,
} from 'lucide-react';
import { apiRequest, formatDateTime, jobStatusLabel } from '../lib/api';
import {
  AppView,
  AspectRatioId,
  AspectRatioPreset,
  ResolutionId,
  ResolutionPreset,
  StudioConfig,
  User,
  VideoJob,
  WorkerRuntimeStatus,
} from '../types';

interface StudioViewProps {
  user: User;
  studioConfig: StudioConfig | null;
  workerStatus: WorkerRuntimeStatus | null;
  jobs: VideoJob[];
  prefillPrompt: string | null;
  onConsumePrefill: () => void;
  onJobCreated: (job: VideoJob, newCredits: number) => void;
  onJobUpdated: (job: VideoJob) => void;
  onCreditsUpdated: (credits: number) => void;
  onNavigate: (view: AppView) => void;
  onNotify: (kind: 'info' | 'success' | 'error', message: string) => void;
}

export function StudioView({
  user,
  studioConfig,
  workerStatus,
  jobs,
  prefillPrompt,
  onConsumePrefill,
  onJobCreated,
  onJobUpdated,
  onCreditsUpdated,
  onNavigate,
  onNotify,
}: StudioViewProps) {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [durationSec, setDurationSec] = useState(5);
  const [resolution, setResolution] = useState<ResolutionId>('480p');
  const [aspectRatio, setAspectRatio] = useState<AspectRatioId>('9:16');
  const [submitting, setSubmitting] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (prefillPrompt) {
      setPrompt(prefillPrompt);
      onConsumePrefill();
    }
  }, [prefillPrompt, onConsumePrefill]);

  useEffect(() => {
    return () => {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    };
  }, [imagePreviewUrl]);

  const activeJob = useMemo(() => {
    if (selectedJobId) {
      const found = jobs.find((j) => j.id === selectedJobId);
      if (found) return found;
    }
    return jobs[0] || null;
  }, [jobs, selectedJobId]);

  const resolutionPresets: ResolutionPreset[] = studioConfig?.resolutions ?? [
    { id: '480p', label: '480p', shortHeight: 480, creditsPerSecond: 1, description: 'Standar cepat' },
    { id: '720p', label: '720p HD', shortHeight: 720, creditsPerSecond: 2, description: 'Tajam HD' },
    { id: '1080p', label: '1080p Full HD', shortHeight: 1080, creditsPerSecond: 3, description: 'Kualitas tinggi' },
  ];

  const selectedResolution =
    resolutionPresets.find((r) => r.id === resolution) ?? resolutionPresets[0];

  const aspectPresets: AspectRatioPreset[] = studioConfig?.aspectRatios ?? [
    {
      id: '9:16',
      label: '9:16 Vertikal',
      description: 'Reels / Shorts',
      dimensions: {
        '480p': { width: 480, height: 864 },
        '720p': { width: 720, height: 1280 },
        '1080p': { width: 1080, height: 1920 },
      },
    },
    {
      id: '16:9',
      label: '16:9 Sinematik',
      description: 'Landscape',
      dimensions: {
        '480p': { width: 864, height: 480 },
        '720p': { width: 1280, height: 720 },
        '1080p': { width: 1920, height: 1080 },
      },
    },
    {
      id: '1:1',
      label: '1:1 Persegi',
      description: 'Feed',
      dimensions: {
        '480p': { width: 480, height: 480 },
        '720p': { width: 720, height: 720 },
        '1080p': { width: 1080, height: 1080 },
      },
    },
    {
      id: '3:4',
      label: '3:4 Potret',
      description: 'Editorial',
      dimensions: {
        '480p': { width: 480, height: 640 },
        '720p': { width: 720, height: 960 },
        '1080p': { width: 1080, height: 1440 },
      },
    },
    {
      id: '4:3',
      label: '4:3 Klasik',
      description: 'Studio',
      dimensions: {
        '480p': { width: 640, height: 480 },
        '720p': { width: 960, height: 720 },
        '1080p': { width: 1440, height: 1080 },
      },
    },
  ];

  const minSec = studioConfig?.durationMin ?? 3;
  const maxSec = studioConfig?.durationMax ?? 15;
  const creditsPerSecond = selectedResolution.creditsPerSecond;
  const requiredCredits = durationSec * creditsPerSecond;
  const hasEnoughCredits = user.credits >= requiredCredits;
  const remainingCredits = user.credits - requiredCredits;

  const runtime = workerStatus ?? studioConfig?.workerStatus ?? null;
  const isComfyConnected = runtime
    ? runtime.mode === 'bridge'
      ? runtime.connectedWorkers.length > 0
      : Boolean(runtime.tunnelUrl)
    : false;

  function handleSelectFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      onNotify('error', 'Format file harus gambar (PNG, JPG, atau WEBP).');
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      onNotify('error', 'Ukuran gambar maksimal 15 MB.');
      return;
    }
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImageFile(file);
    setImagePreviewUrl(URL.createObjectURL(file));
  }

  function clearImage() {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImageFile(null);
    setImagePreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!imageFile) {
      onNotify('error', 'Unggah gambar referensi terlebih dahulu.');
      return;
    }
    if (prompt.trim().length < 4) {
      onNotify('error', 'Tulis prompt minimal 4 karakter.');
      return;
    }
    if (!hasEnoughCredits) {
      onNotify('error', 'Saldo kredit tidak mencukupi. Silakan Top-Up terlebih dahulu.');
      return;
    }

    setSubmitting(true);
    try {
      const form = new FormData();
      form.append('image', imageFile);
      form.append('prompt', prompt.trim());
      form.append('durationSec', String(durationSec));
      form.append('resolution', resolution);
      form.append('aspectRatio', aspectRatio);

      const res = await apiRequest<{ job: VideoJob; credits: number }>('/api/jobs', {
        method: 'POST',
        body: form,
      });

      onJobCreated(res.job, res.credits);
      setSelectedJobId(res.job.id);
      onNotify(
        'success',
        `Antrean render dibuat (${res.job.durationSec} detik · ${res.job.resolution} · -${res.job.creditsCost} kredit).`
      );
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Gagal mengirim permintaan render.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancelQueued(jobId: string) {
    setCancellingId(jobId);
    try {
      const res = await apiRequest<{ job: VideoJob | null; credits?: number }>(
        `/api/jobs/${encodeURIComponent(jobId)}/cancel`,
        { method: 'POST' }
      );
      if (res.job) onJobUpdated(res.job);
      if (typeof res.credits === 'number') onCreditsUpdated(res.credits);
      onNotify('info', 'Antrean dibatalkan dan kredit telah dikembalikan.');
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Gagal membatalkan antrean.');
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Worker readiness banner only when disconnected */}
      {runtime && !isComfyConnected && (
        <div className="px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/25 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-sm text-amber-200">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              {runtime.mode === 'bridge'
                ? 'Belum ada Bridge Agent ComfyUI lokal yang terhubung. Job baru akan masuk antrean hingga worker online.'
                : 'URL Tunnel ComfyUI belum diatur. Atur URL Tunnel atau beralih ke Bridge Agent di menu Koneksi ComfyUI.'}
            </span>
          </div>
          {user.role === 'admin' && (
            <button
              type="button"
              onClick={() => onNavigate('admin-comfy')}
              className="px-3 py-1.5 text-xs font-medium text-amber-100 bg-amber-500/20 hover:bg-amber-500/30 rounded-md inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Settings2 className="w-3.5 h-3.5" />
              <span>Atur Koneksi ComfyUI</span>
            </button>
          )}
        </div>
      )}

      {/* Main 2-column Studio Workspace */}
      <div className="grid xl:grid-cols-12 gap-6 items-start">
        {/* Left: Simple Ref-to-Video Controls */}
        <form
          onSubmit={handleGenerate}
          className="xl:col-span-5 bg-[#121721] border border-[#232C3D] rounded-xl p-6 space-y-6"
        >
          <div className="flex items-baseline justify-between gap-4 border-b border-[#1E2636] pb-4">
            <div>
              <h1 className="font-display text-lg font-semibold text-white">Studio Ref-to-Video</h1>
              <p className="text-xs text-slate-400 mt-0.5">
                MiniMax H3 Ref2VA · 24 fps dengan audio
              </p>
            </div>
            <span className="text-xs font-mono tabular-nums text-cyan-400 whitespace-nowrap">
              {selectedResolution.id} · {creditsPerSecond} kredit / detik
            </span>
          </div>

          {/* 1. Reference Image Upload */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-slate-300">Gambar Referensi</label>
              {imageFile && (
                <button
                  type="button"
                  onClick={clearImage}
                  className="text-xs text-slate-400 hover:text-rose-400 inline-flex items-center gap-1 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>Hapus</span>
                </button>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => handleSelectFile(e.target.files?.[0])}
              className="hidden"
            />

            {imagePreviewUrl ? (
              <div className="relative rounded-lg overflow-hidden border border-[#2A3548] bg-[#0B0E14]">
                <img
                  src={imagePreviewUrl}
                  alt="Pratinjau gambar referensi"
                  referrerPolicy="no-referrer"
                  className="w-full h-52 object-contain bg-[#0B0E14]"
                />
                <div className="px-3 py-2 border-t border-[#1E2636] flex items-center justify-between text-xs text-slate-400">
                  <span className="truncate max-w-[240px]">{imageFile?.name}</span>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="text-cyan-400 hover:text-cyan-300 font-medium cursor-pointer whitespace-nowrap"
                  >
                    Ganti Gambar
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  handleSelectFile(e.dataTransfer.files?.[0]);
                }}
                className={`w-full h-44 rounded-lg border border-dashed flex flex-col items-center justify-center gap-2.5 px-4 transition-colors cursor-pointer ${
                  dragOver
                    ? 'border-cyan-400 bg-cyan-500/10'
                    : 'border-[#2A3548] bg-[#0B0E14]/60 hover:border-slate-500'
                }`}
              >
                <div className="w-10 h-10 rounded-lg bg-[#181F2C] border border-[#232C3D] flex items-center justify-center text-slate-300">
                  <ImagePlus className="w-5 h-5" />
                </div>
                <div className="text-center space-y-0.5">
                  <p className="text-sm font-medium text-slate-200">
                    Pilih atau tarik gambar referensi ke sini
                  </p>
                  <p className="text-xs text-slate-500">PNG, JPG, WEBP · Maksimal 15 MB</p>
                </div>
              </button>
            )}
          </div>

          {/* 2. Prompt */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="studio-prompt" className="text-xs font-medium text-slate-300">
                Prompt Adegan & Audio
              </label>
              <span className="text-xs font-mono tabular-nums text-slate-500">
                {prompt.length} karakter
              </span>
            </div>
            <textarea
              id="studio-prompt"
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Deskripsikan gerakan subjek dari gambar referensi, pergerakan kamera, pencahayaan, serta suara latar yang diinginkan..."
              className="w-full p-3.5 bg-[#0B0E14] border border-[#232C3D] rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 transition-colors resize-y leading-relaxed"
            />
          </div>

          {/* 3. Resolution Tier */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-medium text-slate-300">Resolusi Output</label>
              <span className="text-xs font-mono tabular-nums text-slate-400">
                {creditsPerSecond} kredit / detik
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#0B0E14] border border-[#1E2636] rounded-lg">
              {resolutionPresets.map((resOpt) => {
                const active = resolution === resOpt.id;
                return (
                  <button
                    key={resOpt.id}
                    type="button"
                    onClick={() => setResolution(resOpt.id)}
                    className={`py-2 px-2 rounded-md text-center transition-colors cursor-pointer ${
                      active
                        ? 'bg-[#181F2C] text-white border border-cyan-500/40'
                        : 'text-slate-400 hover:text-slate-200 border border-transparent'
                    }`}
                  >
                    <span className="block text-xs font-semibold font-mono tabular-nums">
                      {resOpt.id}
                    </span>
                    <span className="block text-[11px] font-mono tabular-nums text-slate-400 mt-0.5">
                      {resOpt.creditsPerSecond} kr / dtk
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 4. Aspect Ratio */}
          <div className="space-y-2">
            <label className="block text-xs font-medium text-slate-300">Rasio Aspek</label>
            <div className="grid grid-cols-5 gap-1.5 p-1 bg-[#0B0E14] border border-[#1E2636] rounded-lg">
              {aspectPresets.map((preset) => {
                const active = aspectRatio === preset.id;
                const dims = preset.dimensions[resolution];
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setAspectRatio(preset.id)}
                    className={`py-2 px-1 rounded-md text-center transition-colors cursor-pointer ${
                      active
                        ? 'bg-[#181F2C] text-white border border-cyan-500/40'
                        : 'text-slate-400 hover:text-slate-200 border border-transparent'
                    }`}
                  >
                    <span className="block text-xs font-semibold font-mono tabular-nums">
                      {preset.id}
                    </span>
                    <span className="block text-[10px] font-mono tabular-nums text-slate-500 mt-0.5">
                      {dims.width}×{dims.height}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 4. Duration (1 credit / second) */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label htmlFor="duration-slider" className="text-xs font-medium text-slate-300">
                Durasi Video
              </label>
              <span className="text-sm font-mono font-semibold tabular-nums text-cyan-400">
                {durationSec} detik · {requiredCredits} kredit
              </span>
            </div>

            <input
              id="duration-slider"
              type="range"
              min={minSec}
              max={maxSec}
              step={1}
              value={durationSec}
              onChange={(e) => setDurationSec(Number(e.target.value))}
              className="w-full accent-cyan-400 cursor-pointer"
            />

            <div className="flex items-center justify-between gap-1.5">
              {[3, 5, 8, 10, 15].map((sec) => (
                <button
                  key={sec}
                  type="button"
                  onClick={() => setDurationSec(sec)}
                  className={`flex-1 py-1.5 text-xs font-mono tabular-nums rounded-md border transition-colors cursor-pointer ${
                    durationSec === sec
                      ? 'bg-[#181F2C] border-cyan-500/40 text-white'
                      : 'bg-[#0B0E14] border-[#1E2636] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {sec}d
                </button>
              ))}
            </div>
          </div>

          {/* Cost breakdown & submit */}
          <div className="pt-4 border-t border-[#1E2636] space-y-3">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Saldo saat ini</span>
              <span className="font-mono tabular-nums text-slate-200">{user.credits} kredit</span>
            </div>
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>
                Biaya render ({durationSec} detik × {creditsPerSecond} kredit/{selectedResolution.id})
              </span>
              <span className="font-mono tabular-nums text-white">-{requiredCredits} kredit</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Perkiraan sisa saldo</span>
              <span
                className={`font-mono tabular-nums font-semibold ${
                  hasEnoughCredits ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {hasEnoughCredits ? `${remainingCredits} kredit` : 'Saldo tidak cukup'}
              </span>
            </div>

            {hasEnoughCredits ? (
              <button
                type="submit"
                disabled={submitting || !imageFile || prompt.trim().length < 4}
                className="w-full h-11 px-4 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-45 disabled:cursor-not-allowed text-[#071117] font-semibold text-sm rounded-lg flex items-center justify-center gap-2 transition-colors cursor-pointer whitespace-nowrap"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Mengirim ke Antrean...</span>
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4" />
                    <span>Generate Video — {requiredCredits} Kredit</span>
                  </>
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate('billing')}
                className="w-full h-11 px-4 bg-amber-500 hover:bg-amber-400 text-[#0B0E14] font-semibold text-sm rounded-lg transition-colors cursor-pointer whitespace-nowrap"
              >
                Top-Up Kredit via Midtrans
              </button>
            )}
          </div>
        </form>

        {/* Right: Focal Preview Stage & Live Render Progress */}
        <section className="xl:col-span-7 space-y-6">
          <div className="bg-[#121721] border border-[#232C3D] rounded-xl overflow-hidden">
            {/* Stage Header */}
            <div className="px-6 py-4 border-b border-[#1E2636] flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-semibold text-white">
                  {activeJob ? 'Pratinjau & Progres Render' : 'Panggung Output Video'}
                </h2>
                {activeJob && (
                  <p className="text-xs text-slate-400 mt-0.5 font-mono tabular-nums">
                    {activeJob.id} · {activeJob.durationSec}d · {activeJob.resolution} · {activeJob.aspectRatio} ({activeJob.width}×{activeJob.height}) · {activeJob.creditsCost} kredit
                  </p>
                )}
              </div>

              {activeJob && (
                <div className="flex items-center gap-3 text-xs">
                  <span className={`font-medium ${jobStatusLabel(activeJob.status).colorClass}`}>
                    {jobStatusLabel(activeJob.status).label}
                  </span>
                  {activeJob.status === 'completed' && activeJob.outputVideoUrl && (
                    <a
                      href={activeJob.outputVideoUrl}
                      download={`${activeJob.id}.mp4`}
                      className="px-3 py-1.5 bg-[#181F2C] hover:bg-[#222B3C] border border-[#2A3548] rounded-md text-slate-100 font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Unduh MP4</span>
                    </a>
                  )}
                </div>
              )}
            </div>

            {/* Stage Body */}
            <div className="p-6">
              {!activeJob ? (
                <div className="h-[420px] rounded-lg border border-dashed border-[#232C3D] bg-[#0B0E14]/60 flex flex-col items-center justify-center text-center px-6 space-y-4">
                  <div className="w-12 h-12 rounded-xl bg-[#181F2C] border border-[#232C3D] flex items-center justify-center text-slate-400">
                    <Film className="w-6 h-6" />
                  </div>
                  <div className="space-y-1.5 max-w-md">
                    <h3 className="font-display text-base font-semibold text-white">
                      Siap merender video Ref-to-Video pertama Anda
                    </h3>
                    <p className="text-sm text-slate-400 leading-relaxed">
                      Unggah gambar referensi, masukkan deskripsi gerakan dan audio, pilih rasio aspek dan durasi, lalu klik Generate. Progres node ComfyUI akan tampil secara langsung di sini.
                    </p>
                  </div>
                  {runtime && (
                    <p className="text-xs text-slate-400 font-mono">
                      Mode ComfyUI:{' '}
                      <span className="text-slate-200">
                        {runtime.mode === 'bridge' ? 'Bridge Agent WebSocket' : 'Direct Tunnel URL'}
                      </span>
                      {' · '}
                      <span className={isComfyConnected ? 'text-emerald-400' : 'text-amber-400'}>
                        {isComfyConnected
                          ? runtime.mode === 'bridge'
                            ? `${runtime.connectedWorkers.length} worker terhubung`
                            : 'Tunnel terkonfigurasi'
                          : 'Menunggu koneksi lokal'}
                      </span>
                    </p>
                  )}
                </div>
              ) : activeJob.status === 'completed' && activeJob.outputVideoUrl ? (
                <div className="space-y-4">
                  <div className="rounded-lg overflow-hidden bg-black border border-[#1E2636] flex items-center justify-center">
                    <video
                      key={activeJob.outputVideoUrl}
                      src={activeJob.outputVideoUrl}
                      controls
                      playsInline
                      className="w-full max-h-[500px] bg-black"
                    />
                  </div>
                  <div className="flex flex-wrap items-start justify-between gap-4 pt-1">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <img
                        src={activeJob.refImageUrl}
                        alt="Referensi"
                        referrerPolicy="no-referrer"
                        className="w-12 h-12 rounded-md object-cover border border-[#232C3D] shrink-0"
                      />
                      <div className="min-w-0">
                        <p className="text-xs text-slate-400">Prompt</p>
                        <p className="text-sm text-slate-200 line-clamp-2 mt-0.5">{activeJob.prompt}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPrompt(activeJob.prompt)}
                      className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-[#181F2C] border border-[#2A3548] rounded-md inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Pakai Prompt</span>
                    </button>
                  </div>
                </div>
              ) : activeJob.status === 'failed' ? (
                <div className="h-[360px] rounded-lg bg-[#0B0E14] border border-rose-500/25 flex flex-col items-center justify-center text-center px-6 space-y-4">
                  <AlertCircle className="w-8 h-8 text-rose-400" />
                  <div className="space-y-1.5 max-w-md">
                    <h3 className="font-display text-base font-semibold text-white">
                      Proses Render Gagal
                    </h3>
                    <p className="text-sm text-rose-300/90 leading-relaxed">
                      {activeJob.errorMessage || 'Terjadi kesalahan saat eksekusi ComfyUI.'}
                    </p>
                    {activeJob.creditsRefunded && (
                      <p className="text-xs text-emerald-400 pt-1">
                        Saldo +{activeJob.creditsCost} kredit telah dikembalikan otomatis ke akun Anda.
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setPrompt(activeJob.prompt)}
                    className="px-4 py-2 text-xs font-medium text-white bg-[#181F2C] hover:bg-[#222B3C] border border-[#2A3548] rounded-lg cursor-pointer"
                  >
                    Muat Ulang Prompt ke Editor
                  </button>
                </div>
              ) : (
                /* Active Queue / Uploading / Running live WebSocket progress */
                <div className="h-[380px] rounded-lg bg-[#0B0E14] border border-[#1E2636] flex flex-col items-center justify-center px-8 space-y-6">
                  <div className="flex items-center gap-4">
                    <img
                      src={activeJob.refImageUrl}
                      alt="Referensi aktif"
                      referrerPolicy="no-referrer"
                      className="w-16 h-16 rounded-lg object-cover border border-[#2A3548]"
                    />
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-white">
                        <Loader2 className="w-4 h-4 text-cyan-400 animate-spin" />
                        <span>{activeJob.statusMessage || 'Memproses di ComfyUI...'}</span>
                      </div>
                      <p className="text-xs text-slate-400 font-mono">
                        {activeJob.currentNode
                          ? `Node aktif: ${activeJob.currentNode}`
                          : activeJob.status === 'queued'
                            ? 'Menunggu worker ComfyUI mengambil antrean'
                            : 'Menghubungkan ke pipeline MiniMax H3'}
                      </p>
                    </div>
                  </div>

                  <div className="w-full max-w-md space-y-2">
                    <div className="h-2 w-full rounded-full bg-[#181F2C] overflow-hidden">
                      <div
                        className="h-full bg-cyan-400 transition-all duration-300"
                        style={{ width: `${Math.max(4, activeJob.progress)}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs font-mono tabular-nums text-slate-400">
                      <span>Progres WebSocket</span>
                      <span className="text-white">{activeJob.progress}%</span>
                    </div>
                  </div>

                  {activeJob.status === 'queued' && (
                    <button
                      type="button"
                      disabled={cancellingId === activeJob.id}
                      onClick={() => handleCancelQueued(activeJob.id)}
                      className="px-4 py-2 text-xs font-medium text-rose-300 hover:text-rose-200 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 rounded-lg transition-colors cursor-pointer"
                    >
                      {cancellingId === activeJob.id
                        ? 'Membatalkan...'
                        : `Batalkan Antrean & Refund ${activeJob.creditsCost} Kredit`}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Recent jobs quick selector */}
          {jobs.length > 0 && (
            <div className="bg-[#121721] border border-[#232C3D] rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-display text-sm font-semibold text-white">Render Terbaru</h3>
                <button
                  type="button"
                  onClick={() => onNavigate('gallery')}
                  className="text-xs text-cyan-400 hover:text-cyan-300 cursor-pointer"
                >
                  Lihat Semua Galeri
                </button>
              </div>

              <div className="divide-y divide-[#1E2636]">
                {jobs.slice(0, 5).map((job) => {
                  const st = jobStatusLabel(job.status);
                  const isSelected = activeJob?.id === job.id;
                  return (
                    <button
                      key={job.id}
                      type="button"
                      onClick={() => setSelectedJobId(job.id)}
                      className={`w-full py-3 px-2.5 flex items-center justify-between gap-4 text-left transition-colors rounded-md cursor-pointer ${
                        isSelected ? 'bg-[#181F2C]' : 'hover:bg-[#181F2C]/50'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="relative w-10 h-10 rounded-md overflow-hidden border border-[#232C3D] bg-[#0B0E14] shrink-0">
                          <img
                            src={job.refImageUrl}
                            alt={job.refImageOriginalName}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover"
                          />
                          {job.status === 'completed' && (
                            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                              <Play className="w-3.5 h-3.5 text-white fill-white" />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm text-slate-200 truncate">{job.prompt}</p>
                          <p className="text-xs text-slate-400 font-mono tabular-nums mt-0.5">
                            {job.durationSec}d · {job.resolution} · {job.aspectRatio} · {job.creditsCost} kr · {formatDateTime(job.createdAt)}
                          </p>
                        </div>
                      </div>
                      <span className={`text-xs font-medium whitespace-nowrap shrink-0 ${st.colorClass}`}>
                        {job.status === 'running' ? `${job.progress}%` : st.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
