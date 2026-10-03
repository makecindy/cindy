import type { MediaCapability } from '@cindy/model-providers';
import type { ImageParameters, ImageProtocol } from './imageParameters.js';
import { supportsMediaCapability } from './mediaCapabilities.js';
import type { VideoProvider } from '../cindy-proxy-media/video/types.js';

export interface ProviderMediaRuntimeModel {
  id: string;
  name: string;
  providerId: string;
  mode: 'image_generation' | 'video_generation';
  modalities: { input: string[]; output: string[] };
  officialDocs?: string;
  imageProtocol?: ImageProtocol;
}

export interface ProviderMediaRuntimeRequest extends ImageParameters {
  providerId: string;
  modelId: string;
  capability: MediaCapability;
  prompt: string;
  imagePaths: string[];
  signal?: AbortSignal;
}

export interface ProviderMediaRuntimeResult {
  buffer: Buffer;
  mimeType: string;
}

interface ProviderMediaRuntime {
  listModels(): ProviderMediaRuntimeModel[];
  listVideoModels?(): ProviderMediaRuntimeModel[];
  /** Settings readiness; must include hidden models so the display switch stays togglable. */
  listExecutableModels?(): ProviderMediaRuntimeModel[];
  listExecutableVideoModels?(): ProviderMediaRuntimeModel[];
  /** Host 内部的视频执行器；不会通过 MCP 返回给 Agent。 */
  resolveVideo?(providerId: string, modelId: string): VideoProvider | null;
  invoke(request: ProviderMediaRuntimeRequest): Promise<ProviderMediaRuntimeResult>;
}

let runtime: ProviderMediaRuntime | null = null;

export function configureProviderMediaRuntime(next: ProviderMediaRuntime): void {
  runtime = next;
}

export function listProviderMediaModels(): ProviderMediaRuntimeModel[] {
  return [...(runtime?.listModels() ?? []), ...(runtime?.listVideoModels?.() ?? [])];
}

/** 已提交单据可继续查询；新提交的可见性由 resolveProviderMediaModel 再检查。 */
export function resolveProviderVideo(providerId: string, modelId: string): VideoProvider | null {
  return runtime?.resolveVideo?.(providerId, modelId) ?? null;
}

/** Readiness only; dispatch still belongs to the image/video execution registries. */
export function listReadyProviderMediaModels(): ProviderMediaRuntimeModel[] {
  return [
    ...(runtime?.listExecutableModels?.() ?? runtime?.listModels() ?? []),
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
