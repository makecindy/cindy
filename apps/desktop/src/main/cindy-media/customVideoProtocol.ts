import { createHmac } from 'node:crypto';
import type { PreparedMediaInvocationGuide } from '../../shared/mediaInvocation.js';
import type { CustomMediaConnection } from '../cindy-brain/customMediaConnection.js';
import type { ProviderMediaRuntimeModel } from './providerMediaRuntime.js';

export const CLIENT_PROVIDER_VIDEO_GUIDE_ID = 'cindy-provider-xai-video-v1';

/** Bind persisted tasks to their exact connection across restarts, without persisting a key. */
export function videoConnectionRevision(providerId: string, modelId: string, binding: CustomMediaConnection): string {
  const { authorization, ...headers } = binding.headers;
  return `1:${createHmac('sha256', authorization ?? 'loopback-no-auth')
    .update(JSON.stringify([providerId, modelId, binding.agent, binding.baseUrl,
      Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))]))
    .digest('hex')}`;
}

export function customVideoGuide(
  model: ProviderMediaRuntimeModel,
  capability: 'video.generate' | 'video.image_to_video',
  revision: string,
): PreparedMediaInvocationGuide {
  const image = capability === 'video.image_to_video';
  return {
    schemaVersion: 1,
    guideId: CLIENT_PROVIDER_VIDEO_GUIDE_ID,
    modelId: model.id,
    revision,
    connection: { providerId: model.providerId },
    capability,
    request: {
      method: 'POST', path: '/videos/generations', bodyEncoding: 'json',
      bodyModelPath: ['model'], timeoutMs: 120_000,
      maxRequestBytes: 70 * 1024 * 1024, maxResponseBytes: 1024 * 1024,
    },
    response: {
      mode: 'async', taskIdPath: ['request_id'],
      poll: {
        method: 'GET', path: '/videos/{taskId}', statusPath: ['status'],
        successValues: ['done'], failureValues: ['failed', 'expired'],
        recommendedIntervalMs: 5_000, timeoutMs: 30_000, maxResponseBytes: 1024 * 1024,
        // The official result host is documented by this protocol. Other hosts
        // use the existing download approval, never the generation credential.
        media: [{ path: ['video', 'url'], encoding: 'url', kind: 'video', allowedUrlHosts: ['vidgen.x.ai'] }],
      },
    },
    instructions: `必填 prompt${image ? ' 和 image: {url: 一条 Cindy 图片引用}' : ''}。可选 duration（1–15 秒）、resolution（480p/720p/1080p）、aspect_ratio。省略参数时跟随上游默认；图生视频省略画幅以保留原图比例。一次提交后只轮询原 invocation，不重新生成。当前不支持尾帧、多参考图、fps 或音轨开关。model 与凭证由 Cindy 注入。`,
    exampleBody: { prompt: '静止镜头，画面中的主体轻轻移动', ...(image ? { image: { url: 'cindy-media://blobs/<hash>.png' } } : {}) },
    inputSchema: {
      type: 'object', additionalProperties: false, required: image ? ['prompt', 'image'] : ['prompt'],
      properties: {
        prompt: { type: 'string', minLength: 1 },
        duration: { type: 'integer', minimum: 1, maximum: 15 },
        resolution: { type: 'string', enum: ['480p', '720p', '1080p'] },
        aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'] },
        ...(image ? { image: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', minLength: 1 } } } } : {}),
      },
    },
    officialDocs: 'https://docs.x.ai/developers/model-capabilities/video/generation',
  };
}

/** Validate at the paid boundary; a Guide shown to an agent is not enforcement. */
export function validateCustomVideoBody(body: Record<string, unknown>, image: boolean): void {
  const allowed = new Set(['prompt', 'duration', 'resolution', 'aspect_ratio', ...(image ? ['image'] : [])]);
  if (Object.keys(body).some(key => !allowed.has(key))) throw new Error('视频请求包含当前协议不支持的字段');
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new Error('视频请求必须提供 prompt');
  if (body.duration !== undefined && (!Number.isInteger(body.duration) || Number(body.duration) < 1 || Number(body.duration) > 15)) throw new Error('视频时长必须为 1–15 秒的整数');
  if (body.resolution !== undefined && (typeof body.resolution !== 'string' || !['480p', '720p', '1080p'].includes(body.resolution))) throw new Error('视频分辨率不受支持');
  if (body.aspect_ratio !== undefined && (typeof body.aspect_ratio !== 'string' || !['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'].includes(body.aspect_ratio))) throw new Error('视频画幅不受支持');
  if (image) {
    const ref = body.image as Record<string, unknown> | undefined;
    if (!ref || Array.isArray(ref) || Object.keys(ref).length !== 1 || typeof ref.url !== 'string' || !ref.url) throw new Error('图生视频必须提供一张图片: image: {url}');
    // Local managed refs are expanded after this check, through the media store.
    if (!/^(cindy-media:\/\/blobs\/|xdt-image:\/\/|data:image\/(png|jpeg|webp);base64,|https:\/\/)/.test(ref.url)) throw new Error('图生视频需要有效的图片引用');
  }
}

export const CLIENT_PROVIDER_MINIMAX_VIDEO_GUIDE_ID = 'cindy-provider-minimax-video-v1';
const MINIMAX_RESOLUTIONS = ['480P', '768P', '2K'];
const MINIMAX_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const MINIMAX_FRAME_ROLES = ['first_frame', 'last_frame'];

/** MiniMax V2 video (MiniMax-H3 family): native content[] body, async task under the API root. */
export function minimaxVideoGuide(
  model: ProviderMediaRuntimeModel,
  capability: 'video.generate' | 'video.image_to_video',
  revision: string,
): PreparedMediaInvocationGuide {
  const image = capability === 'video.image_to_video';
  const ratios = image ? ['adaptive', ...MINIMAX_RATIOS] : MINIMAX_RATIOS;
  return {
    schemaVersion: 1,
    guideId: CLIENT_PROVIDER_MINIMAX_VIDEO_GUIDE_ID,
    modelId: model.id,
    revision,
    connection: { providerId: model.providerId },
    capability,
    request: {
      method: 'POST', path: '/v2/video_generation', bodyEncoding: 'json',
      bodyModelPath: ['model'], timeoutMs: 120_000,
      maxRequestBytes: 64 * 1024 * 1024, maxResponseBytes: 1024 * 1024,
    },
    response: {
      mode: 'async', taskIdPath: ['task_id'],
      poll: {
        method: 'GET', path: '/v2/query/video_generation/{taskId}', statusPath: ['task', 'status'],
        successValues: ['succeeded'], failureValues: ['failed', 'cancelled', 'expired'],
        recommendedIntervalMs: 10_000, timeoutMs: 30_000, maxResponseBytes: 1024 * 1024,
        // MiniMax-owned result domains. Relay or object-storage hosts use the
        // existing download approval, never the generation credential.
        media: [{ path: ['task', 'content', 'url'], encoding: 'url', kind: 'video', allowedUrlHosts: ['minimax.io', 'minimaxi.com', 'minimax.chat', 'hailuoai.com'] }],
      },
    },
    instructions: `body 使用 MiniMax 原生格式：content 数组里放且只放一条 {type: "text", text: 提示词}${image ? '，再放 1–2 条 {type: "image_url", image_url: {url: 一条 Cindy 图片引用}, role: "first_frame" 或 "last_frame"}（省略 role 视为首帧）' : ''}。必填 resolution（480P/768P/2K，MiniMax-H3 支持 768P/2K，Max/Highspeed/Lite 不支持 2K）、duration（4–15 秒整数）${image ? '；可选 ratio，省略或 adaptive 时跟随图片比例' : '、ratio（不能用 adaptive）'}。一次提交后只轮询原 invocation，不重新生成。当前不支持参考图、参考视频、参考音频生成。model 与凭证由 Cindy 注入。`,
    exampleBody: {
      content: [
        { type: 'text', text: '静止镜头，画面中的主体轻轻移动' },
        ...(image ? [{ type: 'image_url', image_url: { url: 'cindy-media://blobs/<hash>.png' }, role: 'first_frame' }] : []),
      ],
      resolution: '768P', duration: 6, ...(image ? {} : { ratio: '16:9' }),
    },
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: image ? ['content', 'resolution', 'duration'] : ['content', 'resolution', 'duration', 'ratio'],
      properties: {
        content: {
          type: 'array', minItems: 1, maxItems: image ? 3 : 1,
          items: image
            ? { type: 'object', additionalProperties: false, required: ['type'], properties: {
              type: { type: 'string', enum: ['text', 'image_url'] },
              text: { type: 'string', minLength: 1, maxLength: 7000 },
              image_url: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', minLength: 1 } } },
              role: { type: 'string', enum: MINIMAX_FRAME_ROLES },
            } }
            : { type: 'object', additionalProperties: false, required: ['type', 'text'], properties: {
              type: { type: 'string', enum: ['text'] },
              text: { type: 'string', minLength: 1, maxLength: 7000 },
            } },
        },
        resolution: { type: 'string', enum: MINIMAX_RESOLUTIONS },
        duration: { type: 'integer', minimum: 4, maximum: 15 },
        ratio: { type: 'string', enum: ratios },
      },
    },
    officialDocs: 'https://platform.minimax.io/docs/api-reference/video-generation-v2-create',
  };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Validate at the paid boundary; reference-to-video and unknown fields are rejected before payment. */
export function validateMinimaxVideoBody(body: Record<string, unknown>, image: boolean): void {
  if (Object.keys(body).some(key => !['content', 'resolution', 'duration', 'ratio'].includes(key))) throw new Error('视频请求包含当前协议不支持的字段');
  if (typeof body.resolution !== 'string' || !MINIMAX_RESOLUTIONS.includes(body.resolution)) throw new Error('视频分辨率必须为 480P、768P 或 2K');
  if (!Number.isInteger(body.duration) || Number(body.duration) < 4 || Number(body.duration) > 15) throw new Error('视频时长必须为 4–15 秒的整数');
  if (body.ratio === undefined ? !image : typeof body.ratio !== 'string' || !(image ? ['adaptive', ...MINIMAX_RATIOS] : MINIMAX_RATIOS).includes(body.ratio)) throw new Error('视频画幅不受支持');
  const content = body.content;
  if (!Array.isArray(content) || !content.every(plainObject)) throw new Error('视频请求必须提供 content 数组');
  const texts = content.filter(item => item.type === 'text');
  if (texts.length !== 1 || Object.keys(texts[0]!).some(key => key !== 'type' && key !== 'text') ||
      typeof texts[0]!.text !== 'string' || !texts[0]!.text.trim() || texts[0]!.text.length > 7000) {
    throw new Error('content 必须且只能包含一条非空 text（最多 7000 字符）');
  }
  const frames = content.filter(item => item.type !== 'text');
  if (!image) {
    if (frames.length) throw new Error('文生视频的 content 只能包含 text');
    return;
  }
  if (frames.length < 1 || frames.length > 2) throw new Error('图生视频需要 1–2 张首帧或尾帧图片');
  const roles = frames.map((item) => {
    if (item.type !== 'image_url' || Object.keys(item).some(key => !['type', 'image_url', 'role'].includes(key))) throw new Error('图生视频只支持首帧、尾帧图片，不支持参考素材');
    const role = item.role ?? 'first_frame';
    if (typeof role !== 'string' || !MINIMAX_FRAME_ROLES.includes(role)) throw new Error('图片 role 只能是 first_frame 或 last_frame');
    const ref = item.image_url;
    if (!plainObject(ref) || Object.keys(ref).length !== 1 || typeof ref.url !== 'string' || !ref.url) throw new Error('图片必须写成 image_url: {url}');
    // Local managed refs are expanded after this check, through the media store.
    if (!/^(cindy-media:\/\/blobs\/|xdt-image:\/\/|data:image\/(png|jpeg|webp);base64,|https:\/\/)/.test(ref.url)) throw new Error('图生视频需要有效的图片引用');
    return role;
  });
  if (new Set(roles).size !== roles.length) throw new Error('首帧和尾帧各最多一张');
}
