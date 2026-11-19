import 'dotenv/config';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import http from 'http';
import multer from 'multer';
import path from 'path';
import { WebSocketServer } from 'ws';

import {
  adminAdjustCreditsTx,
  createSession,
  createVideoJobTx,
  db,
  deleteSession,
  failJobAndRefundTx,
  getSetting,
  getUserBySessionToken,
  hashPassword,
  OUTPUTS_DIR,
  REFS_DIR,
  registerUserTx,
  setSetting,
  settleMidtransOrderTx,
  SIGNUP_BONUS_CREDITS,
  verifyPassword,
} from './server/db.ts';
import type {
  LedgerRecord,
  PaymentRecord,
  UserRecord,
  VideoJobRecord,
} from './server/db.ts';
import {
  broadcastBalanceUpdate,
  broadcastJobUpdate,
  broadcastWorkerStatus,
  formatJobForClient,
  generateBridgeAgentScript,
  getWorkerRuntimeStatus,
  markBridgeJobCompleted,
  processNextQueuedJob,
  registerClientSocket,
  registerWorkerSocket,
  testDirectTunnelConnection,
} from './server/comfyOrchestrator.ts';
import {
  CREDIT_PACKAGES,
  createMidtransSnapTransaction,
  fetchMidtransOrderStatus,
  getCreditPackageById,
  getMidtransConfig,
  mapMidtransStatus,
  verifyMidtransSignature,
} from './server/midtrans.ts';
import type { MidtransStatusPayload } from './server/midtrans.ts';
import {
  ASPECT_RATIO_PRESETS,
  CREDITS_PER_SECOND,
  DURATION_MAX_SEC,
  DURATION_MIN_SEC,
  getWorkflowSummary,
  RESOLUTION_PRESETS,
  resolveResolutionPreset,
  resolveVideoDimensions,
} from './server/workflow.ts';

declare global {
  namespace Express {
    interface Request {
      user?: UserRecord;
      sessionToken?: string;
    }
  }
}

const PORT = Number(process.env.PORT) || 3000;
const SESSION_COOKIE_NAME = 'kinetik_session';

function getAppUrl(req?: Request): string {
  if (process.env.APP_URL && process.env.APP_URL.trim() && process.env.APP_URL !== 'MY_APP_URL') {
    return process.env.APP_URL.replace(/\/$/, '');
  }
  if (req) {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || `localhost:${PORT}`;
    return `${proto}://${host}`;
  }
  return `http://localhost:${PORT}`;
}

function extractSessionToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req.cookies?.[SESSION_COOKIE_NAME]) {
    return String(req.cookies[SESSION_COOKIE_NAME]);
  }
  return undefined;
}

function setSessionCookie(res: Response, token: string) {
  const isHttps = (process.env.APP_URL || '').startsWith('https://') || process.env.NODE_ENV === 'production';
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: isHttps ? 'none' : 'lax',
    secure: isHttps,
    maxAge: 14 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractSessionToken(req);
  const user = getUserBySessionToken(token);
  if (!user) {
    res.status(401).json({ error: 'Sesi tidak valid atau telah berakhir. Silakan masuk kembali.' });
    return;
  }
  if (user.status !== 'active') {
    res.status(403).json({ error: 'Akun Anda sedang ditangguhkan oleh administrator.' });
    return;
  }
  req.user = user;
  req.sessionToken = token;
  next();
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Akses khusus Administrator.' });
      return;
    }
    next();
  });
}

function requireWorkerToken(req: Request, res: Response, next: NextFunction) {
  const provided = String(req.headers['x-worker-token'] || req.query.token || '').trim();
  const expected = getSetting('comfy_worker_token');
  if (!provided || !expected || provided.length !== expected.length) {
    res.status(401).json({ error: 'Token worker tidak valid.' });
    return;
  }
  if (!crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    res.status(401).json({ error: 'Token worker tidak valid.' });
    return;
  }
  next();
}

// Multer storage for reference images
const refImageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, REFS_DIR),
    filename: (_req, file, cb) => {
      const safeExt = (path.extname(file.originalname) || '.png').toLowerCase().replace(/[^.a-z0-9]/g, '');
      const allowedExt = ['.png', '.jpg', '.jpeg', '.webp'].includes(safeExt) ? safeExt : '.png';
      cb(null, `ref_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${allowedExt}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      cb(new Error('Hanya file gambar (PNG, JPG, WEBP) yang diizinkan.'));
      return;
    }
    cb(null, true);
  },
});

// Multer storage for rendered video results uploaded by Bridge Agent
const workerVideoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, OUTPUTS_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.mp4').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.mp4';
      cb(null, `${req.params.id}${ext}`);
    },
  }),
  limits: { fileSize: 250 * 1024 * 1024 },
});

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use(express.json({ limit: '5mb' }));

  // =========================================================================
  // AUTH & ACCOUNT MANAGEMENT
  // =========================================================================
  app.post('/api/auth/register', (req, res) => {
    try {
      const { name, email, password } = req.body as {
        name?: string;
        email?: string;
        password?: string;
      };

      if (!name || name.trim().length < 2) {
        res.status(400).json({ error: 'Nama minimal 2 karakter.' });
        return;
      }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        res.status(400).json({ error: 'Format email tidak valid.' });
        return;
      }
      if (!password || password.length < 6) {
        res.status(400).json({ error: 'Kata sandi minimal 6 karakter.' });
        return;
      }

      const user = registerUserTx({ name, email, password });
      const token = createSession(user.id);
      setSessionCookie(res, token);

      res.status(201).json({
        user,
        token,
        bonusCredits: SIGNUP_BONUS_CREDITS,
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'EMAIL_EXISTS') {
        res.status(409).json({ error: 'Email sudah terdaftar. Silakan masuk menggunakan akun tersebut.' });
        return;
      }
      console.error('[Register]', err);
      res.status(500).json({ error: 'Gagal mendaftarkan akun.' });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    try {
      const { email, password } = req.body as { email?: string; password?: string };
      if (!email || !password) {
        res.status(400).json({ error: 'Email dan kata sandi wajib diisi.' });
        return;
      }

      const row = db
        .prepare('SELECT * FROM users WHERE email = ?')
        .get(email.trim().toLowerCase()) as (UserRecord & { password_hash: string }) | undefined;

      if (!row || !verifyPassword(password, row.password_hash)) {
        res.status(401).json({ error: 'Email atau kata sandi salah.' });
        return;
      }

      if (row.status !== 'active') {
        res.status(403).json({ error: 'Akun Anda sedang ditangguhkan. Hubungi administrator.' });
        return;
      }

      const token = createSession(row.id);
      setSessionCookie(res, token);

      const { password_hash: _ph, ...user } = row;
      res.json({ user, token });
    } catch (err) {
      console.error('[Login]', err);
      res.status(500).json({ error: 'Gagal memproses login.' });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = extractSessionToken(req);
    if (token) deleteSession(token);
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  app.patch('/api/auth/profile', requireAuth, (req, res) => {
    const { name } = req.body as { name?: string };
    if (!name || name.trim().length < 2 || name.trim().length > 80) {
      res.status(400).json({ error: 'Nama harus antara 2 hingga 80 karakter.' });
      return;
    }
    db.prepare(`UPDATE users SET name = ?, updated_at = datetime('now') WHERE id = ?`).run(
      name.trim(),
      req.user!.id
    );
    const updated = db
      .prepare('SELECT id, name, email, role, status, credits, created_at, updated_at FROM users WHERE id = ?')
      .get(req.user!.id) as UserRecord;
    res.json({ user: updated });
  });

  app.patch('/api/auth/password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (!currentPassword || !newPassword || newPassword.length < 6) {
      res.status(400).json({ error: 'Kata sandi baru minimal 6 karakter.' });
      return;
    }

    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as
      | { password_hash: string }
      | undefined;
    if (!row || !verifyPassword(currentPassword, row.password_hash)) {
      res.status(400).json({ error: 'Kata sandi saat ini tidak cocok.' });
      return;
    }

    db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(
      hashPassword(newPassword),
      req.user!.id
    );
    res.json({ ok: true });
  });

  // =========================================================================
  // STUDIO CONFIG & VIDEO JOBS
  // =========================================================================
  app.get('/api/studio/config', requireAuth, (_req, res) => {
    res.json({
      workflow: getWorkflowSummary(),
      resolutions: RESOLUTION_PRESETS,
      aspectRatios: ASPECT_RATIO_PRESETS,
      durationMin: DURATION_MIN_SEC,
      durationMax: DURATION_MAX_SEC,
      creditsPerSecond: CREDITS_PER_SECOND,
      workerStatus: getWorkerRuntimeStatus(),
    });
  });

  app.get('/api/jobs', requireAuth, (req, res) => {
    const statusFilter = String(req.query.status || 'all');
    let rows: VideoJobRecord[];
    if (statusFilter !== 'all' && ['queued', 'uploading', 'running', 'completed', 'failed'].includes(statusFilter)) {
      rows = db
        .prepare('SELECT * FROM video_jobs WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 100')
        .all(req.user!.id, statusFilter) as VideoJobRecord[];
    } else {
      rows = db
        .prepare('SELECT * FROM video_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
        .all(req.user!.id) as VideoJobRecord[];
    }
    res.json({ jobs: rows.map(formatJobForClient) });
  });

  app.post('/api/jobs', requireAuth, refImageUpload.single('image'), (req, res) => {
    const file = req.file;
    try {
      if (!file) {
        res.status(400).json({ error: 'Gambar referensi wajib diunggah.' });
        return;
      }

      const prompt = String(req.body.prompt || '').trim();
      const durationSec = Number(req.body.durationSec);
      const resolutionId = String(req.body.resolution || '480p');
      const aspectRatioId = String(req.body.aspectRatio || '9:16');

      if (!prompt || prompt.length < 4) {
        fs.unlinkSync(file.path);
        res.status(400).json({ error: 'Prompt minimal 4 karakter.' });
        return;
      }

      if (!Number.isInteger(durationSec) || durationSec < DURATION_MIN_SEC || durationSec > DURATION_MAX_SEC) {
        fs.unlinkSync(file.path);
        res.status(400).json({
          error: `Durasi harus bilangan bulat antara ${DURATION_MIN_SEC} hingga ${DURATION_MAX_SEC} detik.`,
        });
        return;
      }

      const resolutionPreset = resolveResolutionPreset(resolutionId);
      if (!resolutionPreset) {
        fs.unlinkSync(file.path);
        res.status(400).json({ error: 'Resolusi tidak valid. Pilih 480p, 720p, atau 1080p.' });
        return;
      }

      const preset = ASPECT_RATIO_PRESETS.find((p) => p.id === aspectRatioId);
      if (!preset) {
        fs.unlinkSync(file.path);
        res.status(400).json({ error: 'Rasio aspek tidak valid.' });
        return;
      }

      const { width, height } = resolveVideoDimensions(resolutionPreset.id, preset.id);
      const creditsCost = durationSec * resolutionPreset.creditsPerSecond;

      const seed = crypto.randomInt(1, 2_147_483_647) * 1000 + crypto.randomInt(0, 999);
      const { job, newBalance } = createVideoJobTx({
        userId: req.user!.id,
        refImageFilename: file.filename,
        refImageOriginalName: file.originalname,
        prompt,
        durationSec,
        resolution: resolutionPreset.id,
        creditsCost,
        aspectRatio: preset.id,
        width,
        height,
        seed,
      });

      broadcastJobUpdate(job);
      broadcastBalanceUpdate(
        req.user!.id,
        newBalance,
        `Debit ${creditsCost} kredit (${durationSec}d · ${resolutionPreset.id})`
      );
      broadcastWorkerStatus();
      void processNextQueuedJob();

      res.status(201).json({
        job: formatJobForClient(job),
        credits: newBalance,
      });
    } catch (err) {
      if (file && fs.existsSync(file.path)) {
        try {
          fs.unlinkSync(file.path);
        } catch {
          // ignore
        }
      }
      if (err instanceof Error && err.message === 'INSUFFICIENT_CREDITS') {
        res.status(402).json({ error: 'Saldo kredit tidak mencukupi. Silakan Top-Up melalui Midtrans.' });
        return;
      }
      console.error('[Create Job]', err);
      res.status(500).json({ error: 'Gagal membuat antrean render video.' });
    }
  });

  app.post('/api/jobs/:id/cancel', requireAuth, (req, res) => {
    const job = db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(req.params.id) as
      | VideoJobRecord
      | undefined;
    if (!job || (job.user_id !== req.user!.id && req.user!.role !== 'admin')) {
      res.status(404).json({ error: 'Job tidak ditemukan.' });
      return;
    }
    if (job.status !== 'queued') {
      res.status(400).json({ error: 'Hanya job yang masih dalam antrean (queued) yang dapat dibatalkan.' });
      return;
    }

    const { job: updated, refundedUserId, newBalance } = failJobAndRefundTx(
      job.id,
      'Dibatalkan oleh pengguna sebelum diproses worker.'
    );
    if (updated) broadcastJobUpdate(updated);
    if (refundedUserId && typeof newBalance === 'number') {
      broadcastBalanceUpdate(refundedUserId, newBalance, 'Kredit dikembalikan (antrean dibatalkan)');
    }
    broadcastWorkerStatus();
    res.json({ job: updated ? formatJobForClient(updated) : null, credits: newBalance });
  });

  app.delete('/api/jobs/:id', requireAuth, (req, res) => {
    const job = db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(req.params.id) as
      | VideoJobRecord
      | undefined;
    if (!job || (job.user_id !== req.user!.id && req.user!.role !== 'admin')) {
      res.status(404).json({ error: 'Job tidak ditemukan.' });
      return;
    }
    if (job.status === 'uploading' || job.status === 'running') {
      res.status(400).json({ error: 'Tidak dapat menghapus job yang sedang berjalan.' });
      return;
    }
    if (job.status === 'queued') {
      failJobAndRefundTx(job.id, 'Dihapus saat masih dalam antrean.');
    }

    const refPath = path.join(REFS_DIR, job.ref_image_filename);
    if (fs.existsSync(refPath)) fs.unlinkSync(refPath);
    if (job.output_filename) {
      const outPath = path.join(OUTPUTS_DIR, job.output_filename);
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    }

    db.prepare('DELETE FROM video_jobs WHERE id = ?').run(job.id);
    res.json({ ok: true });
  });

  // =========================================================================
  // WORKER AGENT MEDIA TRANSFER ENDPOINTS (Protected by Worker Token)
  // =========================================================================
  app.get('/api/worker/jobs/:id/ref-image', requireWorkerToken, (req, res) => {
    const job = db.prepare('SELECT ref_image_filename FROM video_jobs WHERE id = ?').get(req.params.id) as
      | { ref_image_filename: string }
      | undefined;
    if (!job) {
      res.status(404).json({ error: 'Job tidak ditemukan' });
      return;
    }
    const filePath = path.join(REFS_DIR, path.basename(job.ref_image_filename));
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'File referensi tidak ditemukan' });
      return;
    }
    res.sendFile(filePath);
  });

  app.post(
    '/api/worker/jobs/:id/upload-result',
    requireWorkerToken,
    workerVideoUpload.single('video'),
    (req, res) => {
      if (!req.file) {
        res.status(400).json({ error: 'File video output wajib dikirim.' });
        return;
      }
      markBridgeJobCompleted(String(req.params.id), req.file.filename);
      res.json({ ok: true, filename: req.file.filename });
    }
  );

  // =========================================================================
  // PROTECTED MEDIA SERVING (Refs & Rendered MP4 with Range support)
  // =========================================================================
  app.get('/api/media/refs/:filename', requireAuth, (req, res) => {
    const safeName = path.basename(String(req.params.filename));
    const job = db.prepare('SELECT user_id FROM video_jobs WHERE ref_image_filename = ?').get(safeName) as
      | { user_id: string }
      | undefined;
    if (!job || (job.user_id !== req.user!.id && req.user!.role !== 'admin')) {
      res.status(404).end();
      return;
    }
    const fullPath = path.join(REFS_DIR, safeName);
    if (!fs.existsSync(fullPath)) {
      res.status(404).end();
      return;
    }
    res.sendFile(fullPath);
  });

  app.get('/api/media/outputs/:filename', requireAuth, (req, res) => {
    const safeName = path.basename(String(req.params.filename));
    const job = db.prepare('SELECT user_id FROM video_jobs WHERE output_filename = ?').get(safeName) as
      | { user_id: string }
      | undefined;
    if (!job || (job.user_id !== req.user!.id && req.user!.role !== 'admin')) {
      res.status(404).end();
      return;
    }
    const fullPath = path.join(OUTPUTS_DIR, safeName);
    if (!fs.existsSync(fullPath)) {
      res.status(404).end();
      return;
    }

    const stat = fs.statSync(fullPath);
    const range = req.headers.range;
    const ext = path.extname(safeName).toLowerCase();
    const contentType = ext === '.webm' ? 'video/webm' : 'video/mp4';

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });
      fs.createReadStream(fullPath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(fullPath).pipe(res);
    }
  });

  // =========================================================================
  // BILLING, CREDIT LEDGER & MIDTRANS SNAP + WEBHOOK
  // =========================================================================
  app.get('/api/billing/packages', requireAuth, (req, res) => {
    const cfg = getMidtransConfig();
    res.json({
      packages: CREDIT_PACKAGES,
      resolutions: RESOLUTION_PRESETS,
      creditsPerSecond: CREDITS_PER_SECOND,
      midtrans: {
        configured: cfg.configured,
        isProduction: cfg.isProduction,
        clientKey: cfg.clientKey,
        snapJsUrl: cfg.snapJsUrl,
        webhookUrl: `${getAppUrl(req)}/api/payments/midtrans-webhook`,
      },
    });
  });

  app.get('/api/billing/ledger', requireAuth, (req, res) => {
    const rows = db
      .prepare('SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
      .all(req.user!.id) as LedgerRecord[];
    res.json({ ledger: rows });
  });

  app.get('/api/billing/transactions', requireAuth, (req, res) => {
    const rows = db
      .prepare('SELECT * FROM payment_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(req.user!.id) as PaymentRecord[];
    res.json({ transactions: rows });
  });

  app.post('/api/payments/create', requireAuth, async (req, res) => {
    try {
      const { packageId } = req.body as { packageId?: string };
      const pkg = getCreditPackageById(String(packageId || ''));
      if (!pkg) {
        res.status(400).json({ error: 'Paket kredit tidak valid.' });
        return;
      }

      const cfg = getMidtransConfig();
      if (!cfg.configured) {
        res.status(503).json({
          error:
            'Kredensial Midtrans (MIDTRANS_SERVER_KEY & MIDTRANS_CLIENT_KEY) belum dikonfigurasi di environment server (.env).',
        });
        return;
      }

      const orderId = `KNTK-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

      const snap = await createMidtransSnapTransaction({
        orderId,
        grossAmount: pkg.priceIdr,
        pkg,
        customer: { name: req.user!.name, email: req.user!.email },
        appUrl: getAppUrl(req),
      });

      db.prepare(
        `INSERT INTO payment_transactions (
          order_id, user_id, package_id, package_name, credits, gross_amount,
          snap_token, snap_redirect_url, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
      ).run(
        orderId,
        req.user!.id,
        pkg.id,
        pkg.name,
        pkg.credits,
        pkg.priceIdr,
        snap.token,
        snap.redirect_url
      );

      const transaction = db
        .prepare('SELECT * FROM payment_transactions WHERE order_id = ?')
        .get(orderId) as PaymentRecord;

      res.status(201).json({
        orderId,
        snapToken: snap.token,
        redirectUrl: snap.redirect_url,
        transaction,
      });
    } catch (err) {
      console.error('[Midtrans Create]', err);
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Gagal membuat transaksi Midtrans Snap.',
      });
    }
  });

  // Reconcile pending order directly with Midtrans Core Status API
  app.post('/api/payments/:orderId/sync', requireAuth, async (req, res) => {
    try {
      const orderId = String(req.params.orderId);
      const existing = db
        .prepare('SELECT * FROM payment_transactions WHERE order_id = ?')
        .get(orderId) as PaymentRecord | undefined;

      if (!existing || (existing.user_id !== req.user!.id && req.user!.role !== 'admin')) {
        res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
        return;
      }

      if (existing.status === 'settlement') {
        const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(existing.user_id) as {
          credits: number;
        };
        res.json({ transaction: existing, credits: user.credits, creditedNow: false });
        return;
      }

      const statusData = await fetchMidtransOrderStatus(orderId);
      const mappedStatus = mapMidtransStatus(statusData.transaction_status, statusData.fraud_status);

      const result = settleMidtransOrderTx({
        orderId,
        newStatus: mappedStatus,
        paymentType: statusData.payment_type || null,
        transactionId: statusData.transaction_id || null,
        rawNotification: JSON.stringify(statusData),
      });

      if (result.creditedNow && result.payment && typeof result.newBalance === 'number') {
        broadcastBalanceUpdate(
          result.payment.user_id,
          result.newBalance,
          `Pembayaran Midtrans berhasil (+${result.payment.credits} kredit)`
        );
      }

      const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(existing.user_id) as {
        credits: number;
      };
      res.json({
        transaction: result.payment,
        credits: user.credits,
        creditedNow: result.creditedNow,
      });
    } catch (err) {
      console.error('[Midtrans Sync]', err);
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Gagal sinkronisasi status Midtrans.',
      });
    }
  });

  // Official Midtrans HTTP Notification Webhook (SHA-512 verified & idempotent)
  app.post('/api/payments/midtrans-webhook', (req, res) => {
    try {
      const payload = req.body as MidtransStatusPayload;
      if (!verifyMidtransSignature(payload)) {
        res.status(403).json({ error: 'Invalid Midtrans SHA-512 signature_key' });
        return;
      }

      const mappedStatus = mapMidtransStatus(payload.transaction_status, payload.fraud_status);
      const result = settleMidtransOrderTx({
        orderId: payload.order_id,
        newStatus: mappedStatus,
        paymentType: payload.payment_type || null,
        transactionId: payload.transaction_id || null,
        rawNotification: JSON.stringify(payload),
      });

      if (!result.payment) {
        res.status(404).json({ error: 'Order not found' });
        return;
      }

      if (result.creditedNow && typeof result.newBalance === 'number') {
        broadcastBalanceUpdate(
          result.payment.user_id,
          result.newBalance,
          `Top-up Midtrans terkonfirmasi (+${result.payment.credits} kredit)`
        );
      }

      res.json({ ok: true, status: result.payment.status });
    } catch (err) {
      console.error('[Midtrans Webhook]', err);
      res.status(500).json({ error: 'Webhook processing error' });
    }
  });

  // =========================================================================
  // ADMIN PANEL (Account Management, ComfyUI Bridge/Tunnel, Jobs & Billing)
  // =========================================================================
  app.get('/api/admin/overview', requireAdmin, (_req, res) => {
    const userStats = db
      .prepare(
        `SELECT COUNT(*) as totalUsers,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as activeUsers,
                COALESCE(SUM(credits), 0) as totalCreditsCirculating
         FROM users`
      )
      .get() as { totalUsers: number; activeUsers: number; totalCreditsCirculating: number };

    const jobStats = db
      .prepare(
        `SELECT COUNT(*) as totalJobs,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completedJobs,
                SUM(CASE WHEN status IN ('queued','uploading','running') THEN 1 ELSE 0 END) as activeJobs,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failedJobs
         FROM video_jobs`
      )
      .get() as { totalJobs: number; completedJobs: number; activeJobs: number; failedJobs: number };

    const revenueStats = db
      .prepare(
        `SELECT COUNT(*) as settledCount,
                COALESCE(SUM(gross_amount), 0) as totalRevenueIdr,
                COALESCE(SUM(credits), 0) as totalCreditsSold
         FROM payment_transactions WHERE status = 'settlement'`
      )
      .get() as { settledCount: number; totalRevenueIdr: number; totalCreditsSold: number };

    res.json({
      users: userStats,
      jobs: jobStats,
      revenue: revenueStats,
      workerStatus: getWorkerRuntimeStatus(),
    });
  });

  app.get('/api/admin/users', requireAdmin, (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const rows = q
      ? (db
          .prepare(
            `SELECT id, name, email, role, status, credits, created_at, updated_at
             FROM users
             WHERE LOWER(name) LIKE ? OR LOWER(email) LIKE ?
             ORDER BY created_at DESC`
          )
          .all(`%${q}%`, `%${q}%`) as UserRecord[])
      : (db
          .prepare(
            `SELECT id, name, email, role, status, credits, created_at, updated_at
             FROM users ORDER BY created_at DESC`
          )
          .all() as UserRecord[]);

    res.json({ users: rows });
  });

  app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
    const targetId = String(req.params.id);
    const { role, status } = req.body as { role?: 'user' | 'admin'; status?: 'active' | 'suspended' };

    if (targetId === req.user!.id && (role === 'user' || status === 'suspended')) {
      res.status(400).json({ error: 'Anda tidak dapat menurunkan peran atau menangguhkan akun Anda sendiri.' });
      return;
    }

    const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
    if (!existing) {
      res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
      return;
    }

    if (role && ['user', 'admin'].includes(role)) {
      db.prepare(`UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?`).run(role, targetId);
    }
    if (status && ['active', 'suspended'].includes(status)) {
      db.prepare(`UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, targetId);
    }

    const updated = db
      .prepare('SELECT id, name, email, role, status, credits, created_at, updated_at FROM users WHERE id = ?')
      .get(targetId) as UserRecord;
    res.json({ user: updated });
  });

  app.post('/api/admin/users/:id/credits', requireAdmin, (req, res) => {
    try {
      const targetId = String(req.params.id);
      const delta = Number(req.body.delta);
      const reason = String(req.body.reason || '').trim();

      if (!Number.isInteger(delta) || delta === 0) {
        res.status(400).json({ error: 'Jumlah perubahan kredit harus bilangan bulat selain 0.' });
        return;
      }
      if (reason.length < 3) {
        res.status(400).json({ error: 'Catatan alasan penyesuaian minimal 3 karakter.' });
        return;
      }

      const { user, newBalance } = adminAdjustCreditsTx({
        userId: targetId,
        delta,
        reason,
        adminEmail: req.user!.email,
      });

      broadcastBalanceUpdate(
        targetId,
        newBalance,
        `Penyesuaian saldo oleh admin (${delta > 0 ? `+${delta}` : delta} kredit)`
      );

      res.json({ user });
    } catch (err) {
      if (err instanceof Error && err.message === 'NEGATIVE_BALANCE') {
        res.status(400).json({ error: 'Saldo pengguna tidak boleh kurang dari 0.' });
        return;
      }
      if (err instanceof Error && err.message === 'USER_NOT_FOUND') {
        res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
        return;
      }
      res.status(500).json({ error: 'Gagal menyesuaikan saldo kredit.' });
    }
  });

  app.get('/api/admin/comfy', requireAdmin, (req, res) => {
    const appUrl = getAppUrl(req);
    const wsUrl = appUrl.replace(/^http/i, 'ws') + '/ws/worker';
    res.json({
      mode: getSetting('comfy_mode') === 'tunnel' ? 'tunnel' : 'bridge',
      tunnelUrl: getSetting('comfy_tunnel_url'),
      tunnelAuthHeader: getSetting('comfy_tunnel_auth_header'),
      workerToken: getSetting('comfy_worker_token'),
      workerWsUrl: wsUrl,
      appUrl,
      workflow: getWorkflowSummary(),
      workerStatus: getWorkerRuntimeStatus(),
      midtrans: {
        configured: getMidtransConfig().configured,
        isProduction: getMidtransConfig().isProduction,
        webhookUrl: `${appUrl}/api/payments/midtrans-webhook`,
      },
    });
  });

  app.put('/api/admin/comfy', requireAdmin, (req, res) => {
    const { mode, tunnelUrl, tunnelAuthHeader } = req.body as {
      mode?: 'bridge' | 'tunnel';
      tunnelUrl?: string;
      tunnelAuthHeader?: string;
    };

    if (mode && ['bridge', 'tunnel'].includes(mode)) {
      setSetting('comfy_mode', mode);
    }
    if (typeof tunnelUrl === 'string') {
      setSetting('comfy_tunnel_url', tunnelUrl.trim());
    }
    if (typeof tunnelAuthHeader === 'string') {
      setSetting('comfy_tunnel_auth_header', tunnelAuthHeader.trim());
    }

    broadcastWorkerStatus();
    void processNextQueuedJob();

    res.json({
      ok: true,
      workerStatus: getWorkerRuntimeStatus(),
    });
  });

  app.post('/api/admin/comfy/rotate-token', requireAdmin, (_req, res) => {
    const newToken = `kntk_wrk_${crypto.randomBytes(24).toString('hex')}`;
    setSetting('comfy_worker_token', newToken);
    res.json({ workerToken: newToken });
  });

  app.post('/api/admin/comfy/test-tunnel', requireAdmin, async (req, res) => {
    const tunnelUrl = String(req.body.tunnelUrl ?? getSetting('comfy_tunnel_url')).trim();
    const tunnelAuthHeader = String(req.body.tunnelAuthHeader ?? getSetting('comfy_tunnel_auth_header')).trim();
    const result = await testDirectTunnelConnection(tunnelUrl, tunnelAuthHeader);
    res.json(result);
  });

  app.get('/api/admin/comfy/agent-script', requireAdmin, (req, res) => {
    const script = generateBridgeAgentScript({
      appUrl: getAppUrl(req),
      workerToken: getSetting('comfy_worker_token'),
    });
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="comfy-worker-agent.mjs"');
    res.send(script);
  });

  app.get('/api/admin/jobs', requireAdmin, (_req, res) => {
    const rows = db
      .prepare(
        `SELECT j.*, u.name as user_name, u.email as user_email
         FROM video_jobs j
         JOIN users u ON u.id = j.user_id
         ORDER BY j.created_at DESC
         LIMIT 100`
      )
      .all() as VideoJobRecord[];
    res.json({ jobs: rows.map(formatJobForClient) });
  });

  // Error handler for Multer / JSON parsing
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err) {
      res.status(400).json({ error: err.message || 'Permintaan tidak valid.' });
      return;
    }
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // =========================================================================
  // VITE DEV MIDDLEWARE OR PRODUCTION STATIC DIST
  // =========================================================================
  const distPath = path.resolve(process.cwd(), 'dist');
  const distIndexPath = path.join(distPath, 'index.html');
  const isProduction =
    process.env.NODE_ENV === 'production' ||
    Boolean(process.env.K_SERVICE) ||
    (process.env.NODE_ENV !== 'development' && fs.existsSync(distIndexPath));

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(distIndexPath);
    });
  }

  // =========================================================================
  // HTTP SERVER + WEBSOCKET UPGRADE ROUTING (/ws/client & /ws/worker)
  // =========================================================================
  const server = http.createServer(app);
  const clientWss = new WebSocketServer({ noServer: true });
  const workerWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const reqUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (reqUrl.pathname === '/ws/client') {
      // Authenticate via token query param or cookie
      let token = reqUrl.searchParams.get('token') || undefined;
      if (!token && request.headers.cookie) {
        const match = request.headers.cookie
          .split(';')
          .map((c) => c.trim())
          .find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
        if (match) token = decodeURIComponent(match.slice(SESSION_COOKIE_NAME.length + 1));
      }

      const user = getUserBySessionToken(token);
      if (!user || user.status !== 'active') {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      clientWss.handleUpgrade(request, socket, head, (ws) => {
        registerClientSocket(ws, user.id, user.role);
      });
      return;
    }

    if (reqUrl.pathname === '/ws/worker') {
      const provided = reqUrl.searchParams.get('token') || String(request.headers['x-worker-token'] || '');
      const expected = getSetting('comfy_worker_token');
      const valid =
        Boolean(provided && expected && provided.length === expected.length) &&
        crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

      if (!valid) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const name = reqUrl.searchParams.get('name') || 'Local ComfyUI Worker';
      const comfyUrl = reqUrl.searchParams.get('comfyUrl') || 'http://127.0.0.1:8188';

      workerWss.handleUpgrade(request, socket, head, (ws) => {
        registerWorkerSocket(ws, { name, comfyUrl });
      });
      return;
    }

    // Reject unknown WebSocket paths cleanly (HMR is disabled)
    socket.destroy();
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Kinetik Studio] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[Kinetik Studio] Fatal startup error:', err);
  process.exit(1);
});
