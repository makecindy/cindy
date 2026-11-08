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
  validateMinimaxContent(body.content, image);
}

/** MiniMax content[]: exactly one text; image-to-video adds 1–2 first/last frames, never reference media. */
function validateMinimaxContent(content: unknown, image: boolean): void {
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

export const CLIENT_PROVIDER_OPENAI_VIDEO_GUIDE_ID = 'cindy-provider-openai-video-v1';
const OPENAI_VIDEO_FIELDS = ['prompt', 'seconds', 'size', 'content', 'duration', 'ratio', 'resolution', 'watermark'];

/** Result hosts: the relay the user configured. Hosts that are not DNS names never match, so every download asks. */
function relayResultHosts(baseUrl: string): string[] {
  const host = new URL(baseUrl).hostname.toLowerCase();
  return /^(?=.*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && !host.endsWith('.local') ? [host] : ['example.invalid'];
}

/**
 * Relay "OpenAI Videos" task API (POST /videos, GET /videos/{id}), as served by
 * tu-zi and new-api style gateways. The flat prompt fields are accepted together
 * with the model's own fields (MiniMax content/duration/ratio/resolution).
 */
export function openaiVideoGuide(
  model: ProviderMediaRuntimeModel,
  capability: 'video.generate' | 'video.image_to_video',
  revision: string,
  baseUrl: string,
): PreparedMediaInvocationGuide {
  const image = capability === 'video.image_to_video';
  const frameItem = { type: 'object', additionalProperties: false, required: ['type'], properties: {
    type: { type: 'string', enum: ['text', 'image_url'] },
    text: { type: 'string', minLength: 1, maxLength: 7000 },
    image_url: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', minLength: 1 } } },
    role: { type: 'string', enum: MINIMAX_FRAME_ROLES },
  } };
  const textItem = { type: 'object', additionalProperties: false, required: ['type', 'text'], properties: {
    type: { type: 'string', enum: ['text'] },
    text: { type: 'string', minLength: 1, maxLength: 7000 },
  } };
  return {
    schemaVersion: 1,
    guideId: CLIENT_PROVIDER_OPENAI_VIDEO_GUIDE_ID,
    modelId: model.id,
    revision,
    connection: { providerId: model.providerId },
    capability,
    request: {
      method: 'POST', path: '/videos', bodyEncoding: 'json',
      bodyModelPath: ['model'], timeoutMs: 120_000,
      maxRequestBytes: 64 * 1024 * 1024, maxResponseBytes: 1024 * 1024,
    },
    response: {
      mode: 'async', taskIdPath: ['id'],
      poll: {
        method: 'GET', path: '/videos/{taskId}', statusPath: ['status'],
        successValues: ['completed'], failureValues: ['failed', 'cancelled', 'expired'],
        recommendedIntervalMs: 5_000, timeoutMs: 30_000, maxResponseBytes: 1024 * 1024,
        // Relays return video_url (tu-zi) or url (new-api). Their own /videos/{id}/content
        // is read through the original connection; other hosts use download approval.
        media: [
          { path: ['video_url'], encoding: 'url', kind: 'video', allowedUrlHosts: relayResultHosts(baseUrl) },
          { path: ['url'], encoding: 'url', kind: 'video', allowedUrlHosts: relayResultHosts(baseUrl) },
        ],
      },
    },
    instructions: `中转站 /v1/videos 任务格式。必填 prompt。按所选模型填写它支持的字段，不要给同一含义传两个冲突的值：MiniMax-H3 这类模型用 content（且只放一条与 prompt 相同的 {type: "text", text}${image ? '，再放 1–2 条 {type: "image_url", image_url: {url: 一条 Cindy 图片引用}, role: "first_frame" 或 "last_frame"}' : ''}）、duration（整数秒）、resolution（如 768P、2K）、ratio（如 16:9${image ? '，图生视频可用 adaptive' : ''}）；Sora 这类 OpenAI 格式模型用 seconds（字符串，如 "8"）和 size（如 1280x720）。可选 watermark（布尔）。${image ? '图生视频必须用 content 传首帧或尾帧图片。' : ''}一次提交后只轮询原 invocation，不重新生成。当前不支持参考图、参考视频、参考音频和 remix。model 与凭证由 Cindy 注入。`,
    exampleBody: {
      prompt: '一个男孩在海边打篮球',
      content: [
        { type: 'text', text: '一个男孩在海边打篮球' },
        ...(image ? [{ type: 'image_url', image_url: { url: 'cindy-media://blobs/<hash>.png' }, role: 'first_frame' }] : []),
      ],
      duration: 5, resolution: '768P', ...(image ? {} : { ratio: '16:9' }),
    },
    inputSchema: {
      type: 'object', additionalProperties: false, required: image ? ['prompt', 'content'] : ['prompt'],
      properties: {
        prompt: { type: 'string', minLength: 1 },
        seconds: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' },
        size: { type: 'string', pattern: '^[0-9A-Za-z:x]{1,32}$' },
        content: { type: 'array', minItems: 1, maxItems: image ? 3 : 1, items: image ? frameItem : textItem },
        duration: { type: 'integer', minimum: 1, maximum: 60 },
        ratio: { type: 'string', pattern: '^(adaptive|[1-9][0-9]?:[1-9][0-9]?)$' },
        resolution: { type: 'string', pattern: '^[0-9]{3,4}[pP]$|^[1-9][kK]$' },
        watermark: { type: 'boolean' },
      },
    },
    officialDocs: 'https://api.tu-zi.com/docs/api/video',
  };
}

/** Validate at the paid boundary; unknown fields and reference media are rejected before payment. */
export function validateOpenaiVideoBody(body: Record<string, unknown>, image: boolean): void {
  if (Object.keys(body).some(key => !OPENAI_VIDEO_FIELDS.includes(key))) throw new Error('视频请求包含当前协议不支持的字段');
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new Error('视频请求必须提供 prompt');
  if (body.seconds !== undefined && (typeof body.seconds !== 'string' || !/^[1-9][0-9]{0,2}$/.test(body.seconds))) throw new Error('seconds 必须是表示整数秒的字符串');
  if (body.size !== undefined && (typeof body.size !== 'string' || !/^[0-9A-Za-z:x]{1,32}$/.test(body.size))) throw new Error('size 格式不受支持');
  if (body.duration !== undefined && (!Number.isInteger(body.duration) || Number(body.duration) < 1 || Number(body.duration) > 60)) throw new Error('duration 必须为 1–60 秒的整数');
  if (body.ratio !== undefined && (typeof body.ratio !== 'string' || !/^(adaptive|[1-9][0-9]?:[1-9][0-9]?)$/.test(body.ratio) || (!image && body.ratio === 'adaptive'))) throw new Error('视频画幅不受支持');
  if (body.resolution !== undefined && (typeof body.resolution !== 'string' || !/^[0-9]{3,4}[pP]$|^[1-9][kK]$/.test(body.resolution))) throw new Error('视频分辨率不受支持');
  if (body.watermark !== undefined && typeof body.watermark !== 'boolean') throw new Error('watermark 必须是布尔值');
  if (body.content !== undefined || image) validateMinimaxContent(body.content, image);
}
