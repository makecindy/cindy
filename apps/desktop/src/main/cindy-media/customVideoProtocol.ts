import { createHmac } from 'node:crypto';
import type { CustomMediaConnection } from '../cindy-brain/customMediaConnection.js';
import type { ProviderVideoApi } from '@cindy/model-providers';

/** Bind persisted tasks to their exact connection across restarts, without persisting a key. */
export function videoConnectionRevision(providerId: string, modelId: string, binding: CustomMediaConnection): string {
  const { authorization, ...headers } = binding.headers;
  return `1:${createHmac('sha256', authorization ?? 'loopback-no-auth')
    .update(JSON.stringify([providerId, modelId, binding.agent, binding.baseUrl,
      Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)),
      ...(binding.videoApi && binding.videoApi !== 'xai-videos' ? [binding.videoApi] : [])]))
    .digest('hex')}`;
}

/** Validate at the paid boundary; a Guide shown to an agent is not enforcement. */
export function validateCustomVideoBody(body: Record<string, unknown>, image: boolean, protocol: ProviderVideoApi = 'xai-videos'): void {
  if (protocol === 'minimax-videos') return validateMinimaxVideoBody(body, image);
  if (protocol === 'openai-videos') return validateOpenaiVideoBody(body, image);
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

/** A configured relay's public result host is execution policy, not Guide data. */
export function videoRelayResultHosts(baseUrl: string): string[] {
  const host = new URL(baseUrl).hostname.toLowerCase();
  return /^(?=.*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && !host.endsWith('.local') ? [host] : [];
}

const MINIMAX_RESOLUTIONS = ['480P', '768P', '2K'];
const MINIMAX_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const MINIMAX_FRAME_ROLES = ['first_frame', 'last_frame'];
const plainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function validateMinimaxVideoBody(body: Record<string, unknown>, image: boolean): void {
  if (Object.keys(body).some(key => !['content', 'resolution', 'duration', 'ratio'].includes(key))) throw new Error('视频请求包含当前协议不支持的字段');
  if (typeof body.resolution !== 'string' || !MINIMAX_RESOLUTIONS.includes(body.resolution)) throw new Error('视频分辨率必须为 480P、768P 或 2K');
  if (!Number.isInteger(body.duration) || Number(body.duration) < 4 || Number(body.duration) > 15) throw new Error('视频时长必须为 4–15 秒的整数');
  if (body.ratio === undefined ? !image : typeof body.ratio !== 'string' || !(image ? ['adaptive', ...MINIMAX_RATIOS] : MINIMAX_RATIOS).includes(body.ratio)) throw new Error('视频画幅不受支持');
  validateMinimaxContent(body.content, image);
}

/** Frozen transport support: one text, optionally one first and one last frame. */
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
  const roles = frames.map(item => {
    if (item.type !== 'image_url' || Object.keys(item).some(key => !['type', 'image_url', 'role'].includes(key))) throw new Error('图生视频只支持首帧、尾帧图片，不支持参考素材');
    const role = item.role ?? 'first_frame';
    if (typeof role !== 'string' || !MINIMAX_FRAME_ROLES.includes(role)) throw new Error('图片 role 只能是 first_frame 或 last_frame');
    const ref = item.image_url;
    if (!plainObject(ref) || Object.keys(ref).length !== 1 || typeof ref.url !== 'string' || !ref.url) throw new Error('图片必须写成 image_url: {url}');
    if (!/^(cindy-media:\/\/blobs\/|xdt-image:\/\/|data:image\/(png|jpeg|webp);base64,|https:\/\/)/.test(ref.url)) throw new Error('图生视频需要有效的图片引用');
    return role;
  });
  if (new Set(roles).size !== roles.length) throw new Error('首帧和尾帧各最多一张');
}

function validateOpenaiVideoBody(body: Record<string, unknown>, image: boolean): void {
  const fields = ['prompt', 'seconds', 'size', 'content', 'input_reference', 'duration', 'ratio', 'resolution', 'watermark'];
  if (Object.keys(body).some(key => !fields.includes(key))) throw new Error('视频请求包含当前协议不支持的字段');
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new Error('视频请求必须提供 prompt');
  if (body.seconds !== undefined && (typeof body.seconds !== 'string' || !/^[1-9][0-9]{0,2}$/.test(body.seconds))) throw new Error('seconds 必须是表示整数秒的字符串');
  if (body.size !== undefined && (typeof body.size !== 'string' || !/^[0-9A-Za-z:x]{1,32}$/.test(body.size))) throw new Error('size 格式不受支持');
  if (body.duration !== undefined && (!Number.isInteger(body.duration) || Number(body.duration) < 1 || Number(body.duration) > 60)) throw new Error('duration 必须为 1–60 秒的整数');
  if (body.ratio !== undefined && (typeof body.ratio !== 'string' || !/^(adaptive|[1-9][0-9]?:[1-9][0-9]?)$/.test(body.ratio) || (!image && body.ratio === 'adaptive'))) throw new Error('视频画幅不受支持');
  if (body.resolution !== undefined && (typeof body.resolution !== 'string' || !/^[0-9]{3,4}[pP]$|^[1-9][kK]$/.test(body.resolution))) throw new Error('视频分辨率不受支持');
  if (body.watermark !== undefined && typeof body.watermark !== 'boolean') throw new Error('watermark 必须是布尔值');
  if (body.input_reference !== undefined) {
    if (!image || body.content !== undefined) throw new Error('input_reference 仅用于图生视频，且不能与 content 混用');
    const refs = Array.isArray(body.input_reference) ? body.input_reference : [body.input_reference];
    if (refs.length < 1 || refs.length > 2 || refs.some(ref => typeof ref !== 'string' ||
      !/^(cindy-media:\/\/blobs\/|xdt-image:\/\/|data:image\/(png|jpeg|webp);base64,|https:\/\/)/.test(ref))) {
      throw new Error('input_reference 必须提供 1–2 条有效的图片引用');
    }
  } else if (body.content !== undefined || image) validateMinimaxContent(body.content, image);
}
