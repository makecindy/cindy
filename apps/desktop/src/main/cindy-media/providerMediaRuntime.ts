import type { MediaCapability } from '@cindy/model-providers';
import type { ImageParameters, ImageProtocol } from './imageParameters.js';
import { supportsMediaCapability } from './mediaCapabilities.js';

export interface ProviderMediaRuntimeModel {
  id: string;
  name: string;
  providerId: string;
  mode: 'image_generation' | 'video_generation';
  modalities: { input: string[]; output: string[] };
  officialDocs?: string;
  imageProtocol?: ImageProtocol;
  videoProtocol?: 'xai-videos';
}

export interface ProviderVideoConnection {
  baseUrl: string;
  headers: Record<string, string>;
  /** Opaque binding revision; never contains the source's credentials. */
  revision: string;
  assertCurrent(): void;
}

export interface ProviderMediaRuntimeRequest extends ImageParameters {
  providerId: string;
  modelId: string;
  capability: MediaCapability;
  prompt: string;
  imagePaths: string[];
  signal?: AbortSignal;
}

export type ProviderMediaRuntimeResult = {
  buffer: Buffer;
  mimeType: string;
} | { url: string };

interface ProviderMediaRuntime {
  listModels(): ProviderMediaRuntimeModel[];
  listVideoModels?(): ProviderMediaRuntimeModel[];
  /** Settings readiness; must include hidden models so the display switch stays togglable. */
  listExecutableModels?(): ProviderMediaRuntimeModel[];
  listExecutableVideoModels?(): ProviderMediaRuntimeModel[];
  resolveVideoConnection?(providerId: string, modelId: string): ProviderVideoConnection | null;
  invoke(request: ProviderMediaRuntimeRequest): Promise<ProviderMediaRuntimeResult>;
}

let runtime: ProviderMediaRuntime | null = null;

export function configureProviderMediaRuntime(next: ProviderMediaRuntime): void {
  runtime = next;
}

export function listProviderMediaModels(): ProviderMediaRuntimeModel[] {
  return [
    ...(runtime?.listModels() ?? []),
    ...(runtime?.listVideoModels?.().filter(model => model.videoProtocol) ?? []),
  ];
}

export function resolveProviderVideoConnection(providerId: string, modelId: string): ProviderVideoConnection | null {
  return runtime?.resolveVideoConnection?.(providerId, modelId) ?? null;
}

/** Readiness only; dispatch still belongs to the image/video execution registries. */
export function listReadyProviderMediaModels(): ProviderMediaRuntimeModel[] {
  return [
    ...(runtime?.listExecutableModels?.() ?? listProviderMediaModels()),
    ...(runtime?.listExecutableVideoModels?.() ?? runtime?.listVideoModels?.() ?? []),
  ];
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
