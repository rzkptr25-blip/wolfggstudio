import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import {
  db,
  failJobAndRefundTx,
  getSetting,
  OUTPUTS_DIR,
  REFS_DIR,
} from './db.ts';
import type { VideoJobRecord } from './db.ts';
import { buildInjectedWorkflow, getNodeTitleMap } from './workflow.ts';

interface ClientSocketEntry {
  ws: WebSocket;
  userId: string;
  role: 'user' | 'admin';
  alive: boolean;
}

interface WorkerSocketEntry {
  ws: WebSocket;
  workerId: string;
  name: string;
  comfyUrl: string;
  connectedAt: string;
  lastHeartbeatAt: string;
  currentJobId: string | null;
  alive: boolean;
}

export interface WorkerRuntimeStatus {
  mode: 'bridge' | 'tunnel';
  connectedWorkers: Array<{
    workerId: string;
    name: string;
    comfyUrl: string;
    connectedAt: string;
    busy: boolean;
    currentJobId: string | null;
  }>;
  tunnelUrl: string;
  tunnelReachable: boolean | null;
  tunnelLastCheckedAt: string | null;
  readyForGeneration: boolean;
  queuedJobsCount: number;
}

const clientSockets = new Set<ClientSocketEntry>();
const workerSockets = new Map<string, WorkerSocketEntry>();

let tunnelBusy = false;
let lastTunnelReachable: boolean | null = null;
let lastTunnelCheckedAt: string | null = null;

const nodeTitles = getNodeTitleMap();

// Heartbeat interval to detect dead sockets
setInterval(() => {
  for (const client of clientSockets) {
    if (!client.alive) {
      client.ws.terminate();
      clientSockets.delete(client);
      continue;
    }
    client.alive = false;
    try {
      client.ws.ping();
    } catch {
      clientSockets.delete(client);
    }
  }

  let workerChanged = false;
  for (const [id, worker] of workerSockets.entries()) {
    if (!worker.alive) {
      worker.ws.terminate();
      workerSockets.delete(id);
      workerChanged = true;
      if (worker.currentJobId) {
        handleWorkerDisconnectJob(worker.currentJobId);
      }
      continue;
    }
    worker.alive = false;
    try {
      worker.ws.ping();
    } catch {
      workerSockets.delete(id);
      workerChanged = true;
    }
  }
  if (workerChanged) {
    broadcastWorkerStatus();
  }
}, 25000).unref();

function sendJson(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function registerClientSocket(ws: WebSocket, userId: string, role: 'user' | 'admin') {
  const entry: ClientSocketEntry = { ws, userId, role, alive: true };
  clientSockets.add(entry);

  ws.on('pong', () => {
    entry.alive = true;
  });

  ws.on('close', () => {
    clientSockets.delete(entry);
  });

  ws.on('error', () => {
    clientSockets.delete(entry);
  });

  // Immediately sync worker status
  sendJson(ws, { type: 'worker:status', data: getWorkerRuntimeStatus() });
}

export function broadcastJobUpdate(job: VideoJobRecord) {
  const payload = { type: 'job:update', data: formatJobForClient(job) };
  for (const client of clientSockets) {
    if (client.userId === job.user_id || client.role === 'admin') {
      sendJson(client.ws, payload);
    }
  }
}

export function broadcastBalanceUpdate(userId: string, credits: number, reason?: string) {
  const payload = { type: 'balance:update', data: { userId, credits, reason } };
  for (const client of clientSockets) {
    if (client.userId === userId) {
      sendJson(client.ws, payload);
    }
  }
}

export function broadcastWorkerStatus() {
  const payload = { type: 'worker:status', data: getWorkerRuntimeStatus() };
  for (const client of clientSockets) {
    sendJson(client.ws, payload);
  }
}

export function formatJobForClient(job: VideoJobRecord) {
  return {
    id: job.id,
    userId: job.user_id,
    userName: job.user_name,
    userEmail: job.user_email,
    refImageUrl: `/api/media/refs/${encodeURIComponent(job.ref_image_filename)}`,
    refImageOriginalName: job.ref_image_original_name,
    prompt: job.prompt,
    durationSec: job.duration_sec,
    creditsCost: job.credits_cost,
    creditsRefunded: job.credits_refunded === 1,
    resolution: job.resolution || '480p',
    aspectRatio: job.aspect_ratio,
    width: job.width,
    height: job.height,
    seed: job.seed,
    status: job.status,
    progress: job.progress,
    currentNode: job.current_node,
    statusMessage: job.status_message,
    comfyPromptId: job.comfy_prompt_id,
    workerId: job.worker_id,
    outputVideoUrl: job.output_filename
      ? `/api/media/outputs/${encodeURIComponent(job.output_filename)}`
      : null,
    errorMessage: job.error_message,
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
  };
}

export function getWorkerRuntimeStatus(): WorkerRuntimeStatus {
  const mode = (getSetting('comfy_mode') === 'tunnel' ? 'tunnel' : 'bridge') as 'bridge' | 'tunnel';
  const tunnelUrl = getSetting('comfy_tunnel_url').trim();
  const workers = Array.from(workerSockets.values()).map((w) => ({
    workerId: w.workerId,
    name: w.name,
    comfyUrl: w.comfyUrl,
    connectedAt: w.connectedAt,
    busy: w.currentJobId !== null,
    currentJobId: w.currentJobId,
  }));

  const queuedJobsCount = (
    db.prepare(`SELECT COUNT(*) as c FROM video_jobs WHERE status = 'queued'`).get() as { c: number }
  ).c;

  const readyForGeneration =
    mode === 'bridge' ? workers.length > 0 : Boolean(tunnelUrl);

  return {
    mode,
    connectedWorkers: workers,
    tunnelUrl,
    tunnelReachable: lastTunnelReachable,
    tunnelLastCheckedAt: lastTunnelCheckedAt,
    readyForGeneration,
    queuedJobsCount,
  };
}

function handleWorkerDisconnectJob(jobId: string) {
  const { job, refundedUserId, newBalance } = failJobAndRefundTx(
    jobId,
    'Bridge Agent ComfyUI lokal terputus sebelum render selesai.'
  );
  if (job) broadcastJobUpdate(job);
  if (refundedUserId && typeof newBalance === 'number') {
    broadcastBalanceUpdate(refundedUserId, newBalance, 'Kredit dikembalikan otomatis karena worker terputus');
  }
}

export function registerWorkerSocket(ws: WebSocket, meta: { name: string; comfyUrl: string }) {
  const workerId = `wrk_${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();
  const entry: WorkerSocketEntry = {
    ws,
    workerId,
    name: meta.name || 'Local ComfyUI Worker',
    comfyUrl: meta.comfyUrl || 'http://127.0.0.1:8188',
    connectedAt: now,
    lastHeartbeatAt: now,
    currentJobId: null,
    alive: true,
  };
  workerSockets.set(workerId, entry);

  sendJson(ws, {
    type: 'worker:welcome',
    workerId,
    message: 'Terhubung ke Kinetik Studio WebSocket Server',
  });

  broadcastWorkerStatus();
  void processNextQueuedJob();

  ws.on('pong', () => {
    entry.alive = true;
    entry.lastHeartbeatAt = new Date().toISOString();
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        type: string;
        jobId?: string;
        status?: 'uploading' | 'running' | 'completed' | 'failed';
        progress?: number;
        currentNode?: string;
        statusMessage?: string;
        comfyPromptId?: string;
        error?: string;
      };

      entry.alive = true;
      entry.lastHeartbeatAt = new Date().toISOString();

      if (msg.type === 'worker:heartbeat') {
        sendJson(ws, { type: 'worker:heartbeat_ack', ts: Date.now() });
        return;
      }

      if (msg.type === 'job:progress' && msg.jobId) {
        const nextStatus = msg.status === 'uploading' ? 'uploading' : 'running';
        const progress = Math.max(0, Math.min(99, Math.round(msg.progress ?? 0)));
        const nodeLabel = msg.currentNode ? nodeTitles[msg.currentNode] || msg.currentNode : null;

        db.prepare(
          `UPDATE video_jobs
           SET status = ?,
               progress = ?,
               current_node = COALESCE(?, current_node),
               status_message = COALESCE(?, status_message),
               comfy_prompt_id = COALESCE(?, comfy_prompt_id),
               started_at = COALESCE(started_at, datetime('now'))
           WHERE id = ? AND status NOT IN ('completed', 'failed')`
        ).run(
          nextStatus,
          progress,
          nodeLabel,
          msg.statusMessage || null,
          msg.comfyPromptId || null,
          msg.jobId
        );

        const updated = db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(msg.jobId) as
          | VideoJobRecord
          | undefined;
        if (updated) broadcastJobUpdate(updated);
        return;
      }

      if (msg.type === 'job:error' && msg.jobId) {
        if (entry.currentJobId === msg.jobId) {
          entry.currentJobId = null;
        }
        const { job, refundedUserId, newBalance } = failJobAndRefundTx(
          msg.jobId,
          msg.error || 'Terjadi kesalahan saat eksekusi workflow di ComfyUI lokal.'
        );
        if (job) broadcastJobUpdate(job);
        if (refundedUserId && typeof newBalance === 'number') {
          broadcastBalanceUpdate(refundedUserId, newBalance, 'Pengembalian kredit otomatis (render gagal)');
        }
        broadcastWorkerStatus();
        void processNextQueuedJob();
      }
    } catch (err) {
      console.error('[Worker WS] Invalid message:', err);
    }
  });

  ws.on('close', () => {
    const activeJob = entry.currentJobId;
    workerSockets.delete(workerId);
    if (activeJob) {
      handleWorkerDisconnectJob(activeJob);
    }
    broadcastWorkerStatus();
  });

  ws.on('error', () => {
    const activeJob = entry.currentJobId;
    workerSockets.delete(workerId);
    if (activeJob) {
      handleWorkerDisconnectJob(activeJob);
    }
    broadcastWorkerStatus();
  });
}

export function markBridgeJobCompleted(jobId: string, outputFilename: string) {
  for (const worker of workerSockets.values()) {
    if (worker.currentJobId === jobId) {
      worker.currentJobId = null;
    }
  }

  db.prepare(
    `UPDATE video_jobs
     SET status = 'completed',
         progress = 100,
         output_filename = ?,
         status_message = 'Video berhasil dirender',
         completed_at = datetime('now')
     WHERE id = ?`
  ).run(outputFilename, jobId);

  const job = db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(jobId) as VideoJobRecord | undefined;
  if (job) broadcastJobUpdate(job);
  broadcastWorkerStatus();
  void processNextQueuedJob();
}

export async function processNextQueuedJob() {
  const mode = getSetting('comfy_mode') === 'tunnel' ? 'tunnel' : 'bridge';

  if (mode === 'bridge') {
    const idleWorker = Array.from(workerSockets.values()).find(
      (w) => w.currentJobId === null && w.ws.readyState === WebSocket.OPEN
    );
    if (!idleWorker) return;

    const nextJob = db
      .prepare(`SELECT * FROM video_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`)
      .get() as VideoJobRecord | undefined;
    if (!nextJob) return;

    idleWorker.currentJobId = nextJob.id;
    db.prepare(
      `UPDATE video_jobs
       SET status = 'uploading',
           progress = 5,
           worker_id = ?,
           status_message = 'Mengirim gambar referensi ke ComfyUI lokal...',
           started_at = datetime('now')
       WHERE id = ?`
    ).run(idleWorker.workerId, nextJob.id);

    const updatedJob = db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(nextJob.id) as VideoJobRecord;
    broadcastJobUpdate(updatedJob);
    broadcastWorkerStatus();

    const workflow = buildInjectedWorkflow({
      jobId: nextJob.id,
      uploadedImageName: '__REF_IMAGE_PLACEHOLDER__',
      prompt: nextJob.prompt,
      durationSec: nextJob.duration_sec,
      width: nextJob.width,
      height: nextJob.height,
      seed: nextJob.seed,
    });

    sendJson(idleWorker.ws, {
      type: 'job:dispatch',
      job: {
        id: nextJob.id,
        refImagePath: `/api/worker/jobs/${nextJob.id}/ref-image`,
        refImageFilename: nextJob.ref_image_filename,
        uploadResultPath: `/api/worker/jobs/${nextJob.id}/upload-result`,
        workflow,
        nodeTitles,
      },
    });
    return;
  }

  // Tunnel mode
  if (tunnelBusy) return;
  const tunnelUrl = getSetting('comfy_tunnel_url').trim();
  if (!tunnelUrl) return;

  const nextJob = db
    .prepare(`SELECT * FROM video_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`)
    .get() as VideoJobRecord | undefined;
  if (!nextJob) return;

  tunnelBusy = true;
  try {
    await executeJobViaTunnel(nextJob, tunnelUrl, getSetting('comfy_tunnel_auth_header').trim());
  } finally {
    tunnelBusy = false;
    broadcastWorkerStatus();
    void processNextQueuedJob();
  }
}

function buildTunnelHeaders(authHeader: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (authHeader) {
    headers['Authorization'] = authHeader;
  }
  return headers;
}

export async function testDirectTunnelConnection(
  tunnelUrl: string,
  authHeader: string
): Promise<{ ok: boolean; message: string; systemInfo?: Record<string, unknown> }> {
  const baseUrl = tunnelUrl.replace(/\/$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, message: 'URL Tunnel harus diawali http:// atau https://' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${baseUrl}/system_stats`, {
      method: 'GET',
      headers: buildTunnelHeaders(authHeader),
      signal: controller.signal,
    });
    lastTunnelCheckedAt = new Date().toISOString();
    if (!res.ok) {
      lastTunnelReachable = false;
      broadcastWorkerStatus();
      return { ok: false, message: `ComfyUI merespons HTTP ${res.status}` };
    }
    const data = (await res.json()) as Record<string, unknown>;
    lastTunnelReachable = true;
    broadcastWorkerStatus();
    return { ok: true, message: 'Terhubung ke ComfyUI melalui Tunnel', systemInfo: data };
  } catch (err) {
    lastTunnelCheckedAt = new Date().toISOString();
    lastTunnelReachable = false;
    broadcastWorkerStatus();
    return {
      ok: false,
      message: err instanceof Error ? `Gagal menjangkau ComfyUI: ${err.message}` : 'Gagal menjangkau ComfyUI',
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function executeJobViaTunnel(job: VideoJobRecord, rawTunnelUrl: string, authHeader: string) {
  const baseUrl = rawTunnelUrl.replace(/\/$/, '');
  const headers = buildTunnelHeaders(authHeader);
  const clientId = `kinetik_${crypto.randomBytes(6).toString('hex')}`;

  const updateJob = (patch: {
    status?: VideoJobRecord['status'];
    progress?: number;
    currentNode?: string | null;
    statusMessage?: string;
    comfyPromptId?: string;
  }) => {
    db.prepare(
      `UPDATE video_jobs
       SET status = COALESCE(?, status),
           progress = COALESCE(?, progress),
           current_node = COALESCE(?, current_node),
           status_message = COALESCE(?, status_message),
           comfy_prompt_id = COALESCE(?, comfy_prompt_id),
           worker_id = 'direct-tunnel',
           started_at = COALESCE(started_at, datetime('now'))
       WHERE id = ?`
    ).run(
      patch.status ?? null,
      patch.progress ?? null,
      patch.currentNode ?? null,
      patch.statusMessage ?? null,
      patch.comfyPromptId ?? null,
      job.id
    );
    const updated = db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(job.id) as VideoJobRecord;
    if (updated) broadcastJobUpdate(updated);
  };

  let comfyWs: WebSocket | null = null;

  try {
    updateJob({
      status: 'uploading',
      progress: 5,
      statusMessage: 'Mengunggah gambar referensi ke ComfyUI Tunnel...',
    });

    // 1. Upload reference image to ComfyUI /upload/image
    const refFilePath = path.join(REFS_DIR, job.ref_image_filename);
    const fileBuf = fs.readFileSync(refFilePath);
    const form = new FormData();
    form.append('image', new Blob([fileBuf]), job.ref_image_filename);
    form.append('overwrite', 'true');

    const uploadRes = await fetch(`${baseUrl}/upload/image`, {
      method: 'POST',
      headers,
      body: form,
    });
    if (!uploadRes.ok) {
      throw new Error(`Upload gambar referensi ke ComfyUI gagal (HTTP ${uploadRes.status})`);
    }
    const uploadJson = (await uploadRes.json()) as { name?: string };
    const comfyImageName = uploadJson.name || job.ref_image_filename;

    // 2. Open WebSocket to ComfyUI /ws
    const wsUrl = baseUrl.replace(/^http/i, 'ws') + `/ws?clientId=${encodeURIComponent(clientId)}`;
    comfyWs = new WebSocket(wsUrl, { headers });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout koneksi WebSocket ComfyUI Tunnel')), 15000);
      comfyWs!.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      comfyWs!.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // 3. Submit injected REF2VA workflow to /prompt
    const workflow = buildInjectedWorkflow({
      jobId: job.id,
      uploadedImageName: comfyImageName,
      prompt: job.prompt,
      durationSec: job.duration_sec,
      width: job.width,
      height: job.height,
      seed: job.seed,
    });

    updateJob({
      status: 'running',
      progress: 10,
      statusMessage: 'Mengirim workflow MiniMax H3 Ref2VA ke ComfyUI...',
    });

    const promptRes = await fetch(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    });
    if (!promptRes.ok) {
      const errText = await promptRes.text();
      throw new Error(`ComfyUI menolak prompt (HTTP ${promptRes.status}): ${errText.slice(0, 200)}`);
    }
    const promptJson = (await promptRes.json()) as { prompt_id?: string };
    if (!promptJson.prompt_id) {
      throw new Error('ComfyUI tidak mengembalikan prompt_id');
    }
    const promptId = promptJson.prompt_id;
    updateJob({ comfyPromptId: promptId, progress: 12, statusMessage: 'Antrean ComfyUI diterima...' });

    // 4. Stream execution & progress over ComfyUI WS until completion
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Batas waktu render ComfyUI terlampaui (20 menit)')), 20 * 60 * 1000);

      comfyWs!.on('message', (data) => {
        if (Buffer.isBuffer(data) && data.length > 0 && data[0] !== 123) {
          // Binary preview frame — ignore
          return;
        }
        try {
          const parsed = JSON.parse(data.toString()) as {
            type: string;
            data?: {
              prompt_id?: string;
              node?: string | null;
              value?: number;
              max?: number;
              exception_message?: string;
            };
          };

          if (parsed.data?.prompt_id && parsed.data.prompt_id !== promptId) {
            return;
          }

          if (parsed.type === 'executing') {
            const nodeId = parsed.data?.node;
            if (nodeId === null) {
              clearTimeout(timeout);
              resolve();
              return;
            }
            if (nodeId) {
              const title = nodeTitles[nodeId] || `Node ${nodeId}`;
              updateJob({
                status: 'running',
                currentNode: title,
                statusMessage: `Menjalankan ${title}...`,
              });
            }
          } else if (parsed.type === 'progress') {
            const val = Number(parsed.data?.value ?? 0);
            const max = Math.max(1, Number(parsed.data?.max ?? 1));
            const pct = Math.min(92, Math.max(15, Math.round(15 + (val / max) * 75)));
            updateJob({
              status: 'running',
              progress: pct,
              statusMessage: `Sampling diffusion langkah ${val}/${max}...`,
            });
          } else if (parsed.type === 'execution_error') {
            clearTimeout(timeout);
            reject(new Error(parsed.data?.exception_message || 'ComfyUI execution_error'));
          }
        } catch {
          // Ignore malformed non-JSON messages
        }
      });

      comfyWs!.on('close', () => {
        clearTimeout(timeout);
        reject(new Error('Koneksi WebSocket ke ComfyUI terputus sebelum selesai'));
      });

      comfyWs!.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    comfyWs.close();
    comfyWs = null;

    // 5. Fetch history & download generated video
    updateJob({ progress: 94, statusMessage: 'Mengunduh video hasil render dari ComfyUI...' });
    const historyRes = await fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`, { headers });
    if (!historyRes.ok) {
      throw new Error(`Gagal mengambil history ComfyUI (HTTP ${historyRes.status})`);
    }
    const historyJson = (await historyRes.json()) as Record<
      string,
      { outputs?: Record<string, { videos?: Array<{ filename: string; subfolder?: string; type?: string }>; gifs?: Array<{ filename: string; subfolder?: string; type?: string }>; images?: Array<{ filename: string; subfolder?: string; type?: string }> }> }
    >;

    const outputs = historyJson[promptId]?.outputs || {};
    let targetFile: { filename: string; subfolder?: string; type?: string } | undefined;

    for (const nodeOutput of Object.values(outputs)) {
      const list = nodeOutput.videos || nodeOutput.gifs || nodeOutput.images;
      if (list && list.length > 0) {
        targetFile = list[0];
        break;
      }
    }

    if (!targetFile) {
      throw new Error('Output video tidak ditemukan pada history ComfyUI (Node SaveVideo).');
    }

    const viewParams = new URLSearchParams({
      filename: targetFile.filename,
      subfolder: targetFile.subfolder || '',
      type: targetFile.type || 'output',
    });

    const videoRes = await fetch(`${baseUrl}/view?${viewParams.toString()}`, { headers });
    if (!videoRes.ok) {
      throw new Error(`Gagal mengunduh file output video (HTTP ${videoRes.status})`);
    }

    const ext = path.extname(targetFile.filename) || '.mp4';
    const savedFilename = `${job.id}${ext}`;
    const videoBuf = Buffer.from(await videoRes.arrayBuffer());
    fs.writeFileSync(path.join(OUTPUTS_DIR, savedFilename), videoBuf);

    db.prepare(
      `UPDATE video_jobs
       SET status = 'completed',
           progress = 100,
           output_filename = ?,
           status_message = 'Video berhasil dirender',
           completed_at = datetime('now')
       WHERE id = ?`
    ).run(savedFilename, job.id);

    const completedJob = db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(job.id) as VideoJobRecord;
    broadcastJobUpdate(completedJob);
  } catch (err) {
    if (comfyWs) {
      try {
        comfyWs.close();
      } catch {
        // ignore
      }
    }
    const errMsg = err instanceof Error ? err.message : 'Kesalahan tidak diketahui pada ComfyUI Tunnel';
    const { job: failedJob, refundedUserId, newBalance } = failJobAndRefundTx(job.id, errMsg);
    if (failedJob) broadcastJobUpdate(failedJob);
    if (refundedUserId && typeof newBalance === 'number') {
      broadcastBalanceUpdate(refundedUserId, newBalance, 'Pengembalian kredit otomatis (render gagal)');
    }
  }
}

export function generateBridgeAgentScript(params: {
  appUrl: string;
  workerToken: string;
}): string {
  const cleanHttpUrl = params.appUrl.replace(/\/$/, '');
  const cleanWsUrl = cleanHttpUrl.replace(/^http/i, 'ws') + '/ws/worker';

  return `#!/usr/bin/env node
/**
 * Kinetik Studio — Local ComfyUI WebSocket Bridge Agent
 * Jalankan di PC lokal yang menjalankan ComfyUI (Node.js v22+ tanpa perlu npm install).
 *
 * Cara pakai:
 *   node comfy-worker-agent.mjs
 *
 * Variabel lingkungan opsional:
 *   COMFYUI_URL=http://127.0.0.1:8188
 *   WORKER_NAME="GPU-Lokal-Utama"
 */

import crypto from 'node:crypto';
import os from 'node:os';

const SERVER_HTTP_URL = process.env.KINETIK_SERVER_URL || ${JSON.stringify(cleanHttpUrl)};
const SERVER_WS_URL = process.env.KINETIK_WS_URL || ${JSON.stringify(cleanWsUrl)};
const WORKER_TOKEN = process.env.KINETIK_WORKER_TOKEN || ${JSON.stringify(params.workerToken)};
const COMFYUI_URL = (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\\/$/, '');
const WORKER_NAME = process.env.WORKER_NAME || os.hostname();

if (typeof globalThis.WebSocket === 'undefined') {
  console.error('[Kinetik Agent] Butuh Node.js v22 atau lebih baru (built-in WebSocket).');
  process.exit(1);
}

let serverWs = null;
let heartbeatTimer = null;

function sendToServer(obj) {
  if (serverWs && serverWs.readyState === WebSocket.OPEN) {
    serverWs.send(JSON.stringify(obj));
  }
}

async function runComfyJob(job) {
  const clientId = 'agent_' + crypto.randomBytes(6).toString('hex');
  console.log(\`[Kinetik Agent] Memulai job \${job.id}...\`);

  try {
    // 1. Unduh gambar referensi dari server Kinetik
    sendToServer({
      type: 'job:progress',
      jobId: job.id,
      status: 'uploading',
      progress: 8,
      statusMessage: 'Mengunduh gambar referensi ke PC ComfyUI lokal...',
    });

    const refRes = await fetch(\`\${SERVER_HTTP_URL}\${job.refImagePath}\`, {
      headers: { 'X-Worker-Token': WORKER_TOKEN },
    });
    if (!refRes.ok) throw new Error(\`Gagal mengunduh gambar referensi (HTTP \${refRes.status})\`);
    const refBuf = await refRes.arrayBuffer();

    // 2. Unggah gambar referensi ke ComfyUI lokal (/upload/image)
    const uploadForm = new FormData();
    uploadForm.append('image', new Blob([refBuf]), job.refImageFilename || 'ref.png');
    uploadForm.append('overwrite', 'true');

    const comfyUploadRes = await fetch(\`\${COMFYUI_URL}/upload/image\`, {
      method: 'POST',
      body: uploadForm,
    });
    if (!comfyUploadRes.ok) {
      throw new Error(\`Upload ke ComfyUI lokal gagal (HTTP \${comfyUploadRes.status})\`);
    }
    const comfyUploadJson = await comfyUploadRes.json();
    const uploadedName = comfyUploadJson.name || job.refImageFilename;

    // Injeksi nama gambar lokal ke Node 102 (LoadImage)
    const workflow = structuredClone(job.workflow);
    if (workflow['102'] && workflow['102'].inputs) {
      workflow['102'].inputs.image = uploadedName;
    }

    // 3. Koneksi WebSocket ke ComfyUI lokal
    const comfyWsUrl = COMFYUI_URL.replace(/^http/i, 'ws') + \`/ws?clientId=\${encodeURIComponent(clientId)}\`;
    const comfyWs = new WebSocket(comfyWsUrl);

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout koneksi WebSocket ComfyUI lokal')), 10000);
      comfyWs.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      comfyWs.addEventListener('error', () => { clearTimeout(t); reject(new Error('Gagal terhubung ke ComfyUI lokal di ' + COMFYUI_URL)); }, { once: true });
    });

    // 4. Kirim workflow ke /prompt
    sendToServer({
      type: 'job:progress',
      jobId: job.id,
      status: 'running',
      progress: 12,
      statusMessage: 'Mengirim workflow MiniMax H3 Ref2VA ke ComfyUI lokal...',
    });

    const promptRes = await fetch(\`\${COMFYUI_URL}/prompt\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    });
    if (!promptRes.ok) {
      const txt = await promptRes.text();
      comfyWs.close();
      throw new Error(\`ComfyUI menolak workflow (HTTP \${promptRes.status}): \${txt.slice(0, 200)}\`);
    }
    const { prompt_id: promptId } = await promptRes.json();

    sendToServer({
      type: 'job:progress',
      jobId: job.id,
      status: 'running',
      progress: 15,
      comfyPromptId: promptId,
      statusMessage: 'Workflow masuk antrean GPU lokal...',
    });

    // 5. Pantau progres render secara real-time
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Render melebihi batas waktu 20 menit')), 20 * 60 * 1000);

      comfyWs.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.data?.prompt_id && msg.data.prompt_id !== promptId) return;

          if (msg.type === 'executing') {
            if (msg.data?.node === null) {
              clearTimeout(timer);
              resolve();
              return;
            }
            const title = (job.nodeTitles && job.nodeTitles[msg.data.node]) || msg.data.node;
            sendToServer({
              type: 'job:progress',
              jobId: job.id,
              status: 'running',
              currentNode: title,
              statusMessage: \`Menjalankan \${title}...\`,
            });
          } else if (msg.type === 'progress') {
            const v = Number(msg.data?.value || 0);
            const m = Math.max(1, Number(msg.data?.max || 1));
            const pct = Math.min(92, Math.max(15, Math.round(15 + (v / m) * 75)));
            sendToServer({
              type: 'job:progress',
              jobId: job.id,
              status: 'running',
              progress: pct,
              statusMessage: \`Sampling diffusion langkah \${v}/\${m}...\`,
            });
          } else if (msg.type === 'execution_error') {
            clearTimeout(timer);
            reject(new Error(msg.data?.exception_message || 'ComfyUI execution_error'));
          }
        } catch {}
      });

      comfyWs.addEventListener('close', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket ComfyUI lokal terputus'));
      });
    });

    comfyWs.close();

    // 6. Ambil hasil video dari /history & /view
    sendToServer({
      type: 'job:progress',
      jobId: job.id,
      status: 'running',
      progress: 94,
      statusMessage: 'Mengunggah video hasil render ke server web...',
    });

    const histRes = await fetch(\`\${COMFYUI_URL}/history/\${encodeURIComponent(promptId)}\`);
    const histJson = await histRes.json();
    const outputs = histJson[promptId]?.outputs || {};
    let fileInfo = null;
    for (const out of Object.values(outputs)) {
      const list = out.videos || out.gifs || out.images;
      if (list && list.length > 0) {
        fileInfo = list[0];
        break;
      }
    }
    if (!fileInfo) throw new Error('File video output tidak ditemukan di history ComfyUI.');

    const qs = new URLSearchParams({
      filename: fileInfo.filename,
      subfolder: fileInfo.subfolder || '',
      type: fileInfo.type || 'output',
    });
    const vidRes = await fetch(\`\${COMFYUI_URL}/view?\${qs.toString()}\`);
    if (!vidRes.ok) throw new Error(\`Gagal membaca video dari ComfyUI (HTTP \${vidRes.status})\`);
    const vidBuf = await vidRes.arrayBuffer();

    // 7. Unggah video selesai ke server Kinetik
    const resultForm = new FormData();
    resultForm.append('video', new Blob([vidBuf], { type: 'video/mp4' }), fileInfo.filename);

    const pushRes = await fetch(\`\${SERVER_HTTP_URL}\${job.uploadResultPath}\`, {
      method: 'POST',
      headers: { 'X-Worker-Token': WORKER_TOKEN },
      body: resultForm,
    });
    if (!pushRes.ok) {
      throw new Error(\`Gagal mengunggah hasil video ke server (HTTP \${pushRes.status})\`);
    }

    console.log(\`[Kinetik Agent] Job \${job.id} selesai dan terkirim!\`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(\`[Kinetik Agent] Job \${job.id} gagal:\`, message);
    sendToServer({ type: 'job:error', jobId: job.id, error: message });
  }
}

function connectToServer() {
  const url = new URL(SERVER_WS_URL);
  url.searchParams.set('token', WORKER_TOKEN);
  url.searchParams.set('name', WORKER_NAME);
  url.searchParams.set('comfyUrl', COMFYUI_URL);

  console.log(\`[Kinetik Agent] Menghubungkan ke \${SERVER_WS_URL} (ComfyUI: \${COMFYUI_URL})...\`);
  serverWs = new WebSocket(url.toString());

  serverWs.addEventListener('open', () => {
    console.log('[Kinetik Agent] Terhubung ke Kinetik Studio! Menunggu antrean job Ref-to-Video...');
    heartbeatTimer = setInterval(() => {
      sendToServer({ type: 'worker:heartbeat' });
    }, 15000);
  });

  serverWs.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(String(event.data));
      if (msg.type === 'job:dispatch' && msg.job) {
        void runComfyJob(msg.job);
      }
    } catch (err) {
      console.error('[Kinetik Agent] Pesan server tidak valid:', err);
    }
  });

  serverWs.addEventListener('close', (e) => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    console.warn(\`[Kinetik Agent] Koneksi terputus (code \${e.code}). Menyambung ulang dalam 4 detik...\`);
    setTimeout(connectToServer, 4000);
  });

  serverWs.addEventListener('error', () => {
    // Akan ditangani oleh event close
  });
}

connectToServer();
`;
}
