/** 本地订阅视频的能力说明、输入校验与非秘密任务句柄编解码。 */
import {
  CLIENT_PROVIDER_VIDEO_GUIDE_ID,
  MODEL_ACCESS_INVOCATION_GUIDE_SCHEMA_VERSION,
  type MediaProviderVideoResponseGuide,
  type PreparedMediaInvocationGuide,
} from '../../shared/mediaInvocation.js';
import type {
  VideoGenerationRequest,
  VideoProvider,
  VideoTaskHandle,
  VideoRefMode,
} from '../cindy-proxy-media/video/types.js';
import type { ProviderMediaRuntimeModel } from './providerMediaRuntime.js';
import { VIDEO_IMAGE_MAX_DATA_URL_LENGTH } from './providerVideoImage.js';

export class ProviderVideoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderVideoError';
  }
}

export function videoResponse(
  guide: PreparedMediaInvocationGuide,
): MediaProviderVideoResponseGuide {
  if (
    guide.guideId !== CLIENT_PROVIDER_VIDEO_GUIDE_ID ||
    guide.response.mode !== 'provider-video'
  ) {
    throw new ProviderVideoError('GUIDE_INVALID', '本地视频调用说明不合法');
  }
  return guide.response;
}

export function captureVideoScope(provider: VideoProvider) {
  if (!provider.captureScope || !provider.resolveDownload || !provider.restoreHandle) {
    throw new ProviderVideoError('CAPABILITY_NOT_SUPPORTED', '该视频来源没有完整的本地执行通道');
  }
  const scope = provider.captureScope();
  if (
    !scope.ownerScopeKey ||
    !scope.credentialSessionId ||
    !Number.isSafeInteger(scope.credentialGeneration) ||
    scope.credentialGeneration < 0
  ) {
    throw new ProviderVideoError('ACCOUNT_CHANGED', '视频来源的授权身份无法确认');
  }
  return { ...scope };
}

export function assertVideoScope(
  provider: VideoProvider,
  guide: PreparedMediaInvocationGuide,
): void {
  const expected = videoResponse(guide);
  let current: ReturnType<typeof captureVideoScope>;
  try {
    current = captureVideoScope(provider);
  } catch {
    throw new ProviderVideoError('ACCOUNT_CHANGED', '视频来源的账号或授权已变化，旧调用不能继续');
  }
  // Owner is independently enforced by the invocation store/context. Process epochs can
  // change on restart; the persisted random login identity must remain identical.
  if (
    provider.id !== expected.executorId ||
    current.credentialSessionId !== expected.scope.credentialSessionId
  ) {
    throw new ProviderVideoError('ACCOUNT_CHANGED', '视频来源的账号或授权已变化，旧调用不能继续');
  }
}

export function providerVideoGuide(
  model: ProviderMediaRuntimeModel,
  capability: 'video.generate' | 'video.image_to_video',
  provider: VideoProvider,
): PreparedMediaInvocationGuide {
  const caps = provider.capabilities;
  const edit = capability === 'video.image_to_video';
  const modes = Object.entries(caps.maxImagesByRefMode)
    .filter(([, max]) => max !== undefined && max > 0)
    .map(([mode]) => mode as VideoRefMode);
  if (edit && modes.length === 0)
    throw new ProviderVideoError('CAPABILITY_NOT_SUPPORTED', '该视频来源不支持参考图');
  const properties: Record<string, unknown> = {
    prompt: { type: 'string', minLength: 1, maxLength: 100_000 },
    duration: {
      type: 'integer',
      enum: [...caps.supportedDurations],
      default: caps.defaults.duration,
    },
    resolution: {
      type: 'string',
      enum: [...caps.supportedResolutions],
      default: caps.defaults.resolution,
    },
    ratio: { type: 'string', enum: [...caps.supportedRatios], default: caps.defaults.ratio },
    fps: { type: 'integer', enum: [...caps.supportedFps], default: caps.defaults.fps },
    ...(caps.supportsAudio ? { audio: { type: 'boolean' } } : {}),
  };
  if (edit) {
    const max = Math.max(...modes.map((mode) => caps.maxImagesByRefMode[mode] ?? 0));
    properties.image = {
      description:
        'Cindy 受管图片地址，或规范 data:image/png;base64,... / data:image/jpeg;base64,...；只接受完整单帧 PNG/JPEG，每张最多 20 MiB、16777216 像素、最长边 8192。不接受文件路径、HTTP、SVG。',
      oneOf: [
        { type: 'string', minLength: 1, maxLength: VIDEO_IMAGE_MAX_DATA_URL_LENGTH },
        {
          type: 'array',
          minItems: 1,
          maxItems: max,
          items: { type: 'string', minLength: 1, maxLength: VIDEO_IMAGE_MAX_DATA_URL_LENGTH },
        },
      ],
    };
    properties.refMode = {
      type: 'string',
      enum: modes,
      default: modes.includes('first_and_last_frame') ? 'first_and_last_frame' : modes[0],
    };
  }
  return {
    schemaVersion: MODEL_ACCESS_INVOCATION_GUIDE_SCHEMA_VERSION,
    guideId: CLIENT_PROVIDER_VIDEO_GUIDE_ID,
    revision: '2',
    modelId: model.id,
    connection: { providerId: model.providerId },
    capability,
    // 与本地图片一样保留既有请求限额结构；此标记不是 Gateway 地址，不进行 HTTP 派发。
    request: {
      method: 'POST',
      path: '/client-provider-video',
      bodyEncoding: 'json',
      bodyModelPath: ['model'],
      timeoutMs: 60_000,
      maxRequestBytes: 128 * 1024 * 1024,
      maxResponseBytes: 256 * 1024 * 1024,
    },
    response: {
      mode: 'provider-video',
      executorId: provider.id,
      scope: captureVideoScope(provider),
      recommendedIntervalMs: 5_000,
    },
    instructions: `${edit ? '必填 prompt 和 image（Cindy 受管参考图或规范 PNG/JPEG Base64 data URL，每张最多 20 MiB、16777216 像素、最长边 8192，必须为完整单帧图片；不接受路径或网络 URL）。' : '必填 prompt。'}按 input_schema 使用此来源支持的参数；省略画幅时保留参考图比例。参考图数量按 refMode 校验。提交返回 pending 后沿同一 invocation_id 继续 poll，不重新提交。来源和授权由 Host 管理。`,
    exampleBody: {
      prompt: '描述希望生成的视频',
      ...(edit ? { image: 'cindy-media://blobs/<hash>.png' } : {}),
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: edit ? ['prompt', 'image'] : ['prompt'],
      properties,
    },
    officialDocs: model.officialDocs ?? 'https://github.com/makecindy/cindy',
  };
}

/** 先校验全部参数和参考图，再允许 invocation 进入 submitting。 */
export async function providerVideoRequest(
  body: Record<string, unknown>,
  guide: PreparedMediaInvocationGuide,
  provider: VideoProvider,
  resolveImage: (reference: string) => Promise<string>,
): Promise<VideoGenerationRequest> {
  const edit = guide.capability === 'video.image_to_video';
  const caps = provider.capabilities;
  const allowed = new Set([
    'prompt',
    'duration',
    'resolution',
    'ratio',
    'fps',
    ...(caps.supportsAudio ? ['audio'] : []),
    ...(edit ? ['image', 'refMode'] : []),
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key)))
    throw new ProviderVideoError('REQUEST_INVALID', '视频参数包含未支持的字段');
  if (
    typeof body.prompt !== 'string' ||
    body.prompt.trim().length === 0 ||
    body.prompt.length > 100_000
  ) {
    throw new ProviderVideoError('REQUEST_INVALID', 'prompt 必须是非空且长度合法的字符串');
  }
  const properties = guide.inputSchema.properties as Record<string, { default?: unknown }>;
  const option = <T extends string | number>(key: string, supported: readonly T[]): T => {
    const value = body[key] === undefined ? properties[key]?.default : body[key];
    if (!supported.includes(value as T))
      throw new ProviderVideoError('REQUEST_INVALID', `视频参数 ${key} 不受该模型支持`);
    return value as T;
  };
  const request: VideoGenerationRequest = {
    prompt: body.prompt,
    duration: option('duration', caps.supportedDurations),
    resolution: option('resolution', caps.supportedResolutions),
    ratio: option('ratio', caps.supportedRatios),
    fps: option('fps', caps.supportedFps),
    ratioWasExplicit: body.ratio !== undefined,
  };
  if (body.audio !== undefined) {
    if (typeof body.audio !== 'boolean')
      throw new ProviderVideoError('REQUEST_INVALID', 'audio 必须是布尔值');
    request.audio = body.audio;
  }
  if (edit) {
    const mode = body.refMode === undefined ? properties.refMode?.default : body.refMode;
    if (mode !== 'first_and_last_frame' && mode !== 'reference_image')
      throw new ProviderVideoError('REQUEST_INVALID', '参考图用法不合法');
    const max = caps.maxImagesByRefMode[mode] ?? 0;
    const refs = Array.isArray(body.image) ? body.image : [body.image];
    if (
      !max ||
      refs.length < 1 ||
      refs.length > max ||
      refs.some((ref) => typeof ref !== 'string' || !ref)
    ) {
      throw new ProviderVideoError('MEDIA_INPUT_INVALID', '参考图数量或用法不受该模型支持');
    }
    request.refMode = mode;
    request.images = [];
    for (const ref of refs) request.images.push(await resolveImage(ref as string));
  }
  return request;
}

/** taskId 列保存版本化原生句柄；responseJson 专供真正成功的响应，避免运行中单据被当作成品清理。 */
export function decodeVideoHandle(
  value: string | undefined,
  guide: PreparedMediaInvocationGuide,
): VideoTaskHandle {
  const response = videoResponse(guide);
  if (!value || value.length > 16_384)
    throw new ProviderVideoError('MEDIA_RESULT_INVALID', '视频单据缺少合法句柄');
  let raw: { version?: unknown; handle?: Partial<VideoTaskHandle> };
  try {
    raw = JSON.parse(value);
  } catch {
    throw new ProviderVideoError('MEDIA_RESULT_INVALID', '视频句柄损坏');
  }
  const h = raw?.handle;
  if (
    raw?.version !== 1 ||
    !h ||
    h.providerId !== response.executorId ||
    typeof h.taskId !== 'string' ||
    !h.taskId ||
    h.taskId.length > 4096 ||
    typeof h.modelUsed !== 'string' ||
    !h.modelUsed ||
    h.modelUsed.length > 256 ||
    typeof h.submittedAt !== 'number' ||
    !Number.isFinite(h.submittedAt) ||
    h.submittedAt <= 0 ||
    h.ownerScopeKey !== response.scope.ownerScopeKey ||
    h.credentialGeneration !== response.scope.credentialGeneration
  ) {
    throw new ProviderVideoError('MEDIA_RESULT_INVALID', '视频句柄与原执行来源不匹配');
  }
  return {
    providerId: h.providerId,
    taskId: h.taskId,
    modelUsed: h.modelUsed,
    submittedAt: h.submittedAt,
    ownerScopeKey: h.ownerScopeKey,
    credentialGeneration: h.credentialGeneration,
  };
}

export function encodeVideoHandle(
  handle: VideoTaskHandle,
  guide: PreparedMediaInvocationGuide,
): string {
  const normalized = decodeVideoHandle(JSON.stringify({ version: 1, handle }), guide);
  return JSON.stringify({ version: 1, handle: normalized });
}
