import type { AgentKind, MediaCapability, ProviderVideoApi } from '@cindy/model-providers';
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
  videoProtocol?: ProviderVideoApi;
  guideDriven?: boolean;
  sourceAgent?: AgentKind;
  sourceAgents?: AgentKind[];
}

export interface ProviderVideoConnection {
  baseUrl: string;
  headers: Record<string, string>;
  /** Opaque binding revision; never contains the source's credentials. */
  revision: string;
  /** Native account adapters may resolve a namespaced catalog id at the wire boundary. */
  requestModelId?: string;
  onAuthRejected?(failure: { status: number; body: string }): Promise<unknown>;
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
  guideScope?(target: { providerId: string; agent: AgentKind; modelId: string }): string | null;
  guideProtocol?(target: { providerId: string; agent: AgentKind; modelId: string }): string | undefined;
  resolveHttpConnection?(providerId: string, modelId: string, capability: MediaCapability, agent: AgentKind): ProviderVideoConnection | null | Promise<ProviderVideoConnection | null>;
  listModels(): ProviderMediaRuntimeModel[];
  listVideoModels?(): ProviderMediaRuntimeModel[];
  /** Settings readiness; must include hidden models so the display switch stays togglable. */
  listExecutableModels?(): ProviderMediaRuntimeModel[];
  listExecutableVideoModels?(): ProviderMediaRuntimeModel[];
  resolveVideoConnection?(providerId: string, modelId: string): ProviderVideoConnection | null | Promise<ProviderVideoConnection | null>;
  invoke(request: ProviderMediaRuntimeRequest): Promise<ProviderMediaRuntimeResult>;
}

let runtime: ProviderMediaRuntime | null = null;

export function providerMediaGuideScope(target: { providerId: string; agent: AgentKind; modelId: string }): string | null {
  return runtime?.guideScope?.(target) ?? null;
}

export function providerMediaGuideProtocol(target: { providerId: string; agent: AgentKind; modelId: string }): string | undefined {
  return runtime?.guideProtocol?.(target);
}

export function resolveProviderHttpConnection(providerId: string, modelId: string, capability: MediaCapability, agent: AgentKind) {
  return runtime?.resolveHttpConnection?.(providerId, modelId, capability, agent) ?? null;
}

export function configureProviderMediaRuntime(next: ProviderMediaRuntime): void {
  runtime = next;
}

export function listProviderMediaModels(): ProviderMediaRuntimeModel[] {
  return [
    ...(runtime?.listModels() ?? []),
    ...(runtime?.listVideoModels?.().filter(model => model.videoProtocol || model.guideDriven) ?? []),
  ];
}

export function resolveProviderVideoConnection(providerId: string, modelId: string): ProviderVideoConnection | null | Promise<ProviderVideoConnection | null> {
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
