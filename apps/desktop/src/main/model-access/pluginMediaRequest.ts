import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import {
  GHOST_CINDY_JOB_TTL_MS,
  GHOST_DIRECT_MEDIA_OPERATIONS,
  type GhostDirectMediaOperation,
  type GhostDirectMediaResponse,
} from '../../shared/ghost.js';
import type { MediaAsyncPollGuide, ResolvedMediaInvocationGuide } from '../../shared/mediaInvocation.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';

const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_REQUEST_MS = 180_000;
const MAX_VIDEO_REFERENCES = 128;

export interface PluginMediaRequestContext {
  owner: string;
  instance: string;
  isCurrent(): boolean;
  resolveAudio(hash: string): Promise<string | undefined>;
}

interface Dependencies {
  getConnection(): { baseUrl: string; apiKey: string; onUnauthorized(): void };
  allowsModel(model: string, operation: GhostDirectMediaOperation): boolean;
  getGuide(model: string): Promise<ResolvedMediaInvocationGuide>;
  send(url: string, init: RequestInit): Promise<Response>;
}

interface VideoReference {
  owner: string;
  instance: string;
  model: string;
  endpoint: string;
  taskId: string;
  poll: MediaAsyncPollGuide;
  expiresAt: number;
}

function failure(errorCode: string, message: string) {
  return { ok: false as const, errorCode, message };
}

function denied() {
  return failure('PERMISSION_DENIED', '插件或账号未获准调用此媒体操作或模型');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readField(value: unknown, path: string[]): unknown {
  for (const segment of path) {
    const item = record(value);
    value = item && Object.hasOwn(item, segment) ? item[segment] : undefined;
  }
  return value;
}

// Paths come from the validated gateway guide. Build new nested fields without
// traversing inherited properties or changing a caller-supplied model value.
function withField(body: Record<string, unknown>, path: string[], value: string): Record<string, unknown> | undefined {
  const [key, ...rest] = path;
  const existing = Object.hasOwn(body, key) ? body[key] : undefined;
  if (!rest.length) return existing === undefined || existing === value ? { ...body, [key]: value } : undefined;
  const child = existing === undefined ? {} : record(existing);
  const nested = child && withField(child, rest, value);
  return nested ? { ...body, [key]: nested } : undefined;
}

async function readResponse(response: Response, limit: number): Promise<Buffer | undefined> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return Buffer.concat(chunks, size);
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function audioForm(body: Record<string, unknown>, hash: unknown, context: PluginMediaRequestContext): Promise<FormData | undefined> {
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) || Object.hasOwn(body, 'file')) return undefined;
  const fields = Object.entries(body);
  if (fields.some(([, value]) => typeof value !== 'string')) return undefined;
  const remainingBytes = MAX_PAYLOAD_BYTES - Buffer.byteLength(JSON.stringify(body));
  if (remainingBytes <= 0) return undefined;
  const path = await context.resolveAudio(hash);
  if (!path || !context.isCurrent()) return undefined;
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > remainingBytes) return undefined;
    const bytes = new Uint8Array(stat.size);
    for (let offset = 0; offset < bytes.length;) {
      const part = await file.read(bytes, offset, bytes.length - offset, offset);
      if (part.bytesRead === 0) return undefined;
      offset += part.bytesRead;
    }
    const mime = sniffMediaMime(bytes);
    const extension = mime === 'audio/mpeg' ? 'mp3' : mime === 'audio/mp4' ? 'm4a' : mime?.startsWith('audio/') ? mime.slice(6) : undefined;
    if (!mime || !extension) return undefined;
    const form = new FormData();
    for (const [name, value] of fields) form.append(name, value as string);
    form.append('file', new Blob([bytes], { type: mime }), `audio.${extension}`);
    return form;
  } finally {
    await file.close();
  }
}

export function createPluginMediaRequester(deps: Dependencies) {
  const videoReferences = new Map<string, VideoReference>();

  return async (input: unknown, context: PluginMediaRequestContext) => {
    const request = record(input);
    const model = request?.model;
    const operation = GHOST_DIRECT_MEDIA_OPERATIONS.find(value => value === request?.operation);
    if (!request || typeof model !== 'string' || !model || model.length > 256 || !operation) {
      return failure('INVALID_INPUT', '请指定有效的媒体操作和模型');
    }
    if (!context.isCurrent() || !deps.allowsModel(model, operation)) return denied();

    let connection: ReturnType<Dependencies['getConnection']>;
    try {
      connection = deps.getConnection();
    } catch {
      return failure('CONNECTION_UNAVAILABLE', '当前账号的 Cindy AI 网关连接未就绪');
    }
    let path: string;
    let modelPath: string[] | undefined = ['model'];
    let method: 'GET' | 'POST' = 'POST';
    let headers: Record<string, string> = {};
    let timeoutMs = MAX_REQUEST_MS;
    let maxResponseBytes = MAX_PAYLOAD_BYTES;
    let maxRequestBytes = MAX_PAYLOAD_BYTES;
    let taskIdPath: string[] | undefined;
    let pollGuide: MediaAsyncPollGuide | undefined;
    let wireBody: BodyInit | undefined;

    try {
      if (operation === 'video.poll' || operation === 'video.content') {
        const job = typeof request.jobRef === 'string' ? videoReferences.get(request.jobRef) : undefined;
        if (!job || job.expiresAt <= Date.now() || job.owner !== context.owner
          || job.instance !== context.instance || job.model !== model || job.endpoint !== connection.baseUrl) {
          return failure('JOB_UNAVAILABLE', '视频任务引用无效或已过期');
        }
        const poll = job.poll;
        if (operation === 'video.content' && !poll.contentPath) {
          return failure('UNAVAILABLE', '此模型没有独立的视频内容接口');
        }
        path = (operation === 'video.content' ? poll.contentPath! : poll.path)
          .replaceAll('{taskId}', encodeURIComponent(job.taskId));
        method = operation === 'video.content' ? 'GET' : poll.method;
        timeoutMs = Math.min(timeoutMs, poll.timeoutMs);
        if (operation === 'video.poll') {
          headers = poll.headers ?? {};
          maxResponseBytes = Math.min(maxResponseBytes, poll.maxResponseBytes);
          if (method === 'POST') {
            wireBody = JSON.stringify(poll.bodyTaskIdPath ? withField({}, poll.bodyTaskIdPath, job.taskId) : {});
          }
        }
      } else {
        if (operation === 'image.generate' || operation === 'video.generate') {
          const { guide } = await deps.getGuide(model);
          if (!context.isCurrent()) return denied();
          const media = guide.operations.find(item => item.capability === operation);
          if (!media || media.request.bodyEncoding === 'multipart') {
            return failure('UNAVAILABLE', '此模型没有可用的 Cindy AI JSON 媒体接口');
          }
          path = media.request.path;
          modelPath = media.request.bodyModelPath;
          headers = media.request.headers ?? {};
          timeoutMs = Math.min(timeoutMs, media.request.timeoutMs);
          maxRequestBytes = Math.min(maxRequestBytes, media.request.maxRequestBytes);
          maxResponseBytes = Math.min(maxResponseBytes, media.request.maxResponseBytes);
          if (operation === 'video.generate' && media.response.mode === 'async') {
            taskIdPath = media.response.taskIdPath;
            pollGuide = media.response.poll;
          }
        } else {
          const prefix = new URL(connection.baseUrl).pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
          path = `${prefix}/v1/audio/${operation === 'audio.speech' ? 'speech' : 'transcriptions'}`;
        }

        const body = record(request.body);
        if (!body || (Object.hasOwn(body, 'model') && body.model !== model)) {
          return failure('INVALID_INPUT', '请求体无效或模型字段与指定模型不一致');
        }
        const modelBody = modelPath ? withField(body, modelPath, model) : body;
        if (!modelBody) return failure('INVALID_INPUT', '请求体中的模型与指定模型不一致');
        if (operation === 'audio.transcribe') {
          wireBody = await audioForm(modelBody, request.audioHash, context);
          if (!wireBody) return context.isCurrent()
            ? failure('INVALID_INPUT', '仅支持当前插件有权使用的有界音频文件和文本表单字段') : denied();
        } else {
          wireBody = JSON.stringify(modelBody);
          if (Buffer.byteLength(wireBody) > maxRequestBytes) {
            return failure('INVALID_INPUT', '请求体超过媒体接口大小限制');
          }
        }
      }
    } catch {
      return context.isCurrent() ? failure('UNAVAILABLE', '无法准备媒体请求') : denied();
    }

    const base = new URL(connection.baseUrl);
    const url = new URL(path.replaceAll('{model}', encodeURIComponent(model)), base.origin);
    if (url.origin !== base.origin) return denied();
    if (!context.isCurrent() || !deps.allowsModel(model, operation)) return denied();
    try {
      const currentConnection = deps.getConnection();
      if (currentConnection.baseUrl !== connection.baseUrl) return denied();
      connection = currentConnection;
    } catch {
      return denied();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await deps.send(url.toString(), {
        method,
        headers: {
          ...(typeof wireBody === 'string' ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
          Authorization: `Bearer ${connection.apiKey}`,
        },
        body: wireBody,
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status === 401) connection.onUnauthorized();
      const bytes = await readResponse(response, maxResponseBytes);
      if (!context.isCurrent()) return denied();
      if (!bytes) return failure('RESPONSE_TOO_LARGE', '网关响应超过媒体接口大小限制');
      const contentType = (response.headers.get('content-type') ?? '')
        .replaceAll(connection.apiKey, '[redacted]');
      const binary = /^(?:audio|image|video)\//i.test(contentType)
        || /^application\/octet-stream(?:;|$)/i.test(contentType)
        || (!contentType && response.ok && (operation === 'audio.speech' || operation === 'video.content'));
      if (binary && bytes.includes(connection.apiKey)) return failure('INTERNAL', '网关响应包含敏感数据');
      const body = binary ? bytes.toString('base64') : bytes.toString('utf8').replaceAll(connection.apiKey, '[redacted]');
      const result: GhostDirectMediaResponse = {
        ok: true, status: response.status, contentType, body, encoding: binary ? 'base64' : 'utf8',
      };
      if (response.ok && taskIdPath && pollGuide) {
        let taskId: unknown;
        try { taskId = readField(JSON.parse(body), taskIdPath); } catch { /* Keep the upstream reply. */ }
        if (typeof taskId === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,255}$/.test(taskId)) {
          const now = Date.now();
          for (const [ref, entry] of videoReferences) {
            if (entry.expiresAt <= now) videoReferences.delete(ref);
          }
          if (videoReferences.size >= MAX_VIDEO_REFERENCES) {
            const oldest = videoReferences.keys().next().value;
            if (oldest) videoReferences.delete(oldest);
          }
          result.jobRef = randomUUID();
          videoReferences.set(result.jobRef, {
            owner: context.owner, instance: context.instance, model, endpoint: connection.baseUrl,
            taskId, poll: pollGuide, expiresAt: now + GHOST_CINDY_JOB_TTL_MS,
          });
        }
      }
      return result;
    } catch {
      return context.isCurrent() ? failure('OUTCOME_UNKNOWN', '未收到网关响应，无法确认请求是否已执行') : denied();
    } finally {
      clearTimeout(timeout);
    }
  };
}
