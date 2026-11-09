import { setTimeout as delay } from 'node:timers/promises';
import type { CindyMediaToolRequest } from 'cindy-tools';
import type { GhostVideoRefMode, GhostVideoResultParams } from '../../shared/ghost.js';
import { MediaDownloadError, type MediaDownloadContext } from './mediaDownload.js';

export type LegacyMediaKind = 'gen_image' | 'edit_image' | 'gen_video' | 'edit_video';
export interface LegacyVideoDefaults {
  duration: number; resolution: string; ratio: string; fps: number;
  audioDefault?: boolean;
}
export interface LegacyMediaRequest {
  kind: LegacyMediaKind;
  model: string;
  providerId?: string;
  prompt: string;
  images?: string[];
  aspectRatio?: string;
  refMode?: GhostVideoRefMode;
  duration?: number;
  resolution?: string;
  ratio?: string;
  fps?: number;
  audio?: boolean;
  videoDefaults?: LegacyVideoDefaults;
}

/** Already ingested by Core; the compatibility entry only attaches its own ref. */
export interface LegacyMediaResult {
  url: string;
  hash: string;
  ext: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  videoParams?: GhostVideoResultParams;
}

const CAPABILITIES = {
  gen_image: 'image.generate', edit_image: 'image.edit',
  gen_video: 'video.generate', edit_video: 'video.image_to_video',
} as const;
const IMAGE_SIZES: Record<string, string> = {
  '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536',
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

/** Whether the old input contract can express this operation, without Guide identities. */
export function supportsLegacyMediaInput(schema: Record<string, unknown>): boolean {
  const properties = object(schema.properties);
  const fields = new Set(['prompt', 'image', 'content', 'duration', 'resolution', 'ratio', 'aspect_ratio', 'fps', 'audio', 'generate_audio']);
  return Boolean(properties.prompt || properties.content) &&
    (!Array.isArray(schema.required) || schema.required.every(key => typeof key === 'string' && fields.has(key)));
}

/** Only adapts the frozen old input vocabulary; transport and response handling belong to Core. */
export function legacyMediaBody(
  request: LegacyMediaRequest,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = object(schema.properties);
  const body: Record<string, unknown> = {};
  const video = request.kind === 'gen_video' || request.kind === 'edit_video';
  if (properties.prompt) body.prompt = request.prompt;
  if (video && properties.content) {
    body.content = [
      { type: 'text', text: request.prompt },
      ...(request.images ?? []).map((url, index) => ({
        type: 'image_url', image_url: { url },
        role: request.refMode === 'reference_image'
          ? 'reference_image' : index === 0 ? 'first_frame' : 'last_frame',
      })),
    ];
  } else if (!properties.prompt) throw new Error('所选模型的输入无法由旧媒体接口表达，请通过 Core 媒体工具调用');
  if (request.images?.length && properties.image) {
    const field = object(properties.image);
    if (field.type === 'object') {
      if (request.images.length !== 1) throw new Error('所选媒体接口只接受一张参考图');
      body.image = { url: request.images[0] };
    } else body.image = request.images.length === 1 ? request.images[0] : request.images;
  }
  if (request.kind.startsWith('edit_') && !body.image && !body.content) {
    throw new Error('所选模型无法通过旧接口接收参考图');
  }
  if (request.aspectRatio !== undefined) {
    if (properties.aspect_ratio) body.aspect_ratio = request.aspectRatio;
    else if (properties.size && IMAGE_SIZES[request.aspectRatio]) body.size = IMAGE_SIZES[request.aspectRatio];
    else throw new Error('所选模型无法通过旧接口设置该画幅');
  }
  for (const key of ['duration', 'resolution', 'ratio', 'fps', 'audio'] as const) {
    let value = request[key] ?? (key === 'audio' ? undefined : request.videoDefaults?.[key]);
    if (value === undefined) continue;
    const field = key === 'ratio' && properties.aspect_ratio ? 'aspect_ratio'
      : key === 'audio' && properties.generate_audio ? 'generate_audio' : key;
    if (key === 'ratio' && field === 'aspect_ratio' && request.images?.length && request.ratio === undefined) continue;
    const fixed = object(properties[field]).const;
    if (request[key] === undefined && (typeof fixed === 'string' || typeof fixed === 'number')) value = fixed;
    if (properties[field]) body[field] = value;
    // The old xAI fps=24 is a fixed receipt value, never an API parameter.
    else if (request[key] !== undefined && !(key === 'fps' && value === 24)) throw new Error(`所选模型不支持旧参数 ${key}`);
  }
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (typeof key === 'string' && !(key in body)) {
      throw new Error(`所选模型还要求参数 ${key}，请通过 Core 媒体工具调用`);
    }
  }
  return body;
}

/** Preserve the old receipt's upstream-first values without leaking raw responses to plugins. */
export function legacyVideoReceipt(
  request: LegacyMediaRequest,
  defaults: LegacyVideoDefaults,
  response: unknown,
): GhostVideoResultParams {
  const raw = object(response);
  const video = object(raw.video);
  const usage = object(raw.usage);
  const number = (value: unknown, fallback: number) => typeof value === 'number' ? value : fallback;
  const string = (value: unknown, fallback: string) => typeof value === 'string' && value ? value : fallback;
  const audio = raw.audio ?? request.audio ?? defaults.audioDefault;
  return {
    durationSeconds: number(video.duration ?? raw.duration ?? usage.duration, request.duration ?? defaults.duration),
    resolution: string(video.resolution ?? raw.resolution ?? (typeof usage.SR === 'number' ? `${usage.SR}p` : undefined), request.resolution ?? defaults.resolution),
    ratio: string(video.aspect_ratio ?? raw.ratio ?? usage.ratio, request.ratio ?? defaults.ratio),
    fps: number(video.fps ?? raw.fps ?? raw.framespersecond, request.fps ?? defaults.fps),
    ...(typeof audio === 'boolean' ? { audio } : {}),
  };
}

export async function invokeLegacyMedia(
  request: LegacyMediaRequest,
  deps: {
    callCore(request: CindyMediaToolRequest, context: MediaDownloadContext): Promise<Record<string, unknown>>;
    assertCurrent(): void;
    downloadContext?: MediaDownloadContext;
    timeoutMs: number;
    wait?(ms: number): Promise<unknown>;
  },
): Promise<{ url: string; invocationId: string }> {
  // Legacy submit/query jobs may outlive the caller's turn. Keep their owner
  // guard active throughout Core; only an actual approval needs the live turn.
  const context: MediaDownloadContext = {
    approvals: deps.downloadContext?.approvals ?? new Set<string>(),
    assertActive: deps.assertCurrent,
    confirm: async input => {
      deps.assertCurrent();
      if (!deps.downloadContext) {
        throw new MediaDownloadError('MEDIA_DOWNLOAD_CONFIRMATION_REQUIRED', '本次下载需要用户确认，当前任务的审批通道不可用');
      }
      return deps.downloadContext.confirm(input);
    },
  };
  deps.assertCurrent();
  const prepared = await deps.callCore({
    action: 'prepare', modelId: request.model,
    ...(request.providerId ? { providerId: request.providerId } : {}),
    capability: CAPABILITIES[request.kind],
  }, context);
  deps.assertCurrent();
  if (!prepared.ok || typeof prepared.invocation_id !== 'string') {
    throw new Error(String(prepared.message ?? '媒体调用准备失败'));
  }
  const invocationId = prepared.invocation_id;
  const body = legacyMediaBody(request, object(prepared.input_schema));
  let result = await deps.callCore({ action: 'request', invocationId, body }, context);
  deps.assertCurrent();
  const deadline = Date.now() + deps.timeoutMs;
  while ((result.ok && result.status !== 'complete') || (!result.ok && result.retryable === true)) {
    if (Date.now() >= deadline) throw new Error(`媒体任务等待超时，保留原调用 ${invocationId}；不要重新生成`);
    const interval = typeof result.recommended_poll_after_ms === 'number'
      ? result.recommended_poll_after_ms : 5_000;
    await (deps.wait ?? delay)(interval);
    deps.assertCurrent();
    result = await deps.callCore({ action: 'poll', invocationId }, context);
    deps.assertCurrent();
  }
  if (!result.ok) throw new Error(`${String(result.message ?? '媒体调用失败')}（${invocationId}）`);
  const urls = request.kind.endsWith('image') ? result.xdt_image_urls : result.xdt_video_urls;
  const url = Array.isArray(urls) ? urls[0] : undefined;
  if (typeof url !== 'string' || !/^cindy-media:\/\/blobs\/[0-9a-f]{64}\.[a-z0-9]{1,10}$/.test(url)) {
    throw new Error('Core 未返回有效的受管媒体结果');
  }
  return { url, invocationId };
}
