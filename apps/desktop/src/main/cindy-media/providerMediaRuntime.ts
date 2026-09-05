import type { MediaCapability } from '@cindy/model-providers';
import type { GhostImageAspectRatio } from '../../shared/ghost.js';
import { supportsMediaCapability } from './mediaCapabilities.js';

export interface ProviderMediaRuntimeModel {
  id: string;
  name: string;
  providerId: string;
  mode: 'image_generation' | 'video_generation';
  modalities: { input: string[]; output: string[] };
  officialDocs?: string;
}

export interface ProviderMediaRuntimeRequest {
  providerId: string;
  modelId: string;
  capability: MediaCapability;
  prompt: string;
  imagePaths: string[];
  aspectRatio?: GhostImageAspectRatio;
  signal?: AbortSignal;
}

export interface ProviderMediaRuntimeResult {
  buffer: Buffer;
  mimeType: string;
}

interface ProviderMediaRuntime {
  listModels(): ProviderMediaRuntimeModel[];
  listVideoModels?(): ProviderMediaRuntimeModel[];
  invoke(request: ProviderMediaRuntimeRequest): Promise<ProviderMediaRuntimeResult>;
}

let runtime: ProviderMediaRuntime | null = null;

export function configureProviderMediaRuntime(next: ProviderMediaRuntime): void {
  runtime = next;
}

export function listProviderMediaModels(): ProviderMediaRuntimeModel[] {
  return runtime?.listModels() ?? [];
}

/** Readiness only; dispatch still belongs to the image/video execution registries. */
export function listReadyProviderMediaModels(): ProviderMediaRuntimeModel[] {
  return [...listProviderMediaModels(), ...(runtime?.listVideoModels?.() ?? [])];
}

export function resolveProviderMediaModel(
  providerId: string,
  modelId: string,
  capability: MediaCapability,
): ProviderMediaRuntimeModel | null {
  return (
    listProviderMediaModels().find(
      (model) =>
        model.providerId === providerId &&
        model.id === modelId &&
        supportsMediaCapability(model.modalities, capability),
    ) ?? null
  );
}

export async function invokeProviderMedia(
  request: ProviderMediaRuntimeRequest,
): Promise<ProviderMediaRuntimeResult> {
  const active = resolveProviderMediaModel(
    request.providerId,
    request.modelId,
    request.capability,
  );
  if (!active || !runtime) throw new Error('第三方媒体模型或执行来源当前不可用');
  return runtime.invoke(request);
}
