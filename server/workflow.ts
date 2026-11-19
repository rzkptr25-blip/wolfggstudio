import fs from 'fs';
import path from 'path';

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

export const RESOLUTION_PRESETS: ResolutionPreset[] = [
  {
    id: '480p',
    label: '480p',
    shortHeight: 480,
    creditsPerSecond: 1,
    description: 'Standar cepat · 1 kredit/detik',
  },
  {
    id: '720p',
    label: '720p HD',
    shortHeight: 720,
    creditsPerSecond: 2,
    description: 'Tajam HD · 2 kredit/detik',
  },
  {
    id: '1080p',
    label: '1080p Full HD',
    shortHeight: 1080,
    creditsPerSecond: 3,
    description: 'Kualitas tinggi · 3 kredit/detik',
  },
];

export const ASPECT_RATIO_PRESETS: AspectRatioPreset[] = [
  {
    id: '9:16',
    label: '9:16 Vertikal',
    description: 'Reels / Shorts / TikTok',
    dimensions: {
      '480p': { width: 480, height: 864 },
      '720p': { width: 720, height: 1280 },
      '1080p': { width: 1080, height: 1920 },
    },
  },
  {
    id: '16:9',
    label: '16:9 Sinematik',
    description: 'Landscape / YouTube',
    dimensions: {
      '480p': { width: 864, height: 480 },
      '720p': { width: 1280, height: 720 },
      '1080p': { width: 1920, height: 1080 },
    },
  },
  {
    id: '1:1',
    label: '1:1 Persegi',
    description: 'Feed / Sosial Media',
    dimensions: {
      '480p': { width: 480, height: 480 },
      '720p': { width: 720, height: 720 },
      '1080p': { width: 1080, height: 1080 },
    },
  },
  {
    id: '3:4',
    label: '3:4 Potret',
    description: 'Editorial Vertikal',
    dimensions: {
      '480p': { width: 480, height: 640 },
      '720p': { width: 720, height: 960 },
      '1080p': { width: 1080, height: 1440 },
    },
  },
  {
    id: '4:3',
    label: '4:3 Klasik',
    description: 'Bingkai Studio',
    dimensions: {
      '480p': { width: 640, height: 480 },
      '720p': { width: 960, height: 720 },
      '1080p': { width: 1440, height: 1080 },
    },
  },
];

export function resolveResolutionPreset(id: string): ResolutionPreset | undefined {
  return RESOLUTION_PRESETS.find((r) => r.id === id);
}

export function resolveVideoDimensions(
  resolutionId: ResolutionId,
  aspectRatioId: AspectRatioId
): { width: number; height: number } {
  const ratio = ASPECT_RATIO_PRESETS.find((a) => a.id === aspectRatioId) ?? ASPECT_RATIO_PRESETS[0];
  return ratio.dimensions[resolutionId];
}

export const DURATION_MIN_SEC = 3;
export const DURATION_MAX_SEC = 15;
export const CREDITS_PER_SECOND = 1;

const WORKFLOW_CANDIDATES = [
  path.resolve(process.cwd(), 'public/assets/aistudio/REF2VA-API-Workflow_5dc58493.json'),
  path.resolve(process.cwd(), 'dist/assets/aistudio/REF2VA-API-Workflow_5dc58493.json'),
];

function resolveWorkflowPath(): string {
  for (const candidate of WORKFLOW_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return WORKFLOW_CANDIDATES[0];
}

type ComfyGraph = Record<
  string,
  {
    inputs: Record<string, unknown>;
    class_type: string;
    _meta?: { title?: string; cnr_id?: string; ver?: string };
  }
>;

let cachedTemplate: ComfyGraph | null = null;

function loadBaseWorkflowTemplate(): ComfyGraph {
  if (!cachedTemplate) {
    const raw = fs.readFileSync(resolveWorkflowPath(), 'utf8');
    cachedTemplate = JSON.parse(raw) as ComfyGraph;
  }
  return structuredClone(cachedTemplate);
}

export function getWorkflowSummary() {
  const graph = loadBaseWorkflowTemplate();
  return {
    name: 'MiniMax H3 Reference-to-Video + Audio (Ref2VA)',
    unet: String(graph['1']?.inputs?.unet_name ?? 'MiniMax_H3_Ref2VA'),
    clip: String(graph['2']?.inputs?.clip_name ?? 'qwen3vl_32b_minimax_h3'),
    videoVae: String(graph['3']?.inputs?.vae_name ?? 'minimax_h3_video_vae'),
    audioVae: String(graph['4']?.inputs?.vae_name ?? 'minimax_h3_audio_vae'),
    steps: Number(graph['86']?.inputs?.value ?? 8),
    fps: Number(graph['94:98']?.inputs?.fps ?? 24),
    sampler: String(graph['9']?.inputs?.sampler_name ?? 'euler'),
    totalNodes: Object.keys(graph).length,
  };
}

export function getNodeTitleMap(): Record<string, string> {
  const graph = loadBaseWorkflowTemplate();
  const map: Record<string, string> = {};
  for (const [nodeId, node] of Object.entries(graph)) {
    map[nodeId] = node._meta?.title || node.class_type || `Node ${nodeId}`;
  }
  return map;
}

export function buildInjectedWorkflow(params: {
  jobId: string;
  uploadedImageName: string;
  prompt: string;
  durationSec: number;
  width: number;
  height: number;
  seed: number;
}): ComfyGraph {
  const graph = loadBaseWorkflowTemplate();

  // Node 102: LoadImage
  if (graph['102']?.inputs) {
    graph['102'].inputs.image = params.uploadedImageName;
  }

  // Node 106: MiniMaxH3ReferenceToVideo
  if (graph['106']?.inputs) {
    graph['106'].inputs.prompt = params.prompt;
    graph['106'].inputs.width = params.width;
    graph['106'].inputs.height = params.height;
  }

  // Node 27: PrimitiveFloat (duration in seconds; Node 25 computes exact 24fps frame count)
  if (graph['27']?.inputs) {
    graph['27'].inputs.value = params.durationSec;
  }

  // Node 6: RandomNoise
  if (graph['6']?.inputs) {
    graph['6'].inputs.noise_seed = params.seed;
  }

  // Node 83: SaveVideo output filename prefix
  if (graph['83']?.inputs) {
    graph['83'].inputs.filename_prefix = `KinetikRef2VA/${params.jobId}`;
  }

  return graph;
}
