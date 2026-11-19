import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function resolveWritableDataDir(): string {
  const preferred = process.env.DATA_DIR?.trim()
    ? path.resolve(process.env.DATA_DIR.trim())
    : path.resolve(process.cwd(), 'data');
  try {
    fs.mkdirSync(path.join(preferred, 'refs'), { recursive: true });
    fs.mkdirSync(path.join(preferred, 'outputs'), { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    const fallback = path.join('/tmp', 'kinetik-data');
    fs.mkdirSync(path.join(fallback, 'refs'), { recursive: true });
    fs.mkdirSync(path.join(fallback, 'outputs'), { recursive: true });
    return fallback;
  }
}

const DATA_DIR = resolveWritableDataDir();
export const REFS_DIR = path.join(DATA_DIR, 'refs');
export const OUTPUTS_DIR = path.join(DATA_DIR, 'outputs');

const DB_PATH = path.join(DATA_DIR, 'kinetik.db');
export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS credit_ledger (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('signup_bonus', 'topup', 'generation_debit', 'generation_refund', 'admin_adjustment')),
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reference_id TEXT,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payment_transactions (
    order_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    package_id TEXT NOT NULL,
    package_name TEXT NOT NULL,
    credits INTEGER NOT NULL,
    gross_amount INTEGER NOT NULL,
    snap_token TEXT,
    snap_redirect_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'settlement', 'expire', 'cancel', 'deny', 'failure')),
    payment_type TEXT,
    midtrans_transaction_id TEXT,
    raw_notification TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    settled_at TEXT
  );

  CREATE TABLE IF NOT EXISTS video_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ref_image_filename TEXT NOT NULL,
    ref_image_original_name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    duration_sec INTEGER NOT NULL,
    credits_cost INTEGER NOT NULL,
    credits_refunded INTEGER NOT NULL DEFAULT 0,
    resolution TEXT NOT NULL DEFAULT '480p',
    aspect_ratio TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    seed INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'uploading', 'running', 'completed', 'failed')),
    progress INTEGER NOT NULL DEFAULT 0,
    current_node TEXT,
    status_message TEXT,
    comfy_prompt_id TEXT,
    worker_id TEXT,
    output_filename TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_payments_user ON payment_transactions(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_user ON video_jobs(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON video_jobs(status, created_at ASC);
`);

// Safe migration for existing databases created before resolution column existed
const jobColumns = db.prepare(`PRAGMA table_info(video_jobs)`).all() as Array<{ name: string }>;
if (!jobColumns.some((col) => col.name === 'resolution')) {
  db.exec(`ALTER TABLE video_jobs ADD COLUMN resolution TEXT NOT NULL DEFAULT '480p'`);
}

// Seed default settings if absent
function ensureSetting(key: string, defaultValue: string) {
  const existing = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!existing) {
    db.prepare('INSERT INTO system_settings (key, value) VALUES (?, ?)').run(key, defaultValue);
  }
}

const envTunnelUrl = process.env.COMFYUI_TUNNEL_URL?.trim() || '';
const envWorkerToken = process.env.COMFYUI_WORKER_TOKEN?.trim() || '';
const initialWorkerToken = envWorkerToken || `kntk_wrk_${crypto.randomBytes(24).toString('hex')}`;

ensureSetting('comfy_mode', envTunnelUrl ? 'tunnel' : 'bridge');
ensureSetting('comfy_tunnel_url', envTunnelUrl);
ensureSetting('comfy_tunnel_auth_header', '');
ensureSetting('comfy_worker_token', initialWorkerToken);

// If env vars are configured later in Cloud Run / Secrets, sync them when DB values are unset
if (envTunnelUrl) {
  const currentTunnel = (
    db.prepare('SELECT value FROM system_settings WHERE key = ?').get('comfy_tunnel_url') as
      | { value: string }
      | undefined
  )?.value;
  if (!currentTunnel) {
    db.prepare(`UPDATE system_settings SET value = ?, updated_at = datetime('now') WHERE key = 'comfy_tunnel_url'`).run(
      envTunnelUrl
    );
    db.prepare(`UPDATE system_settings SET value = 'tunnel', updated_at = datetime('now') WHERE key = 'comfy_mode'`).run();
  }
}

if (envWorkerToken) {
  db.prepare(`UPDATE system_settings SET value = ?, updated_at = datetime('now') WHERE key = 'comfy_worker_token'`).run(
    envWorkerToken
  );
}

// Password utilities (scrypt)
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, key] = storedHash.split(':');
  if (!salt || !key) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(key, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

// Settings helpers
export function getSetting(key: string): string {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? '';
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, value);
}

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
  credits: number;
  created_at: string;
  updated_at: string;
}

export interface VideoJobRecord {
  id: string;
  user_id: string;
  user_name?: string;
  user_email?: string;
  ref_image_filename: string;
  ref_image_original_name: string;
  prompt: string;
  duration_sec: number;
  credits_cost: number;
  credits_refunded: number;
  resolution: string;
  aspect_ratio: string;
  width: number;
  height: number;
  seed: number;
  status: 'queued' | 'uploading' | 'running' | 'completed' | 'failed';
  progress: number;
  current_node: string | null;
  status_message: string | null;
  comfy_prompt_id: string | null;
  worker_id: string | null;
  output_filename: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface PaymentRecord {
  order_id: string;
  user_id: string;
  package_id: string;
  package_name: string;
  credits: number;
  gross_amount: number;
  snap_token: string | null;
  snap_redirect_url: string | null;
  status: 'pending' | 'settlement' | 'expire' | 'cancel' | 'deny' | 'failure';
  payment_type: string | null;
  midtrans_transaction_id: string | null;
  created_at: string;
  settled_at: string | null;
}

export interface LedgerRecord {
  id: string;
  user_id: string;
  type: 'signup_bonus' | 'topup' | 'generation_debit' | 'generation_refund' | 'admin_adjustment';
  amount: number;
  balance_after: number;
  reference_id: string | null;
  description: string;
  created_at: string;
}

export const SIGNUP_BONUS_CREDITS = 10;

// Atomic user registration (+10 free credits; first account becomes admin)
export const registerUserTx = db.transaction(
  (input: { name: string; email: string; password: string }): UserRecord => {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(input.email.trim().toLowerCase());
    if (existing) {
      throw new Error('EMAIL_EXISTS');
    }

    const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
    const role: 'admin' | 'user' = userCount === 0 ? 'admin' : 'user';
    const userId = `usr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const passwordHash = hashPassword(input.password);

    db.prepare(
      `INSERT INTO users (id, name, email, password_hash, role, status, credits)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`
    ).run(userId, input.name.trim(), input.email.trim().toLowerCase(), passwordHash, role, SIGNUP_BONUS_CREDITS);

    const ledgerId = `ldg_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    db.prepare(
      `INSERT INTO credit_ledger (id, user_id, type, amount, balance_after, reference_id, description)
       VALUES (?, ?, 'signup_bonus', ?, ?, ?, ?)`
    ).run(
      ledgerId,
      userId,
      SIGNUP_BONUS_CREDITS,
      SIGNUP_BONUS_CREDITS,
      userId,
      `Bonus saldo awal pengguna baru (+${SIGNUP_BONUS_CREDITS} kredit)`
    );

    return db
      .prepare('SELECT id, name, email, role, status, credits, created_at, updated_at FROM users WHERE id = ?')
      .get(userId) as UserRecord;
  }
);

// Session creation
export function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return token;
}

export function getUserBySessionToken(token: string | undefined): UserRecord | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.status, u.credits, u.created_at, u.updated_at, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token) as (UserRecord & { expires_at: string }) | undefined;

  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  const { expires_at: _exp, ...user } = row;
  return user;
}

export function deleteSession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// Atomic credit deduction & job creation (480p=1 cr/s, 720p=2 cr/s, 1080p=3 cr/s)
export const createVideoJobTx = db.transaction(
  (input: {
    userId: string;
    refImageFilename: string;
    refImageOriginalName: string;
    prompt: string;
    durationSec: number;
    resolution: string;
    creditsCost: number;
    aspectRatio: string;
    width: number;
    height: number;
    seed: number;
  }): { job: VideoJobRecord; newBalance: number } => {
    const user = db.prepare('SELECT id, credits, status FROM users WHERE id = ?').get(input.userId) as
      | { id: string; credits: number; status: string }
      | undefined;

    if (!user) throw new Error('USER_NOT_FOUND');
    if (user.status !== 'active') throw new Error('ACCOUNT_SUSPENDED');

    const cost = input.creditsCost;
    if (user.credits < cost) {
      throw new Error('INSUFFICIENT_CREDITS');
    }

    const newBalance = user.credits - cost;
    const jobId = `job_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;

    db.prepare(`UPDATE users SET credits = ?, updated_at = datetime('now') WHERE id = ?`).run(
      newBalance,
      input.userId
    );

    db.prepare(
      `INSERT INTO video_jobs (
        id, user_id, ref_image_filename, ref_image_original_name,
        prompt, duration_sec, credits_cost, resolution, aspect_ratio, width, height, seed,
        status, progress, status_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 'Menunggu antrean worker ComfyUI')`
    ).run(
      jobId,
      input.userId,
      input.refImageFilename,
      input.refImageOriginalName,
      input.prompt,
      input.durationSec,
      cost,
      input.resolution,
      input.aspectRatio,
      input.width,
      input.height,
      input.seed
    );

    const ledgerId = `ldg_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    db.prepare(
      `INSERT INTO credit_ledger (id, user_id, type, amount, balance_after, reference_id, description)
       VALUES (?, ?, 'generation_debit', ?, ?, ?, ?)`
    ).run(
      ledgerId,
      input.userId,
      -cost,
      newBalance,
      jobId,
      `Generate video Ref-to-Video (${input.durationSec} detik · ${input.resolution} · ${input.aspectRatio})`
    );

    const job = db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(jobId) as VideoJobRecord;
    return { job, newBalance };
  }
);

// Idempotent atomic refund if job fails
export const failJobAndRefundTx = db.transaction(
  (jobId: string, errorMessage: string): { job: VideoJobRecord | null; refundedUserId?: string; newBalance?: number } => {
    const job = db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(jobId) as VideoJobRecord | undefined;
    if (!job) return { job: null };

    if (job.status === 'completed') {
      return { job };
    }

    let refundedUserId: string | undefined;
    let newBalance: number | undefined;

    if (job.credits_refunded === 0 && job.credits_cost > 0) {
      const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(job.user_id) as
        | { credits: number }
        | undefined;
      if (user) {
        newBalance = user.credits + job.credits_cost;
        refundedUserId = job.user_id;
        db.prepare(`UPDATE users SET credits = ?, updated_at = datetime('now') WHERE id = ?`).run(
          newBalance,
          job.user_id
        );
        const ledgerId = `ldg_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        db.prepare(
          `INSERT INTO credit_ledger (id, user_id, type, amount, balance_after, reference_id, description)
           VALUES (?, ?, 'generation_refund', ?, ?, ?, ?)`
        ).run(
          ledgerId,
          job.user_id,
          job.credits_cost,
          newBalance,
          job.id,
          `Pengembalian otomatis ${job.credits_cost} kredit (render gagal)`
        );
      }
    }

    db.prepare(
      `UPDATE video_jobs
       SET status = 'failed',
           credits_refunded = 1,
           error_message = ?,
           status_message = 'Render gagal — kredit dikembalikan otomatis',
           completed_at = datetime('now')
       WHERE id = ?`
    ).run(errorMessage.slice(0, 500), jobId);

    const updated = db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(jobId) as VideoJobRecord;
    return { job: updated, refundedUserId, newBalance };
  }
);

// Idempotent Midtrans settlement transaction
export const settleMidtransOrderTx = db.transaction(
  (input: {
    orderId: string;
    newStatus: 'pending' | 'settlement' | 'expire' | 'cancel' | 'deny' | 'failure';
    paymentType?: string | null;
    transactionId?: string | null;
    rawNotification?: string | null;
  }): {
    payment: PaymentRecord | null;
    creditedNow: boolean;
    newBalance?: number;
  } => {
    const payment = db
      .prepare('SELECT * FROM payment_transactions WHERE order_id = ?')
      .get(input.orderId) as PaymentRecord | undefined;

    if (!payment) {
      return { payment: null, creditedNow: false };
    }

    // Already settled -> idempotent no-op for credits
    if (payment.status === 'settlement') {
      return { payment, creditedNow: false };
    }

    if (input.newStatus === 'settlement') {
      const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(payment.user_id) as
        | { credits: number }
        | undefined;
      if (!user) throw new Error('USER_NOT_FOUND');

      const newBalance = user.credits + payment.credits;
      db.prepare(`UPDATE users SET credits = ?, updated_at = datetime('now') WHERE id = ?`).run(
        newBalance,
        payment.user_id
      );

      db.prepare(
        `UPDATE payment_transactions
         SET status = 'settlement',
             payment_type = COALESCE(?, payment_type),
             midtrans_transaction_id = COALESCE(?, midtrans_transaction_id),
             raw_notification = COALESCE(?, raw_notification),
             settled_at = datetime('now')
         WHERE order_id = ?`
      ).run(
        input.paymentType ?? null,
        input.transactionId ?? null,
        input.rawNotification ?? null,
        input.orderId
      );

      const ledgerId = `ldg_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      db.prepare(
        `INSERT INTO credit_ledger (id, user_id, type, amount, balance_after, reference_id, description)
         VALUES (?, ?, 'topup', ?, ?, ?, ?)`
      ).run(
        ledgerId,
        payment.user_id,
        payment.credits,
        newBalance,
        payment.order_id,
        `Top-up Midtrans ${payment.package_name} (+${payment.credits} kredit)`
      );

      const updated = db
        .prepare('SELECT * FROM payment_transactions WHERE order_id = ?')
        .get(input.orderId) as PaymentRecord;
      return { payment: updated, creditedNow: true, newBalance };
    }

    // Update non-settlement status
    db.prepare(
      `UPDATE payment_transactions
       SET status = ?,
           payment_type = COALESCE(?, payment_type),
           midtrans_transaction_id = COALESCE(?, midtrans_transaction_id),
           raw_notification = COALESCE(?, raw_notification)
       WHERE order_id = ?`
    ).run(
      input.newStatus,
      input.paymentType ?? null,
      input.transactionId ?? null,
      input.rawNotification ?? null,
      input.orderId
    );

    const updated = db
      .prepare('SELECT * FROM payment_transactions WHERE order_id = ?')
      .get(input.orderId) as PaymentRecord;
    return { payment: updated, creditedNow: false };
  }
);

// Atomic Admin credit adjustment
export const adminAdjustCreditsTx = db.transaction(
  (input: { userId: string; delta: number; reason: string; adminEmail: string }): { user: UserRecord; newBalance: number } => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(input.userId) as UserRecord | undefined;
    if (!user) throw new Error('USER_NOT_FOUND');

    const newBalance = user.credits + input.delta;
    if (newBalance < 0) throw new Error('NEGATIVE_BALANCE');

    db.prepare(`UPDATE users SET credits = ?, updated_at = datetime('now') WHERE id = ?`).run(
      newBalance,
      input.userId
    );

    const ledgerId = `ldg_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const sign = input.delta >= 0 ? `+${input.delta}` : `${input.delta}`;
    db.prepare(
      `INSERT INTO credit_ledger (id, user_id, type, amount, balance_after, reference_id, description)
       VALUES (?, ?, 'admin_adjustment', ?, ?, ?, ?)`
    ).run(
      ledgerId,
      input.userId,
      input.delta,
      newBalance,
      input.adminEmail,
      `Penyesuaian admin (${sign} kredit): ${input.reason.trim()}`
    );

    const updatedUser = db
      .prepare('SELECT id, name, email, role, status, credits, created_at, updated_at FROM users WHERE id = ?')
      .get(input.userId) as UserRecord;
    return { user: updatedUser, newBalance };
  }
);
