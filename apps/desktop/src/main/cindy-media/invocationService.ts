import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { MediaCapability } from '@cindy/model-providers';
import type { CindyMediaToolRequest } from 'cindy-tools';
import type {
  MediaAsyncPollGuide,
  MediaMultipartFileGuide,
  PreparedMediaInvocationGuide,
  MediaResultExtractor,
  MediaResultKind,
  ResolvedMediaInvocationGuide,
} from '../../shared/mediaInvocation.js';
import { MODEL_ACCESS_INVOCATION_GUIDE_SCHEMA_VERSION } from '../../shared/mediaInvocation.js';
import { GHOST_IMAGE_ASPECT_RATIOS, type GhostImageAspectRatio } from '../../shared/ghost.js';
import { getAppCapabilities } from '../appCapabilities.js';
import * as authManager from '../authManager.js';
import * as imageCacheStore from '../imageCacheStore.js';
import { createLogger } from '../logger.js';
import { ServerApiError } from '../serverApiClient.js';
import { getCurrentDbClientUserId, getDbClient } from '../localDb/client/current.js';
import type { DbClient } from '../localDb/client/DbClient.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { outboundFetch } from '../maker-host/outbound-fetch.js';
import {
  fetchMediaInvocationGuide,
  listAvailableMediaModels,
  listExecutableMediaModels,
  MediaGuideCompatibilityError,
  MediaModelCatalogError,
} from '../model-access/mediaModels.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import * as blobStore from './blobStore.js';
import { ingestMedia } from './ingest.js';
import { mediaRequestParamsForLog, mediaRequestUrlForLog } from './mediaRequestLog.js';
import {
  invokeProviderMedia,
  resolveProviderMediaModel,
  type ProviderMediaRuntimeModel,
} from './providerMediaRuntime.js';
import { sniffMediaMime } from './sniffMediaMime.js';
import {
  countMediaInvocations,
  createMediaInvocation,
  getMediaInvocation,
  pruneMediaInvocations,
  recoverInterruptedMediaInvocations,
  transitionMediaInvocation,
  type StoredMediaInvocation,
} from './mediaInvocationStore.js';

const log = createLogger('cindyMediaInvocation');
const INVOCATION_TTL_MS = 6 * 60 * 60 * 1_000;
const PREPARED_INVOCATION_TTL_MS = 5 * 60 * 1_000;
const MAX_INVOCATIONS = 128;
const MAX_LOCAL_MEDIA_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_RESULT_BYTES = 32 * 1024 * 1024;
const MAX_AUDIO_RESULT_BYTES = 128 * 1024 * 1024;
const MAX_VIDEO_RESULT_BYTES = 256 * 1024 * 1024;
const MAX_MEDIA_RESULTS = 16;
const MAX_LOCAL_MEDIA_INPUTS = 32;
const MAX_LOCAL_MEDIA_INPUT_TOTAL_BYTES = 128 * 1024 * 1024;
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const TERMINAL_MEDIA_RESULT_ERRORS = new Set([
  'MEDIA_DOWNLOAD_REJECTED',
  'MEDIA_RESULT_INVALID',
  'MEDIA_RESULT_MISSING',
  'MEDIA_RESULT_TOO_LARGE',
  'RESPONSE_TOO_LARGE',
]);
const CLIENT_PROVIDER_IMAGE_GUIDE_ID = 'cindy-provider-image-v1';

interface MediaConnection {
  baseUrl: string;
  apiKey: string;
}

class MediaInvocationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = 'MediaInvocationError';
  }
}

const recoveredDatabases = new WeakSet<DbClient>();

interface MediaAuthScope {
  owner: string;
  dbOwnerId: string;
  generation: number;
}

function currentAuthScope(): MediaAuthScope {
  const state = authManager.getAuthState();
  const userId = state.user?.id ?? null;
  const dbOwnerId = state.dataOwnerId;
  if (!userId || !dbOwnerId) {
    throw new MediaInvocationError('CONNECTION_UNAVAILABLE', '当前没有可用的 Cindy 登录态');
  }
  return {
    owner: `${authManager.getActiveAuthRealm()}:${userId}`,
    dbOwnerId,
    generation: state.ownerGeneration,
  };
}

function assertAuthScope(scope: MediaAuthScope, expectedOwner = scope.owner): void {
  const current = currentAuthScope();
  if (
    current.owner !== expectedOwner ||
    current.dbOwnerId !== scope.dbOwnerId ||
    current.generation !== scope.generation
  ) {
    throw new MediaInvocationError(
      'ACCOUNT_CHANGED',
      '媒体调用期间 Cindy 账号发生变化，请在当前账号下重新准备',
    );
  }
}

function captureMediaDb(scope: MediaAuthScope): DbClient {
  assertAuthScope(scope);
  const dbOwnerId = getCurrentDbClientUserId();
  if (dbOwnerId !== scope.dbOwnerId) {
    throw new MediaInvocationError(
      dbOwnerId ? 'ACCOUNT_CHANGED' : 'CONNECTION_UNAVAILABLE',
      dbOwnerId ? '媒体调用期间 Cindy 账号发生变化' : '当前账号的本地数据尚未就绪',
    );
  }
  const db = getDbClient();
  assertAuthScope(scope);
  return db;
}

async function ensureOwnerRecovered(scope: MediaAuthScope, db: DbClient): Promise<void> {
  if (recoveredDatabases.has(db)) return;
  recoveredDatabases.add(db);
  try {
    await recoverInterruptedMediaInvocations(scope.owner, db);
    assertAuthScope(scope);
  } catch (error) {
    recoveredDatabases.delete(db);
    throw error;
  }
}

async function pruneInvocations(owner: string, db: DbClient): Promise<void> {
  const now = Date.now();
  await pruneMediaInvocations(
    {
      owner,
      preparedBefore: now - PREPARED_INVOCATION_TTL_MS,
      terminalBefore: now - INVOCATION_TTL_MS,
    },
    db,
  );
}

function failure(
  code: string,
  message: string,
  retryable = false,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ok: false, errorCode: code, message, retryable, ...details };
}

const GUIDE_FALLBACK_ACTIONS = [
  'choose_another_model',
  'use_another_tool',
  'use_legacy_adapter_if_available',
] as const;

function submissionOutcomeUnknown(message: string): Record<string, unknown> {
  return failure('SUBMISSION_OUTCOME_UNKNOWN', message, false, {
    outcomeKnown: false,
    allowedActions: [
      'wait_or_check_existing_task',
      'ask_user_before_new_submission',
      'use_another_tool',
    ],
  });
}

function providerImageGuide(
  model: ProviderMediaRuntimeModel,
  capability: 'image.generate' | 'image.edit',
): PreparedMediaInvocationGuide {
  const edit = capability === 'image.edit';
  return {
    schemaVersion: MODEL_ACCESS_INVOCATION_GUIDE_SCHEMA_VERSION,
    guideId: CLIENT_PROVIDER_IMAGE_GUIDE_ID,
    modelId: model.id,
    revision: '1',
    connection: { providerId: model.providerId },
    capability,
    request: {
      method: 'POST',
      path: '/client-provider-media',
      bodyEncoding: 'json',
      bodyModelPath: ['model'],
      timeoutMs: 600_000,
      maxRequestBytes: MAX_LOCAL_MEDIA_INPUT_TOTAL_BYTES + 1024 * 1024,
      maxResponseBytes: MAX_IMAGE_RESULT_BYTES,
    },
    response: {
      mode: 'sync',
      media: [{ path: ['image'], encoding: 'base64', kind: 'image' }],
    },
    instructions: edit
      ? '必填 prompt 和 image。image 可传一条 Cindy 本地媒体引用或引用数组；可选 aspect_ratio。'
      : '必填 prompt；可选 aspect_ratio。model 与凭证由 Cindy 注入。',
    exampleBody: {
      prompt: edit ? '描述希望如何修改图片' : '描述希望生成的图片',
      ...(edit ? { image: 'cindy-media://blobs/<hash>.png' } : {}),
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: edit ? ['prompt', 'image'] : ['prompt'],
      properties: {
        prompt: { type: 'string', minLength: 1 },
        ...(edit
          ? {
              image: {
                oneOf: [
                  { type: 'string', minLength: 1 },
                  { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
                ],
              },
            }
          : {}),
        aspect_ratio: { type: 'string', enum: [...GHOST_IMAGE_ASPECT_RATIOS] },
      },
    },
    officialDocs: model.officialDocs ?? 'https://platform.openai.com/docs/guides/images',
  };
}

function isClientProviderInvocation(invocation: StoredMediaInvocation): boolean {
  return invocation.guide.guideId === CLIENT_PROVIDER_IMAGE_GUIDE_ID;
}

function resolveConnection(providerId: string): MediaConnection {
  if (providerId !== 'xd') {
    throw new MediaInvocationError(
      'CONNECTION_NOT_SUPPORTED',
      `当前 Cindy 版本没有注册媒体连接 ${JSON.stringify(providerId)}`,
    );
  }
  if (!getAppCapabilities().canUseCindyGateway) {
    throw new MediaInvocationError('CONNECTION_UNAVAILABLE', '当前账号不能使用 Cindy AI 网关');
  }
  const baseUrl = effectiveXdGatewayBaseUrl().trim();
  const apiKey = getProviderSecretStore().get('xd')?.trim() ?? '';
  if (!baseUrl || !apiKey) {
    throw new MediaInvocationError('CONNECTION_UNAVAILABLE', 'Cindy AI 连接尚未就绪，请先完成登录');
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new MediaInvocationError('CONNECTION_INVALID', 'Cindy AI endpoint 不合法');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password
  ) {
    throw new MediaInvocationError('CONNECTION_INVALID', 'Cindy AI endpoint 不合法');
  }
  return { baseUrl, apiKey };
}

function requestUrl(baseUrl: string, relativePath: string): string {
  const base = new URL(baseUrl);
  if (
    !relativePath.startsWith('/') ||
    relativePath.startsWith('//') ||
    relativePath.includes('://')
  ) {
    throw new MediaInvocationError('GUIDE_INVALID', '调用说明包含不安全的请求路径');
  }
  const resolved = new URL(relativePath, base.origin);
  if (resolved.origin !== base.origin) {
    throw new MediaInvocationError('GUIDE_INVALID', '调用说明的请求路径越出 Gateway origin');
  }
  return resolved.toString();
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    throw new MediaInvocationError('RESPONSE_TOO_LARGE', `上游响应超过 ${maxBytes} 字节限制`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new MediaInvocationError('RESPONSE_TOO_LARGE', `上游响应超过 ${maxBytes} 字节限制`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size,
  );
}

function providerErrorMessage(buffer: Buffer): string {
  const text = buffer.toString('utf8').slice(0, 2_000);
  try {
    const value = JSON.parse(text) as {
      error?: { message?: unknown };
      message?: unknown;
      msg?: unknown;
    };
    const message = value.error?.message ?? value.message ?? value.msg;
    if (typeof message !== 'string' || !message.trim()) return '上游拒绝请求';
    return message
      .replace(/data:[^,\s]{1,128};base64,[A-Za-z0-9+/=\s]+/gi, '[已脱敏 data URL]')
      .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '[已脱敏 URL]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/gi, 'Bearer [已脱敏]')
      .replace(/\b[A-Za-z0-9+/_-]{80,}={0,2}\b/g, '[已脱敏长值]')
      .slice(0, 500);
  } catch {
    return '上游拒绝请求';
  }
}

function multipartRequestBody(
  body: Record<string, unknown>,
  fileGuides: readonly MediaMultipartFileGuide[],
): FormData {
  const form = new FormData();
  const filesByBodyField = new Map(fileGuides.map((guide) => [guide.bodyField, guide]));
  for (const [field, value] of Object.entries(body)) {
    const fileGuide = filesByBodyField.get(field);
    if (!fileGuide) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        form.append(field, String(value));
        continue;
      }
      if (value === undefined || value === null) continue;
      throw new MediaInvocationError(
        'REQUEST_INVALID',
        `multipart 字段 ${field} 必须是字符串、数字或布尔值`,
      );
    }

    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0 || values.length > fileGuide.maxItems) {
      throw new MediaInvocationError(
        'MEDIA_INPUT_INVALID',
        `媒体字段 ${field} 必须包含 1–${fileGuide.maxItems} 个文件`,
      );
    }
    for (const [index, item] of values.entries()) {
      if (typeof item !== 'string') {
        throw new MediaInvocationError('MEDIA_INPUT_INVALID', `媒体字段 ${field} 必须是媒体地址`);
      }
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(item);
      if (!match) {
        throw new MediaInvocationError(
          'MEDIA_INPUT_INVALID',
          `multipart 媒体字段 ${field} 必须使用 Cindy 受管媒体`,
        );
      }
      const mimeType = match[1].toLowerCase();
      const buffer = Buffer.from(match[2].replace(/[\r\n]/g, ''), 'base64');
      if (
        buffer.byteLength === 0 ||
        !mimeType.startsWith(`${fileGuide.kind}/`) ||
        !blobStore.supportedMime(mimeType) ||
        sniffMediaMime(buffer, mimeType) !== mimeType
      ) {
        throw new MediaInvocationError(
          'MEDIA_INPUT_INVALID',
          `媒体字段 ${field} 不是 Cindy 支持的 ${fileGuide.kind} 文件`,
        );
      }
      const extension =
        ({
          'image/jpeg': 'jpg',
          'video/quicktime': 'mov',
          'audio/mpeg': 'mp3',
          'audio/mp4': 'm4a',
        } as Record<string, string>)[mimeType] ?? mimeType.split('/')[1];
      form.append(
        fileGuide.formField,
        new Blob([buffer], { type: mimeType }),
        `${field}-${index + 1}.${extension}`,
      );
    }
  }
  return form;
}

async function dispatchRequest(input: {
  invocationId: string;
  providerId: string;
  modelId: string;
  capability: MediaCapability;
  connection: MediaConnection;
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  bodyEncoding?: 'json' | 'multipart';
  multipartFiles?: readonly MediaMultipartFileGuide[];
  timeoutMs: number;
  maxResponseBytes: number;
  operation: 'submit' | 'poll';
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  timeout.unref?.();
  const url = requestUrl(input.connection.baseUrl, input.path);
  const startedAt = Date.now();
  const requestLog = {
    invocationId: input.invocationId,
    providerId: input.providerId,
    modelId: input.modelId,
    capability: input.capability,
    operation: input.operation,
    method: input.method,
    url: mediaRequestUrlForLog(url),
  };
  let responseStatus: number | undefined;
  try {
    const requestBody = input.body
      ? input.bodyEncoding === 'multipart'
        ? multipartRequestBody(input.body, input.multipartFiles ?? [])
        : JSON.stringify(input.body)
      : undefined;
    log.info('media request dispatch', {
      ...requestLog,
      params: mediaRequestParamsForLog(input.body ?? {}),
    });
    const response = await outboundFetch(url, {
      method: input.method,
      headers: {
        Accept: 'application/json',
        ...(input.body && input.bodyEncoding !== 'multipart'
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(input.headers ?? {}),
        Authorization: `Bearer ${input.connection.apiKey}`,
      },
      ...(requestBody ? { body: requestBody } : {}),
      redirect: 'error',
      signal: controller.signal,
    });
    responseStatus = response.status;
    log.info('media request response', {
      ...requestLog,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    const buffer = await readBoundedResponse(response, input.maxResponseBytes);
    if (!response.ok) {
      const message = providerErrorMessage(buffer);
      if (response.status >= 500) {
        if (input.operation === 'poll') {
          throw new MediaInvocationError(
            'POLL_UNAVAILABLE',
            `上游状态查询返回 HTTP ${response.status}，可稍后重试`,
          );
        }
        throw new MediaInvocationError(
          'SUBMISSION_OUTCOME_UNKNOWN',
          `上游返回 HTTP ${response.status}，无法确认任务是否已经创建；不要自动重提`,
          true,
        );
      }
      throw new MediaInvocationError(
        'UPSTREAM_REJECTED',
        `上游返回 HTTP ${response.status}: ${message}`,
      );
    }
    try {
      return JSON.parse(buffer.toString('utf8')) as unknown;
    } catch {
      if (input.operation === 'submit') {
        throw new MediaInvocationError(
          'SUBMISSION_OUTCOME_UNKNOWN',
          '上游已返回成功状态，但响应不是合法 JSON，无法确认任务结果；不要自动重提',
          true,
        );
      }
      throw new MediaInvocationError('UPSTREAM_RESPONSE_INVALID', '上游成功响应不是合法 JSON');
    }
  } catch (error) {
    log.warn('media request failed', {
      ...requestLog,
      ...(responseStatus !== undefined ? { status: responseStatus } : {}),
      durationMs: Date.now() - startedAt,
      error: mediaRequestParamsForLog(error instanceof Error ? error.message : String(error)),
    });
    if (error instanceof MediaInvocationError) throw error;
    const aborted = error instanceof Error && error.name === 'AbortError';
    if (input.operation === 'poll') {
      throw new MediaInvocationError(
        'POLL_UNAVAILABLE',
        aborted ? '上游状态查询超时，可稍后重试' : '上游状态查询网络失败，可稍后重试',
      );
    }
    throw new MediaInvocationError(
      'SUBMISSION_OUTCOME_UNKNOWN',
      aborted
        ? '上游请求超时，无法确认任务是否已经创建；不要自动重提'
        : '上游网络请求失败，无法确认任务是否已经创建；不要自动重提',
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function setObjectPath(
  target: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  let cursor: Record<string, unknown> = target;
  for (const [index, segment] of path.entries()) {
    if (!segment || segment === '*' || FORBIDDEN_PATH_SEGMENTS.has(segment)) {
      throw new MediaInvocationError('GUIDE_INVALID', '调用说明包含不安全的注入路径');
    }
    if (index === path.length - 1) {
      cursor[segment] = value;
      return;
    }
    const next = cursor[segment];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
}

function valuesAtPath(value: unknown, path: readonly string[]): unknown[] {
  let values = [value];
  for (const segment of path) {
    const next: unknown[] = [];
    for (const candidate of values) {
      if (segment === '*') {
        if (Array.isArray(candidate)) next.push(...candidate);
        else if (candidate && typeof candidate === 'object') {
          next.push(...Object.values(candidate as Record<string, unknown>));
        }
      } else if (candidate && typeof candidate === 'object') {
        const child = (candidate as Record<string, unknown>)[segment];
        if (child !== undefined) next.push(child);
      }
    }
    values = next;
  }
  return values;
}

async function localMediaDataUrl(
  ref: string,
  state: { localInputs: number; localBytes: number },
): Promise<string | null> {
  let buffer: Buffer;
  let mimeType: string;
  if (ref.startsWith('cindy-media://')) {
    const loaded = await blobStore.readFile(ref);
    buffer = loaded.buffer;
    mimeType = loaded.mimeType;
  } else if (ref.startsWith('xdt-image://')) {
    const resolved = imageCacheStore.resolveSafe(ref);
    buffer = await fs.readFile(resolved.absPath);
    mimeType = resolved.mimeType;
  } else {
    return null;
  }
  state.localInputs += 1;
  state.localBytes += buffer.byteLength;
  if (
    state.localInputs > MAX_LOCAL_MEDIA_INPUTS ||
    state.localBytes > MAX_LOCAL_MEDIA_INPUT_TOTAL_BYTES
  ) {
    throw new MediaInvocationError('MEDIA_INPUT_INVALID', '本地参考媒体数量或总大小超过限制');
  }
  const supportedKind = ['image/', 'video/', 'audio/'].some((prefix) => mimeType.startsWith(prefix));
  if (
    buffer.byteLength > MAX_LOCAL_MEDIA_INPUT_BYTES ||
    !supportedKind ||
    !blobStore.supportedMime(mimeType)
  ) {
    throw new MediaInvocationError(
      'MEDIA_INPUT_INVALID',
      `本地参考媒体必须是 ${MAX_LOCAL_MEDIA_INPUT_BYTES} 字节以内的受支持文件`,
    );
  }
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

async function expandLocalMediaRefs(
  value: unknown,
  state: { nodes: number; localInputs: number; localBytes: number },
  depth = 0,
): Promise<unknown> {
  state.nodes += 1;
  if (depth > 24 || state.nodes > 10_000) {
    throw new MediaInvocationError('REQUEST_INVALID', '请求 body 嵌套过深或字段过多');
  }
  if (typeof value === 'string') return (await localMediaDataUrl(value, state)) ?? value;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) output.push(await expandLocalMediaRefs(item, state, depth + 1));
    return output;
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_PATH_SEGMENTS.has(key)) {
        throw new MediaInvocationError('REQUEST_INVALID', `请求 body 包含非法字段 ${key}`);
      }
      output[key] = await expandLocalMediaRefs(child, state, depth + 1);
    }
    return output;
  }
  return value;
}

async function prepareRequestBody(
  body: Record<string, unknown>,
  guide: PreparedMediaInvocationGuide,
): Promise<Record<string, unknown>> {
  const expanded = await expandLocalMediaRefs(body, { nodes: 0, localInputs: 0, localBytes: 0 });
  if (!expanded || typeof expanded !== 'object' || Array.isArray(expanded)) {
    throw new MediaInvocationError('REQUEST_INVALID', '请求 body 必须是 JSON 对象');
  }
  const output = expanded as Record<string, unknown>;
  setObjectPath(output, guide.request.bodyModelPath, guide.modelId);
  const bytes = Buffer.byteLength(JSON.stringify(output), 'utf8');
  if (bytes > guide.request.maxRequestBytes) {
    throw new MediaInvocationError(
      'REQUEST_TOO_LARGE',
      `请求 body 超过 ${guide.request.maxRequestBytes} 字节限制`,
    );
  }
  return output;
}

async function localImagePath(
  ref: string,
  state: { localInputs: number; localBytes: number },
): Promise<string> {
  let resolved: { absPath: string; mimeType: string };
  try {
    if (ref.startsWith('cindy-media://')) resolved = blobStore.resolveSafe(ref);
    else if (ref.startsWith('xdt-image://')) resolved = imageCacheStore.resolveSafe(ref);
    else throw new Error('unsupported local media reference');
  } catch {
    throw new MediaInvocationError(
      'MEDIA_INPUT_INVALID',
      '第三方 Provider 参考图必须是 Cindy 本地媒体引用',
    );
  }
  const stat = await fs.stat(resolved.absPath);
  state.localInputs += 1;
  state.localBytes += stat.size;
  if (
    state.localInputs > MAX_LOCAL_MEDIA_INPUTS ||
    state.localBytes > MAX_LOCAL_MEDIA_INPUT_TOTAL_BYTES ||
    stat.size <= 0 ||
    stat.size > MAX_LOCAL_MEDIA_INPUT_BYTES ||
    !resolved.mimeType.startsWith('image/')
  ) {
    throw new MediaInvocationError('MEDIA_INPUT_INVALID', '参考图数量、大小或格式不受支持');
  }
  return resolved.absPath;
}

async function providerImageRequest(
  invocation: StoredMediaInvocation,
  body: Record<string, unknown>,
): Promise<{
  prompt: string;
  imagePaths: string[];
  aspectRatio?: GhostImageAspectRatio;
}> {
  const prompt = body.prompt;
  if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > 100_000) {
    throw new MediaInvocationError('REQUEST_INVALID', 'prompt 必须是非空字符串');
  }
  let aspectRatio: GhostImageAspectRatio | undefined;
  if (body.aspect_ratio !== undefined) {
    if (
      typeof body.aspect_ratio !== 'string' ||
      !(GHOST_IMAGE_ASPECT_RATIOS as readonly string[]).includes(body.aspect_ratio)
    ) {
      throw new MediaInvocationError(
        'REQUEST_INVALID',
        `aspect_ratio 只支持 ${GHOST_IMAGE_ASPECT_RATIOS.join(' / ')}`,
      );
    }
    aspectRatio = body.aspect_ratio as GhostImageAspectRatio;
  }
  const imagePaths: string[] = [];
  if (invocation.capability === 'image.edit') {
    const raw = body.image;
    const refs = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
    if (
      refs.length === 0 ||
      refs.some((value) => typeof value !== 'string' || value.length === 0)
    ) {
      throw new MediaInvocationError('REQUEST_INVALID', 'image.edit 必须提供本地图片引用');
    }
    const state = { localInputs: 0, localBytes: 0 };
    for (const ref of refs as string[]) imagePaths.push(await localImagePath(ref, state));
  }
  return {
    prompt,
    imagePaths,
    ...(aspectRatio ? { aspectRatio } : {}),
  };
}

function maxResultBytes(kind: MediaResultKind): number {
  if (kind === 'image') return MAX_IMAGE_RESULT_BYTES;
  if (kind === 'audio') return MAX_AUDIO_RESULT_BYTES;
  return MAX_VIDEO_RESULT_BYTES;
}

function assertResultMime(kind: MediaResultKind, mimeType: string): void {
  if (!mimeType.startsWith(`${kind}/`) || !blobStore.supportedMime(mimeType)) {
    throw new MediaInvocationError(
      'MEDIA_RESULT_INVALID',
      `上游返回的字节不是 Cindy 支持的 ${kind} 媒体`,
    );
  }
}

function allowedDownloadUrl(raw: string, extractor: MediaResultExtractor): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new MediaInvocationError('MEDIA_RESULT_INVALID', '上游媒体 URL 不合法');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new MediaInvocationError('MEDIA_RESULT_INVALID', '上游媒体 URL 必须是 HTTPS');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.port) {
    throw new MediaInvocationError('MEDIA_RESULT_INVALID', '上游媒体 URL 不允许自定义端口');
  }
  const allowed = (extractor.allowedUrlHosts ?? []).some((suffix) => {
    const normalized = suffix.toLowerCase();
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
  if (!allowed) {
    throw new MediaInvocationError('MEDIA_RESULT_INVALID', '上游媒体 URL 不在调用说明的可信域名内');
  }
  return parsed;
}

async function mediaBytes(
  raw: string,
  extractor: MediaResultExtractor,
): Promise<{ buffer: Buffer; mimeType: string }> {
  let buffer: Buffer;
  let headerMime: string | null = null;
  if (extractor.encoding === 'url') {
    const url = allowedDownloadUrl(raw, extractor);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    timeout.unref?.();
    try {
      const response = await outboundFetch(url.toString(), {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        const permanentClientError =
          response.status >= 400 &&
          response.status < 500 &&
          ![408, 425, 429].includes(response.status);
        throw new MediaInvocationError(
          permanentClientError ? 'MEDIA_DOWNLOAD_REJECTED' : 'MEDIA_DOWNLOAD_FAILED',
          `媒体下载失败 (HTTP ${response.status})`,
        );
      }
      headerMime =
        response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? null;
      buffer = await readBoundedResponse(response, maxResultBytes(extractor.kind));
    } catch (error) {
      if (error instanceof MediaInvocationError) throw error;
      throw new MediaInvocationError('MEDIA_DOWNLOAD_FAILED', '媒体下载超时或网络失败');
    } finally {
      clearTimeout(timeout);
    }
  } else {
    const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(raw);
    const encoded = (dataUrl ? dataUrl[2] : raw).replace(/\s/g, '');
    headerMime = dataUrl?.[1]?.toLowerCase() ?? null;
    if (encoded.length > Math.ceil((maxResultBytes(extractor.kind) * 4) / 3) + 16) {
      throw new MediaInvocationError('MEDIA_RESULT_TOO_LARGE', '上游 base64 媒体超过大小限制');
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new MediaInvocationError('MEDIA_RESULT_INVALID', '上游 base64 媒体编码不合法');
    }
    buffer = Buffer.from(encoded, 'base64');
  }
  if (buffer.byteLength === 0 || buffer.byteLength > maxResultBytes(extractor.kind)) {
    throw new MediaInvocationError('MEDIA_RESULT_INVALID', '上游返回空媒体或媒体超过大小限制');
  }
  // Guide / Content-Type 只能帮助识别容器变体（例如无 ftyp 的 QuickTime），
  // 不能在魔数识别失败时替上游字节“声明”一个可信类型。
  const declaredMime = extractor.mediaType ?? headerMime ?? '';
  const mimeType = sniffMediaMime(buffer, declaredMime);
  if (!mimeType) throw new MediaInvocationError('MEDIA_RESULT_INVALID', '无法从上游字节识别媒体类型');
  assertResultMime(extractor.kind, mimeType);
  return { buffer, mimeType };
}

async function materializeResults(
  payload: unknown,
  extractors: readonly MediaResultExtractor[],
  scope: MediaAuthScope,
  db: DbClient,
): Promise<Record<string, unknown>> {
  const found: Array<{ raw: string; extractor: MediaResultExtractor }> = [];
  const seen = new Set<string>();
  for (const extractor of extractors) {
    for (const value of valuesAtPath(payload, extractor.path)) {
      if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue;
      seen.add(value);
      found.push({ raw: value, extractor });
      if (found.length > MAX_MEDIA_RESULTS) {
        throw new MediaInvocationError('MEDIA_RESULT_INVALID', '上游返回的媒体结果数量超过限制');
      }
    }
  }
  if (found.length === 0) {
    throw new MediaInvocationError('MEDIA_RESULT_MISSING', '上游成功响应中没有找到媒体结果');
  }
  const images: string[] = [];
  const videos: string[] = [];
  const audio: string[] = [];
  for (const item of found) {
    assertAuthScope(scope);
    let media: Awaited<ReturnType<typeof mediaBytes>>;
    try {
      media = await mediaBytes(item.raw, item.extractor);
    } catch (error) {
      // 账号切换与下载失败同时发生时，账号边界优先，避免旧账号结果继续落状态。
      assertAuthScope(scope);
      throw error;
    }
    assertAuthScope(scope);
    const stored = await ingestMedia(
      {
        buffer: media.buffer,
        mimeType: media.mimeType,
        refs: [],
        assertStillValid: () => assertAuthScope(scope),
      },
      db.drizzle,
    );
    assertAuthScope(scope);
    if (item.extractor.kind === 'image') images.push(stored.url);
    else if (item.extractor.kind === 'video') videos.push(stored.url);
    else audio.push(stored.url);
  }
  return {
    ...(images.length > 0 ? { xdt_image_urls: images } : {}),
    ...(videos.length > 0 ? { xdt_video_urls: videos } : {}),
    ...(audio.length > 0
      ? { xdt_audio_tracks: audio.map((url) => ({ xdt_audio_url: url, kind: 'generated' })) }
      : {}),
  };
}

function persistedResponse(invocation: StoredMediaInvocation): unknown {
  if (!invocation.responseJson) {
    throw new MediaInvocationError('MEDIA_RESULT_MISSING', '已提交调用缺少可恢复的上游响应');
  }
  try {
    return JSON.parse(invocation.responseJson) as unknown;
  } catch {
    throw new MediaInvocationError('MEDIA_RESULT_INVALID', '已提交调用保存的上游响应不合法');
  }
}

function completedInvocationResult(invocation: StoredMediaInvocation): Record<string, unknown> {
  const media = persistedResponse(invocation);
  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    throw new MediaInvocationError('MEDIA_RESULT_INVALID', '已完成调用保存的媒体结果不合法');
  }
  return {
    ...(media as Record<string, unknown>),
    ok: true,
    status: 'complete',
    invocation_id: invocation.id,
  };
}

async function persistCompletedInvocation(
  invocation: StoredMediaInvocation,
  media: Record<string, unknown>,
  scope: MediaAuthScope,
  db: DbClient,
): Promise<Record<string, unknown>> {
  const responseJson = JSON.stringify(media);
  const persisted = await transitionMediaInvocation(
    {
      id: invocation.id,
      owner: invocation.owner,
      from: 'pending',
      to: 'complete',
      responseJson,
    },
    db,
  );
  assertAuthScope(scope, invocation.owner);
  if (persisted) {
    return completedInvocationResult({
      ...invocation,
      state: 'complete',
      responseJson,
    });
  }
  const current = await getMediaInvocation(invocation.id, invocation.owner, db);
  assertAuthScope(scope, invocation.owner);
  if (current?.state === 'complete' && current.responseJson) {
    return completedInvocationResult(current);
  }
  return failure('INTERNAL', '媒体结果已生成，但本地未能保存最终结果');
}

async function submitProviderInvocation(
  invocation: StoredMediaInvocation,
  body: Record<string, unknown>,
  scope: MediaAuthScope,
  db: DbClient,
): Promise<Record<string, unknown>> {
  const providerId = invocation.guide.connection.providerId;
  const providerModel = resolveProviderMediaModel(
    providerId,
    invocation.modelId,
    invocation.capability,
  );
  if (!providerModel) {
    return failure('MODEL_NOT_AVAILABLE', '该第三方媒体模型或执行来源已不可用，本次生成未发出');
  }
  const input = await providerImageRequest(invocation, body);
  assertAuthScope(scope, invocation.owner);
  const claimed = await transitionMediaInvocation(
    {
      id: invocation.id,
      owner: invocation.owner,
      from: 'prepared',
      to: 'submitting',
    },
    db,
  );
  if (!claimed) {
    const current = await getMediaInvocation(invocation.id, invocation.owner, db);
    assertAuthScope(scope, invocation.owner);
    return failure(
      'INVOCATION_ALREADY_USED',
      `该 invocation 当前状态为 ${current?.state ?? 'unknown'}；付费提交不可重复执行`,
    );
  }
  assertAuthScope(scope, invocation.owner);
  try {
    const result = await invokeProviderMedia({
      providerId,
      modelId: providerModel.id,
      capability: invocation.capability,
      ...input,
      signal: AbortSignal.timeout(invocation.guide.request.timeoutMs),
    });
    assertAuthScope(scope, invocation.owner);
    if (
      result.buffer.byteLength === 0 ||
      result.buffer.byteLength > MAX_IMAGE_RESULT_BYTES ||
      !result.mimeType.startsWith('image/') ||
      !blobStore.supportedMime(result.mimeType)
    ) {
      throw new MediaInvocationError('MEDIA_RESULT_INVALID', '第三方 Provider 返回了无效图片');
    }
    const stored = await ingestMedia(
      {
        buffer: result.buffer,
        mimeType: result.mimeType,
        refs: [],
        assertStillValid: () => assertAuthScope(scope, invocation.owner),
      },
      db.drizzle,
    );
    assertAuthScope(scope, invocation.owner);
    const media = { xdt_image_urls: [stored.url] };
    const responseJson = JSON.stringify(media);
    const persisted = await transitionMediaInvocation(
      {
        id: invocation.id,
        owner: invocation.owner,
        from: 'submitting',
        to: 'pending',
        responseJson,
      },
      db,
    );
    assertAuthScope(scope, invocation.owner);
    if (!persisted) {
      await transitionMediaInvocation(
        {
          id: invocation.id,
          owner: invocation.owner,
          from: 'submitting',
          to: 'unknown',
        },
        db,
      ).catch(() => false);
      return submissionOutcomeUnknown('第三方媒体已生成，但本地未能保存调用结果；不要自动重提');
    }
    return persistCompletedInvocation(
      { ...invocation, state: 'pending', responseJson },
      media,
      scope,
      db,
    );
  } catch (error) {
    await transitionMediaInvocation(
      {
        id: invocation.id,
        owner: invocation.owner,
        from: 'submitting',
        to: 'unknown',
      },
      db,
    ).catch(() => false);
    log.warn('provider media submission failed after claim', {
      providerId,
      modelId: providerModel.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return submissionOutcomeUnknown(
      error instanceof Error
        ? `第三方媒体请求未能确认结果：${error.message}`
        : '第三方媒体请求未能确认结果；不要自动重提',
    );
  }
}

async function materializeSyncInvocation(
  invocation: StoredMediaInvocation,
  response: unknown,
  scope: MediaAuthScope,
  db: DbClient,
): Promise<Record<string, unknown>> {
  const responseGuide = invocation.guide.response;
  if (responseGuide.mode !== 'sync') {
    throw new MediaInvocationError('MEDIA_RESULT_INVALID', '同步媒体调用缺少同步响应说明');
  }
  try {
    const media = await materializeResults(response, responseGuide.media, scope, db);
    assertAuthScope(scope, invocation.owner);
    return persistCompletedInvocation(invocation, media, scope, db);
  } catch (error) {
    assertAuthScope(scope, invocation.owner);
    if (error instanceof MediaInvocationError) {
      if (TERMINAL_MEDIA_RESULT_ERRORS.has(error.code)) {
        await transitionMediaInvocation(
          {
            id: invocation.id,
            owner: invocation.owner,
            from: 'pending',
            to: 'failed',
          },
          db,
        );
        assertAuthScope(scope, invocation.owner);
        return failure(error.code, error.message);
      }
      if (error.code === 'MEDIA_DOWNLOAD_FAILED') {
        return {
          ...failure(error.code, error.message, true),
          retry_action: 'request',
        };
      }
      throw error;
    }
    log.warn('sync media materialization failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ...failure('MEDIA_MATERIALIZATION_FAILED', '媒体结果暂时无法保存', true),
      retry_action: 'request',
    };
  }
}

async function prepareInvocation(
  providerId: string | undefined,
  modelId: string,
  capability: MediaCapability,
): Promise<Record<string, unknown>> {
  const scope = currentAuthScope();
  const owner = scope.owner;
  const db = captureMediaDb(scope);
  await ensureOwnerRecovered(scope, db);
  assertAuthScope(scope);
  const models = await listAvailableMediaModels(capability);
  assertAuthScope(scope);
  let matchingModels = models.filter(
    (candidate) => candidate.id === modelId && (!providerId || candidate.providerId === providerId),
  );
  if (!providerId && matchingModels.length === 0 && !modelId.includes('/')) {
    const legacyMatches = models.filter(
      (candidate) => candidate.id.slice(candidate.id.lastIndexOf('/') + 1) === modelId,
    );
    if (new Set(legacyMatches.map((candidate) => candidate.id)).size === 1) {
      matchingModels = legacyMatches;
    }
  }
  const model = providerId
    ? matchingModels[0]
    : (matchingModels.find((candidate) => candidate.providerId === 'xd') ??
      matchingModels[0]);
  if (!providerId && model && (model.id !== modelId || matchingModels.length !== 1)) {
    log.warn('legacy media prepare resolved to available model', {
      requestedModelId: modelId,
      resolvedProviderId: model.providerId,
      resolvedModelId: model.id,
      matchingProviderCount: matchingModels.length,
    });
  }
  if (!model) {
    return failure('MODEL_NOT_AVAILABLE', '该模型或指定 Provider 当前不可见，或不是请求的媒体类型');
  }
  const resolvedModelId = model.id;
  let preparedGuide: PreparedMediaInvocationGuide;
  if (model.providerId !== 'xd') {
    if (capability !== 'image.generate' && capability !== 'image.edit') {
      return failure('CAPABILITY_NOT_SUPPORTED', '该第三方 Provider 当前不支持请求的媒体能力');
    }
    const providerModel = resolveProviderMediaModel(
      model.providerId,
      resolvedModelId,
      capability,
    );
    if (!providerModel) {
      return failure('MODEL_NOT_AVAILABLE', '该第三方媒体模型或执行来源当前不可用');
    }
    preparedGuide = providerImageGuide(providerModel, capability);
  } else {
    let resolvedGuide: ResolvedMediaInvocationGuide;
    try {
      resolvedGuide = await fetchMediaInvocationGuide(resolvedModelId);
      assertAuthScope(scope);
    } catch (error) {
      if (error instanceof ServerApiError && error.code === 'MEDIA_INVOCATION_GUIDE_NOT_FOUND') {
        return failure('GUIDE_NOT_AVAILABLE', '该模型当前没有可用的调用说明', false, {
          outcomeKnown: true,
          allowedActions: GUIDE_FALLBACK_ACTIONS,
        });
      }
      if (error instanceof MediaGuideCompatibilityError) {
        log.warn('media Guide rejected by current client', {
          modelId: resolvedModelId,
          code: error.code,
          detail: error.detail,
        });
        return failure(error.code, error.message, false, {
          outcomeKnown: true,
          allowedActions: GUIDE_FALLBACK_ACTIONS,
        });
      }
      if (error instanceof ServerApiError) {
        return failure('GUIDE_SERVICE_UNAVAILABLE', '媒体调用说明暂时无法读取，请稍后重试', true, {
          outcomeKnown: true,
          allowedActions: GUIDE_FALLBACK_ACTIONS,
        });
      }
      throw error;
    }
    const operation = resolvedGuide.guide.operations.find(
      (candidate) => candidate.capability === capability,
    );
    if (!operation) {
      return failure(
        'CAPABILITY_NOT_SUPPORTED',
        '该模型的调用协议当前不支持请求的媒体能力',
        false,
        {
          outcomeKnown: true,
          allowedActions: GUIDE_FALLBACK_ACTIONS,
        },
      );
    }
    const { operations: _operations, ...guideProtocol } = resolvedGuide.guide;
    void _operations;
    preparedGuide = {
      // Guide 查询键不参与调用身份；配置、持久化和 Gateway 请求始终使用完整 modelId。
      modelId: resolvedModelId,
      ...guideProtocol,
      ...operation,
    };
  }
  await pruneInvocations(owner, db);
  assertAuthScope(scope);
  if ((await countMediaInvocations(owner, db)) >= MAX_INVOCATIONS) {
    return failure('TOO_MANY_INVOCATIONS', '媒体任务数量已达上限，请等待现有任务完成后重试');
  }
  assertAuthScope(scope);
  const id = randomUUID();
  const createdAt = Date.now();
  await createMediaInvocation(
    {
      id,
      owner,
      guide: preparedGuide,
      createdAt,
    },
    db,
  );
  assertAuthScope(scope);
  return {
    ok: true,
    status: 'prepared',
    invocation_id: id,
    provider_id: model.providerId,
    model_id: resolvedModelId,
    model_name: model.name ?? model.id,
    capability,
    guide_revision: preparedGuide.revision,
    instructions: preparedGuide.instructions,
    input_schema: preparedGuide.inputSchema,
    example_body: preparedGuide.exampleBody,
    official_docs: preparedGuide.officialDocs,
    guidance: '按 instructions/input_schema 组装 body；不要添加 model、endpoint、headers 或凭证。',
  };
}

async function requireInvocation(id: string): Promise<StoredMediaInvocation> {
  const scope = currentAuthScope();
  const owner = scope.owner;
  const db = captureMediaDb(scope);
  await ensureOwnerRecovered(scope, db);
  assertAuthScope(scope);
  await pruneInvocations(owner, db);
  assertAuthScope(scope);
  const invocation = await getMediaInvocation(id, owner, db);
  assertAuthScope(scope);
  if (!invocation)
    throw new MediaInvocationError('INVOCATION_NOT_FOUND', '调用已过期或不存在，请重新 prepare');
  return invocation;
}

async function submitInvocation(
  invocation: StoredMediaInvocation,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const scope = currentAuthScope();
  assertAuthScope(scope, invocation.owner);
  const db = captureMediaDb(scope);
  if (invocation.state === 'complete') {
    return completedInvocationResult(invocation);
  }
  if (
    invocation.state === 'pending' &&
    isClientProviderInvocation(invocation) &&
    invocation.responseJson
  ) {
    const media = persistedResponse(invocation);
    if (!media || typeof media !== 'object' || Array.isArray(media)) {
      return failure('MEDIA_RESULT_INVALID', '第三方媒体调用保存的结果不合法');
    }
    return persistCompletedInvocation(invocation, media as Record<string, unknown>, scope, db);
  }
  if (
    invocation.state === 'pending' &&
    invocation.guide.response.mode === 'sync' &&
    invocation.responseJson
  ) {
    return materializeSyncInvocation(invocation, persistedResponse(invocation), scope, db);
  }
  if (invocation.state !== 'prepared') {
    return failure(
      'INVOCATION_ALREADY_USED',
      `该 invocation 当前状态为 ${invocation.state}；付费提交不可重复执行`,
    );
  }
  if (Date.now() - invocation.createdAt > PREPARED_INVOCATION_TTL_MS) {
    await transitionMediaInvocation(
      {
        id: invocation.id,
        owner: invocation.owner,
        from: 'prepared',
        to: 'failed',
      },
      db,
    );
    assertAuthScope(scope, invocation.owner);
    return failure('INVOCATION_EXPIRED', '调用准备已超过 5 分钟，请重新查询模型并 prepare');
  }
  if (isClientProviderInvocation(invocation)) {
    return submitProviderInvocation(invocation, body, scope, db);
  }
  // prepare 与实际付费提交之间可能隔着 Agent 组装参数的时间；提交边界重新读取
  // Gateway 清单和客户端停用状态，避免模型/供应商刚被停用后仍发出新请求。
  const models = await listAvailableMediaModels(invocation.capability);
  assertAuthScope(scope, invocation.owner);
  if (!models.some((model) => model.providerId === 'xd' && model.id === invocation.modelId)) {
    return failure('MODEL_NOT_AVAILABLE', '该模型已下架或被停用，本次生成未发出');
  }
  const requestBody = await prepareRequestBody(body, invocation.guide);
  assertAuthScope(scope, invocation.owner);
  let connection: MediaConnection;
  try {
    connection = resolveConnection(invocation.guide.connection.providerId);
  } catch (error) {
    if (error instanceof MediaInvocationError) {
      return failure(error.code, error.message, error.code === 'CONNECTION_UNAVAILABLE', {
        outcomeKnown: true,
      });
    }
    throw error;
  }
  const claimed = await transitionMediaInvocation(
    {
      id: invocation.id,
      owner: invocation.owner,
      from: 'prepared',
      to: 'submitting',
    },
    db,
  );
  if (!claimed) {
    const current = await getMediaInvocation(invocation.id, invocation.owner, db);
    assertAuthScope(scope, invocation.owner);
    return failure(
      'INVOCATION_ALREADY_USED',
      `该 invocation 当前状态为 ${current?.state ?? 'unknown'}；付费提交不可重复执行`,
    );
  }
  // claim 之后再过一次认证代次闸；通过后到 outboundFetch 发起之间没有异步让出点，
  // 因而不会拿切换后账号的 endpoint / key 提交旧账号的付费请求。
  assertAuthScope(scope, invocation.owner);
  try {
    const response = await dispatchRequest({
      invocationId: invocation.id,
      providerId: invocation.guide.connection.providerId,
      modelId: invocation.modelId,
      capability: invocation.capability,
      connection,
      method: invocation.guide.request.method,
      path: invocation.guide.request.path,
      headers: invocation.guide.request.headers,
      body: requestBody,
      bodyEncoding: invocation.guide.request.bodyEncoding,
      multipartFiles: invocation.guide.request.multipartFiles,
      timeoutMs: invocation.guide.request.timeoutMs,
      maxResponseBytes: invocation.guide.request.maxResponseBytes,
      operation: 'submit',
    });
    if (invocation.guide.response.mode === 'sync') {
      const responseJson = JSON.stringify(response);
      let persisted = false;
      try {
        persisted = await transitionMediaInvocation(
          {
            id: invocation.id,
            owner: invocation.owner,
            from: 'submitting',
            to: 'pending',
            responseJson,
          },
          db,
        );
      } catch (error) {
        log.warn('persist sync media response failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        await transitionMediaInvocation(
          {
            id: invocation.id,
            owner: invocation.owner,
            from: 'submitting',
            to: 'unknown',
          },
          db,
        ).catch(() => false);
        return submissionOutcomeUnknown(
          '上游结果已生成，但本地未能保存结果；不要自动重提',
        );
      }
      if (!persisted) {
        return submissionOutcomeUnknown(
          '上游结果已生成，但本地未能保存结果；不要自动重提',
        );
      }
      assertAuthScope(scope, invocation.owner);
      return materializeSyncInvocation(
        { ...invocation, state: 'pending', responseJson },
        response,
        scope,
        db,
      );
    }
    const taskId = valuesAtPath(response, invocation.guide.response.taskIdPath).find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    if (!taskId) {
      await transitionMediaInvocation(
        {
          id: invocation.id,
          owner: invocation.owner,
          from: 'submitting',
          to: 'unknown',
        },
        db,
      );
      return submissionOutcomeUnknown(
        '上游响应没有任务 id，无法确认任务状态；不要自动重提',
      );
    }
    let persisted = false;
    try {
      persisted = await transitionMediaInvocation(
        {
          id: invocation.id,
          owner: invocation.owner,
          from: 'submitting',
          to: 'pending',
          taskId,
        },
        db,
      );
    } catch (error) {
      log.warn('persist async media task id failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      await transitionMediaInvocation(
        {
          id: invocation.id,
          owner: invocation.owner,
          from: 'submitting',
          to: 'unknown',
        },
        db,
      ).catch(() => false);
      return submissionOutcomeUnknown(
        '上游任务已创建，但本地未能保存任务 id；不要自动重提',
      );
    }
    if (!persisted) {
      return submissionOutcomeUnknown(
        '上游任务已创建，但本地未能保存任务 id；不要自动重提',
      );
    }
    assertAuthScope(scope, invocation.owner);
    return {
      ok: true,
      status: 'pending',
      invocation_id: invocation.id,
      recommended_poll_after_ms: invocation.guide.response.poll.recommendedIntervalMs,
    };
  } catch (error) {
    const expected = error instanceof MediaInvocationError ? error : null;
    await transitionMediaInvocation(
      {
        id: invocation.id,
        owner: invocation.owner,
        from: 'submitting',
        to: expected?.outcomeUnknown ? 'unknown' : 'failed',
      },
      db,
    ).catch(() => false);
    if (expected) {
      return expected.outcomeUnknown
        ? submissionOutcomeUnknown(expected.message)
        : failure(expected.code, expected.message, false, { outcomeKnown: true });
    }
    log.warn('media submission failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return failure('INTERNAL', '媒体任务提交失败');
  }
}

function pollPath(path: string, taskId: string): string {
  return path.replaceAll('{taskId}', encodeURIComponent(taskId));
}

function pollBody(guide: MediaAsyncPollGuide, taskId: string): Record<string, unknown> | undefined {
  if (guide.method !== 'POST') return undefined;
  const body: Record<string, unknown> = {};
  if (guide.bodyTaskIdPath) setObjectPath(body, guide.bodyTaskIdPath, taskId);
  return body;
}

async function materializeAsyncInvocation(
  invocation: StoredMediaInvocation,
  response: unknown,
  scope: MediaAuthScope,
  db: DbClient,
): Promise<Record<string, unknown>> {
  const responseGuide = invocation.guide.response;
  if (responseGuide.mode !== 'async') {
    throw new MediaInvocationError('MEDIA_RESULT_INVALID', '异步媒体调用缺少轮询响应说明');
  }
  try {
    const media = await materializeResults(response, responseGuide.poll.media, scope, db);
    assertAuthScope(scope, invocation.owner);
    return persistCompletedInvocation(invocation, media, scope, db);
  } catch (error) {
    assertAuthScope(scope, invocation.owner);
    if (error instanceof MediaInvocationError) {
      if (TERMINAL_MEDIA_RESULT_ERRORS.has(error.code)) {
        await transitionMediaInvocation(
          {
            id: invocation.id,
            owner: invocation.owner,
            from: 'pending',
            to: 'failed',
          },
          db,
        );
        assertAuthScope(scope, invocation.owner);
        return failure(error.code, error.message);
      }
      if (error.code === 'MEDIA_DOWNLOAD_FAILED') {
        return {
          ...failure(error.code, error.message, true),
          retry_action: 'poll',
        };
      }
      throw error;
    }
    log.warn('async media materialization failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ...failure('MEDIA_MATERIALIZATION_FAILED', '媒体结果暂时无法保存', true),
      retry_action: 'poll',
    };
  }
}

async function pollInvocation(invocation: StoredMediaInvocation): Promise<Record<string, unknown>> {
  const scope = currentAuthScope();
  assertAuthScope(scope, invocation.owner);
  const db = captureMediaDb(scope);
  if (invocation.guide.response.mode !== 'async') {
    return failure('POLL_NOT_SUPPORTED', '同步媒体调用不需要 poll');
  }
  if (invocation.state === 'complete') {
    return completedInvocationResult(invocation);
  }
  if (invocation.state !== 'pending' || !invocation.taskId) {
    return failure('INVOCATION_NOT_PENDING', `该 invocation 当前状态为 ${invocation.state}`);
  }
  const guide = invocation.guide.response.poll;
  if (invocation.responseJson) {
    // 已有成功响应的 poll 是结果恢复重试；刷新活动时间，避免仍在主动恢复的
    // 已付费结果被常规 TTL 清理。保持 pending，不引入新的本地状态。
    await transitionMediaInvocation(
      {
        id: invocation.id,
        owner: invocation.owner,
        from: 'pending',
        to: 'pending',
      },
      db,
    );
    assertAuthScope(scope, invocation.owner);
    return materializeAsyncInvocation(invocation, persistedResponse(invocation), scope, db);
  }
  try {
    const response = await dispatchRequest({
      invocationId: invocation.id,
      providerId: invocation.guide.connection.providerId,
      modelId: invocation.modelId,
      capability: invocation.capability,
      connection: resolveConnection(invocation.guide.connection.providerId),
      method: guide.method,
      path: pollPath(guide.path, invocation.taskId),
      headers: guide.headers,
      body: pollBody(guide, invocation.taskId),
      timeoutMs: guide.timeoutMs,
      maxResponseBytes: guide.maxResponseBytes,
      operation: 'poll',
    });
    assertAuthScope(scope, invocation.owner);
    const rawStatus = valuesAtPath(response, guide.statusPath)[0];
    const status = typeof rawStatus === 'string' ? rawStatus : '';
    if (guide.successValues.includes(status)) {
      const responseJson = JSON.stringify(response);
      const persisted = await transitionMediaInvocation(
        {
          id: invocation.id,
          owner: invocation.owner,
          from: 'pending',
          to: 'pending',
          responseJson,
        },
        db,
      );
      assertAuthScope(scope, invocation.owner);
      if (!persisted) {
        const current = await getMediaInvocation(invocation.id, invocation.owner, db);
        assertAuthScope(scope, invocation.owner);
        if (current?.state === 'complete' && current.responseJson) {
          return completedInvocationResult(current);
        }
        if (current?.state === 'pending' && current.responseJson) {
          return materializeAsyncInvocation(
            current,
            persistedResponse(current),
            scope,
            db,
          );
        }
        return failure('POLL_UNAVAILABLE', '上游结果已生成，但本地未能保存结果', true);
      }
      return materializeAsyncInvocation(
        { ...invocation, responseJson },
        response,
        scope,
        db,
      );
    }
    if (guide.failureValues.includes(status)) {
      await transitionMediaInvocation(
        {
          id: invocation.id,
          owner: invocation.owner,
          from: 'pending',
          to: 'failed',
        },
        db,
      );
      assertAuthScope(scope, invocation.owner);
      return failure('UPSTREAM_TASK_FAILED', `上游媒体任务失败，状态: ${status || 'unknown'}`);
    }
    return {
      ok: true,
      status: 'pending',
      invocation_id: invocation.id,
      upstream_status: status || 'unknown',
      recommended_poll_after_ms: guide.recommendedIntervalMs,
    };
  } catch (error) {
    if (error instanceof MediaInvocationError) {
      // Poll is read-only/idempotent: transient failure does not invalidate the submitted task.
      return failure(error.code, error.message, true);
    }
    return failure('POLL_UNAVAILABLE', '媒体任务状态查询失败', true);
  }
}

/** 当前 Agent 永久注册的 `mcp__cindy__media` 工具实现；不暴露给插件运行时。 */
export async function callCindyMedia(
  request: CindyMediaToolRequest,
): Promise<Record<string, unknown>> {
  try {
    if (request.action === 'list_models') {
      const capability = request.capability as MediaCapability | undefined;
      const availability = await listExecutableMediaModels(
        capability ? [capability] : [],
      );
      if (availability.models.length === 0 && capability) {
        if (availability.candidateCount === 0) {
          return failure(
            'CAPABILITY_NOT_SUPPORTED',
            '当前没有已启用模型声明支持该媒体能力',
            false,
            { outcomeKnown: true, allowedActions: ['use_another_tool'] },
          );
        }
        const upgradeRequired = availability.unavailable.some(
          (item) => item.errorCode === 'CLIENT_UPGRADE_REQUIRED',
        );
        const temporarilyUnavailable = availability.unavailable.some((item) => item.retryable);
        const errorCode = upgradeRequired
          ? 'CLIENT_UPGRADE_REQUIRED'
          : temporarilyUnavailable
            ? 'GUIDE_SERVICE_UNAVAILABLE'
            : 'GUIDE_NOT_AVAILABLE';
        const message = upgradeRequired
          ? '当前 Cindy 版本不支持可用模型的调用协议，请升级客户端或使用其他工具。'
          : temporarilyUnavailable
            ? '媒体调用说明暂时无法读取，请稍后重试或使用其他工具。'
            : '当前没有带可用调用说明的模型支持该媒体能力。';
        return failure(errorCode, message, temporarilyUnavailable, {
          outcomeKnown: true,
          allowedActions: GUIDE_FALLBACK_ACTIONS,
        });
      }
      return {
        ok: true,
        models: availability.models.map((model) => ({
          id: model.id,
          provider_id: model.providerId,
          ...(model.name ? { name: model.name } : {}),
          ...(model.mode ? { mode: model.mode } : {}),
        })),
        ...(availability.unavailable.length > 0
          ? {
              unavailable_model_count: availability.unavailable.length,
              guidance: '部分模型当前不可执行；可使用返回的模型，或选择其他已授权工具。',
            }
          : {}),
      };
    }
    if (request.action === 'prepare') {
      return prepareInvocation(
        request.providerId,
        request.modelId,
        request.capability as MediaCapability,
      );
    }
    const invocation = await requireInvocation(request.invocationId);
    return await (request.action === 'request'
      ? submitInvocation(invocation, request.body)
      : pollInvocation(invocation));
  } catch (error) {
    if (error instanceof MediaInvocationError) return failure(error.code, error.message);
    if (error instanceof MediaModelCatalogError) {
      log.warn('media model catalog rejected by current client', { detail: error.detail });
      return failure('MODEL_CATALOG_UNAVAILABLE', error.message, true, {
        outcomeKnown: true,
        allowedActions: ['use_another_tool'],
      });
    }
    if (error instanceof MediaGuideCompatibilityError) {
      return failure(error.code, error.message, false, {
        outcomeKnown: true,
        allowedActions: GUIDE_FALLBACK_ACTIONS,
      });
    }
    if (error instanceof ServerApiError) {
      return failure('MODEL_ACCESS_UNAVAILABLE', '媒体模型服务暂时不可用，请稍后重试', true, {
        outcomeKnown: true,
        allowedActions: ['use_another_tool'],
      });
    }
    log.warn('media tool call failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return failure('INTERNAL', error instanceof Error ? error.message : '媒体能力调用失败');
  }
}
