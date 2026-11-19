export interface User {
  id: string;
  name: string;
  email: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
  credits: number;
  created_at: string;
  updated_at: string;
}

export type AspectRatioId = '9:16' | '16:9' | '1:1' | '3:4' | '4:3';
export type ResolutionId = '480p' | '720p' | '1080p';

export interface ResolutionPreset {
  id: ResolutionId;
  label: string;
  shortHeight: number;
  creditsPerSecond: number;
  description: string;
}

export interface AspectRatioPreset {
  id: AspectRatioId;
  label: string;
  description: string;
  dimensions: Record<ResolutionId, { width: number; height: number }>;
}

export interface WorkflowSummary {
  name: string;
  unet: string;
  clip: string;
  videoVae: string;
  audioVae: string;
  steps: number;
  fps: number;
  sampler: string;
  totalNodes: number;
}

export interface ConnectedWorker {
  workerId: string;
  name: string;
  comfyUrl: string;
  connectedAt: string;
  busy: boolean;
  currentJobId: string | null;
}

export interface WorkerRuntimeStatus {
  mode: 'bridge' | 'tunnel';
  connectedWorkers: ConnectedWorker[];
  tunnelUrl: string;
  tunnelReachable: boolean | null;
  tunnelLastCheckedAt: string | null;
  readyForGeneration: boolean;
  queuedJobsCount: number;
}

export interface StudioConfig {
  workflow: WorkflowSummary;
  resolutions: ResolutionPreset[];
  aspectRatios: AspectRatioPreset[];
  durationMin: number;
  durationMax: number;
  creditsPerSecond: number;
  workerStatus: WorkerRuntimeStatus;
}

export interface VideoJob {
  id: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  refImageUrl: string;
  refImageOriginalName: string;
  prompt: string;
  durationSec: number;
  creditsCost: number;
  creditsRefunded: boolean;
  resolution: string;
  aspectRatio: string;
  width: number;
  height: number;
  seed: number;
  status: 'queued' | 'uploading' | 'running' | 'completed' | 'failed';
  progress: number;
  currentNode: string | null;
  statusMessage: string | null;
  comfyPromptId: string | null;
  workerId: string | null;
  outputVideoUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CreditPackage {
  id: string;
  name: string;
  audience: string;
  credits: number;
  priceIdr: number;
  pricePerCreditIdr: number;
  savingsPercent: number;
  featured?: boolean;
}

export interface MidtransClientInfo {
  configured: boolean;
  isProduction: boolean;
  clientKey: string;
  snapJsUrl: string;
  webhookUrl: string;
}

export interface PaymentTransaction {
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

export interface CreditLedgerEntry {
  id: string;
  user_id: string;
  type: 'signup_bonus' | 'topup' | 'generation_debit' | 'generation_refund' | 'admin_adjustment';
  amount: number;
  balance_after: number;
  reference_id: string | null;
  description: string;
  created_at: string;
}

export interface AdminOverview {
  users: {
    totalUsers: number;
    activeUsers: number;
    totalCreditsCirculating: number;
  };
  jobs: {
    totalJobs: number;
    completedJobs: number;
    activeJobs: number;
    failedJobs: number;
  };
  revenue: {
    settledCount: number;
    totalRevenueIdr: number;
    totalCreditsSold: number;
  };
  workerStatus: WorkerRuntimeStatus;
}

export interface AdminComfyConfig {
  mode: 'bridge' | 'tunnel';
  tunnelUrl: string;
  tunnelAuthHeader: string;
  workerToken: string;
  workerWsUrl: string;
  appUrl: string;
  workflow: WorkflowSummary;
  workerStatus: WorkerRuntimeStatus;
  midtrans: {
    configured: boolean;
    isProduction: boolean;
    webhookUrl: string;
  };
}

export type AppView = 'studio' | 'gallery' | 'billing' | 'account' | 'admin-users' | 'admin-comfy';

export interface ToastNotice {
  id: string;
  kind: 'info' | 'success' | 'error';
  message: string;
}
