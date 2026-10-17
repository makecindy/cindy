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
