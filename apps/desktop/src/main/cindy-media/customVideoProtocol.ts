import { createHmac } from 'node:crypto';
import type { CustomMediaConnection } from '../cindy-brain/customMediaConnection.js';

/** Bind persisted tasks to their exact connection across restarts, without persisting a key. */
export function videoConnectionRevision(providerId: string, modelId: string, binding: CustomMediaConnection): string {
  const { authorization, ...headers } = binding.headers;
  return `1:${createHmac('sha256', authorization ?? 'loopback-no-auth')
    .update(JSON.stringify([providerId, modelId, binding.agent, binding.baseUrl,
      Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))]))
    .digest('hex')}`;
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
