/**
 * xAI Grok Imagine video provider backed by the existing SuperGrok OAuth login.
 *
 * The shared video runner owns parameter validation and polling cadence. This
 * adapter translates Cindy's normalized request into xAI's async video API and
 * keeps the originating account scope attached to the opaque in-memory handle,
 * so an account switch cannot continue or download another owner's task.
 */

import { Buffer } from 'node:buffer';

import type {
  VideoGenerationRequest,
  VideoProvider,
  VideoProviderCapabilities,
  VideoTaskHandle,
  VideoTaskStatus,
} from '../types.js';
import { sniffMediaMime } from '../../../cindy-media/sniffMediaMime.js';

const XAI_API_BASE = 'https://api.x.ai/v1';
export const XAI_VIDEO_CATALOG_MODEL_ID = 'xai/grok-imagine-video';
const INTERNAL_CONTENT_PROTOCOL = 'xai-video:';
const INTERNAL_CONTENT_HOST = 'content';
const MAX_VIDEO_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const SUPPORTED_DURATIONS = Array.from({ length: 15 }, (_, index) => index + 1);

const BASE_CAPABILITIES: Omit<
  VideoProviderCapabilities,
  'modelAliases' | 'expectedSecondsByAlias'
> = {
  supportedDurations: SUPPORTED_DURATIONS,
  supportedResolutions: ['480p', '720p', '1080p'],
  // xAI 还支持 3:2 / 2:3，但当前插件视频协议没有这两个枚举，不能公布
  // 一个调用方永远传不进来的值。
  supportedRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
  // xAI API 没有 fps 入参；24 只用于现有统一能力面与结果回执。
  supportedFps: [24],
  maxImagesByRefMode: {
    // xAI image-to-video 接收一张起始图，不支持现有协议里的尾帧语义。
    first_and_last_frame: 1,
  },
  // Imagine 会生成同步音频，但当前 API 没有开关。显式传 audio 时应早拒，
  // 不能让调用方以为自己控制了静音或出声。
  supportsAudio: false,
  audioDefault: true,
  defaults: {
    duration: 6,
    resolution: '720p',
    ratio: '16:9',
    fps: 24,
  },
};

interface XaiVideoErrorBody {
  error?: { message?: string };
  message?: string;
}

interface XaiVideoSubmitResponse extends XaiVideoErrorBody {
  request_id?: string;
}

interface XaiVideoStatusResponse extends XaiVideoErrorBody {
  status?: 'pending' | 'done' | 'expired' | 'failed';
  model?: string;
  video?: {
    url?: string;
    duration?: number;
    aspect_ratio?: string;
    resolution?: string;
    fps?: number;
  };
}

export interface CreateXaiVideoProviderOptions {
  hasOAuthLogin(): boolean;
  getAccessToken(): Promise<string>;
  getCredentialGeneration(): number;
  getOwnerScopeKey(): string;
  isOwnerBoundaryPending(): boolean;
  fetchImplementation?: typeof fetch;
  /** 测试可收紧上限，但不能放宽生产硬顶。 */
  maxVideoDownloadBytes?: number;
  beforeDispatch?(model: string): void;
  /** 当前 active catalog 里经类型发现／静态兜底确认可执行的 xAI alias。 */
  modelAliases?: readonly string[];
  onAuthRejected?(failure: {
    status: number;
    body: string;
    failedAccessToken: string;
  }): Promise<unknown>;
}

function parseJson<T>(text: string, phase: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`xAI 视频${phase}返回了无效响应`);
  }
}

function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as XaiVideoErrorBody;
    return parsed.error?.message ?? parsed.message ?? text.slice(0, 500) ?? '未知错误';
  } catch {
    return text.slice(0, 500) || '未知错误';
  }
}

function captureOwnerScope(opts: CreateXaiVideoProviderOptions): string {
  if (opts.isOwnerBoundaryPending()) {
    throw new Error('xAI 视频请求期间账号正在切换,请稍后重试');
  }
  return opts.getOwnerScopeKey();
}

function assertOwnerScopeCurrent(
  opts: CreateXaiVideoProviderOptions,
  expected: string,
): void {
  if (opts.isOwnerBoundaryPending() || opts.getOwnerScopeKey() !== expected) {
    throw new Error('xAI 视频请求期间账号已切换,请重试');
  }
}

function assertCredentialGenerationCurrent(
  opts: CreateXaiVideoProviderOptions,
  expected: number,
): void {
  if (opts.getCredentialGeneration() !== expected) {
    throw new Error('xAI 视频请求期间 SuperGrok 凭证已切换,请重试');
  }
}

function assertRequestScopeCurrent(
  opts: CreateXaiVideoProviderOptions,
  ownerScopeKey: string,
  credentialGeneration: number,
): void {
  assertOwnerScopeCurrent(opts, ownerScopeKey);
  assertCredentialGenerationCurrent(opts, credentialGeneration);
}

async function notifyAuthRejected(
  opts: CreateXaiVideoProviderOptions,
  response: Response,
  body: string,
  failedAccessToken: string,
): Promise<unknown> {
  if ((response.status !== 401 && response.status !== 403) || !opts.onAuthRejected) {
    return undefined;
  }
  return await opts
    .onAuthRejected({
      status: response.status,
      body: body.slice(0, 8 * 1024),
      failedAccessToken,
    })
    .catch(() => undefined);
}

function assertXaiVideoUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('xAI 视频任务返回了不可信的下载地址');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !(url.hostname === 'x.ai' || url.hostname.endsWith('.x.ai'))
  ) {
    throw new Error('xAI 视频任务返回了不可信的下载地址');
  }
  return url.toString();
}

async function fetchXaiVideoDownload(
  doFetch: typeof fetch,
  sourceUrl: string,
  signal: AbortSignal | undefined,
  assertStillCurrent: () => void,
): Promise<Response> {
  assertStillCurrent();
  const response = await doFetch(sourceUrl, { method: 'GET', redirect: 'manual', signal });
  assertStillCurrent();
  if (!REDIRECT_STATUSES.has(response.status)) return response;

  const location = response.headers.get('location');
  await response.body?.cancel().catch(() => undefined);
  assertStillCurrent();
  if (!location) throw new Error('xAI 视频下载重定向缺少 Location');
  const redirectUrl = assertXaiVideoUrl(new URL(location, sourceUrl).toString());
  const redirected = await doFetch(redirectUrl, { method: 'GET', redirect: 'manual', signal });
  assertStillCurrent();
  return redirected;
}

function internalContentRef(
  taskId: string,
  ownerScopeKey: string,
  credentialGeneration: number,
  sourceUrl: string,
): string {
  const url = new URL(`${INTERNAL_CONTENT_PROTOCOL}//${INTERNAL_CONTENT_HOST}`);
  url.pathname = `/${encodeURIComponent(taskId)}`;
  url.searchParams.set('owner', ownerScopeKey);
  url.searchParams.set('credential', String(credentialGeneration));
  url.searchParams.set('source', assertXaiVideoUrl(sourceUrl));
  return url.toString();
}

function parseInternalContentRef(raw: string): {
  taskId: string;
  ownerScopeKey: string;
  credentialGeneration: number;
  sourceUrl: string;
} {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('xAI 视频下载引用无效');
  }
  if (
    url.protocol !== INTERNAL_CONTENT_PROTOCOL ||
    url.hostname !== INTERNAL_CONTENT_HOST ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('xAI 视频下载引用无效');
  }
  const encodedTaskId = url.pathname.slice(1);
  const ownerScopeKey = url.searchParams.get('owner');
  const credentialGenerationRaw = url.searchParams.get('credential');
  const sourceUrl = url.searchParams.get('source');
  const credentialGeneration = Number(credentialGenerationRaw);
  if (
    !encodedTaskId ||
    !ownerScopeKey ||
    credentialGenerationRaw === null ||
    !Number.isSafeInteger(credentialGeneration) ||
    credentialGeneration < 0 ||
    !sourceUrl ||
    [...url.searchParams.keys()].some(
      (key) => key !== 'owner' && key !== 'credential' && key !== 'source',
    )
  ) {
    throw new Error('xAI 视频下载引用无效');
  }
  let taskId: string;
  try {
    taskId = decodeURIComponent(encodedTaskId);
  } catch {
    throw new Error('xAI 视频下载引用无效');
  }
  if (!taskId) throw new Error('xAI 视频下载引用无效');
  return {
    taskId,
    ownerScopeKey,
    credentialGeneration,
    sourceUrl: assertXaiVideoUrl(sourceUrl),
  };
}

async function readBoundedVideo(
  response: Response,
  maxBytes: number,
  assertStillCurrent: () => void,
): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`xAI 视频下载超过大小上限(${maxBytes} 字节)`);
  }
  const body = response.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      assertStillCurrent();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`xAI 视频下载超过大小上限(${maxBytes} 字节)`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export function createXaiVideoProvider(opts: CreateXaiVideoProviderOptions): VideoProvider {
  const doFetch = opts.fetchImplementation ?? fetch;
  const requestedLimit = opts.maxVideoDownloadBytes;
  const maxVideoDownloadBytes =
    typeof requestedLimit === 'number' &&
    Number.isSafeInteger(requestedLimit) &&
    requestedLimit > 0
      ? Math.min(requestedLimit, MAX_VIDEO_DOWNLOAD_BYTES)
      : MAX_VIDEO_DOWNLOAD_BYTES;
  const aliases = [...new Set(opts.modelAliases ?? [XAI_VIDEO_CATALOG_MODEL_ID])];
  const upstreamByAlias = new Map<string, string>();
  for (const alias of aliases) {
    if (!alias.startsWith('xai/') || alias.length <= 'xai/'.length) {
      throw new Error(`xAI 视频模型 alias 无效: ${alias}`);
    }
    upstreamByAlias.set(alias, alias.slice('xai/'.length));
  }
  const expectedSecondsByAlias = Object.fromEntries(aliases.map((alias) => [alias, 180]));
  const capabilities: VideoProviderCapabilities = {
    ...BASE_CAPABILITIES,
    modelAliases: aliases.map((alias) => ({
      alias,
      internalModel: upstreamByAlias.get(alias)!,
      summary: 'Grok Imagine Video（最长 15 秒，支持单图生视频）',
    })),
    expectedSecondsByAlias,
  };

  async function authorizedJson<T>(
    url: string,
    phase: string,
    ownerScopeKey: string,
    credentialGeneration: number,
    init: RequestInit,
    options?: { retryAfterAuthRefresh?: boolean },
  ): Promise<T> {
    const retryAfterAuthRefresh = options?.retryAfterAuthRefresh === true;
    const maxAttempts = retryAfterAuthRefresh ? 2 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      assertRequestScopeCurrent(opts, ownerScopeKey, credentialGeneration);
      const token = await opts.getAccessToken();
      assertRequestScopeCurrent(opts, ownerScopeKey, credentialGeneration);
      const response = await doFetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(init.headers ?? {}),
        },
      });
      const text = await response.text();
      assertRequestScopeCurrent(opts, ownerScopeKey, credentialGeneration);
      if (response.ok) return parseJson<T>(text, phase);

      // 只让第一次失败进入恢复器。轮询可在凭证刷新成功后补发一次同一个 GET；
      // 第二次仍失败就如实抛出，不能形成内部重试环。submit 不打开此选项，
      // 因而绝不会因认证恢复重复创建付费任务。
      const recovery =
        attempt === 0 ? await notifyAuthRejected(opts, response, text, token) : undefined;
      // superseded 可能是同一登录的 token 已被并发请求先一步刷新；下面这道
      // owner + credential generation 复核会先排除登出、换号与数据 owner 切换。
      assertRequestScopeCurrent(opts, ownerScopeKey, credentialGeneration);
      if (
        retryAfterAuthRefresh &&
        attempt === 0 &&
        (recovery === 'refreshed' || recovery === 'superseded')
      ) {
        continue;
      }
      throw new Error(`xAI 视频${phase}失败(HTTP ${response.status}):${errorDetail(text)}`);
    }
    throw new Error(`xAI 视频${phase}失败:认证恢复重试耗尽`);
  }

  async function submit(
    req: VideoGenerationRequest,
    alias: string,
    signal?: AbortSignal,
  ): Promise<VideoTaskHandle> {
    const upstreamModelId = upstreamByAlias.get(alias);
    if (!upstreamModelId) {
      throw new Error(`xAI 视频通道不认识模型 '${alias}'`);
    }
    if (!opts.hasOAuthLogin()) {
      throw new Error('xAI 视频能力不可用:请先在设置中连接 SuperGrok');
    }
    opts.beforeDispatch?.(alias);
    const ownerScopeKey = captureOwnerScope(opts);
    const credentialGeneration = opts.getCredentialGeneration();
    assertRequestScopeCurrent(opts, ownerScopeKey, credentialGeneration);
    const images = req.images ?? [];
    const body: Record<string, unknown> = {
      model: upstreamModelId,
      prompt: req.prompt,
      duration: req.duration,
      resolution: req.resolution,
    };
    if (images[0]) {
      body.image = { url: images[0] };
      // xAI preserves the source image's aspect ratio when this field is
      // omitted. Do not turn Cindy's receipt/default value into a destructive
      // 16:9 override unless the user actually selected a ratio.
      if (req.ratioWasExplicit !== false) body.aspect_ratio = req.ratio;
    } else {
      body.aspect_ratio = req.ratio;
    }
    opts.beforeDispatch?.(alias);
    const response = await authorizedJson<XaiVideoSubmitResponse>(
      `${XAI_API_BASE}/videos/generations`,
      '提交',
      ownerScopeKey,
      credentialGeneration,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!response.request_id) {
      throw new Error('xAI 视频提交响应缺少 request_id');
    }
    assertRequestScopeCurrent(opts, ownerScopeKey, credentialGeneration);
    return {
      providerId: 'xai-video',
      taskId: response.request_id,
      modelUsed: upstreamModelId,
      submittedAt: Date.now(),
      ownerScopeKey,
      credentialGeneration,
    };
  }

  async function poll(
    handle: VideoTaskHandle,
    signal?: AbortSignal,
  ): Promise<VideoTaskStatus> {
    if (
      handle.providerId !== 'xai-video' ||
      !handle.ownerScopeKey ||
      !Number.isSafeInteger(handle.credentialGeneration) ||
      handle.credentialGeneration! < 0
    ) {
      return { state: 'failed', error: 'xAI 视频任务句柄无效' };
    }
    const credentialGeneration = handle.credentialGeneration!;
    const data = await authorizedJson<XaiVideoStatusResponse>(
      `${XAI_API_BASE}/videos/${encodeURIComponent(handle.taskId)}`,
      '查询',
      handle.ownerScopeKey,
      credentialGeneration,
      { method: 'GET', signal },
      { retryAfterAuthRefresh: true },
    );
    if (data.status === 'pending' || data.status === undefined) {
      return { state: data.status === 'pending' ? 'pending' : 'running', raw: data };
    }
    if (data.status === 'expired' || data.status === 'failed') {
      return {
        state: 'failed',
        error: data.error?.message ?? `xAI 视频任务状态为 ${data.status}`,
        raw: data,
      };
    }
    if (data.status !== 'done') return { state: 'running', raw: data };
    if (!data.video?.url) {
      return { state: 'failed', error: 'xAI 视频任务完成但未返回 video.url', raw: data };
    }
    assertRequestScopeCurrent(opts, handle.ownerScopeKey, credentialGeneration);
    return {
      state: 'succeeded',
      // 下载只接受本 provider 生成的内部引用，避免把上游自报 URL 变成任意出网入口。
      videoUrl: internalContentRef(
        handle.taskId,
        handle.ownerScopeKey,
        credentialGeneration,
        data.video.url,
      ),
      meta: {
        durationSec: data.video?.duration,
        resolution: data.video?.resolution,
        ratio: data.video?.aspect_ratio,
        fps: data.video?.fps,
      },
      raw: data,
    };
  }

  async function download(
    videoUrl: string,
    signal?: AbortSignal,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    const { ownerScopeKey, credentialGeneration, sourceUrl } = parseInternalContentRef(videoUrl);
    const assertStillCurrent = () =>
      assertRequestScopeCurrent(opts, ownerScopeKey, credentialGeneration);
    assertStillCurrent();
    // 完成态给的是 xAI 临时托管 URL。下载及至多一跳重定向都必须重新验证
    // 为可信 *.x.ai 目标；手动跟随确保任何不可信 Location 都会 fail closed。
    const response = await fetchXaiVideoDownload(doFetch, sourceUrl, signal, assertStillCurrent);
    assertStillCurrent();
    if (!response.ok) {
      const text = await response.text();
      assertStillCurrent();
      throw new Error(`xAI 视频下载失败(HTTP ${response.status}):${errorDetail(text)}`);
    }
    const buffer = await readBoundedVideo(
      response,
      maxVideoDownloadBytes,
      assertStillCurrent,
    );
    if (buffer.byteLength === 0) throw new Error('xAI 视频下载结果为空');
    const declaredMime =
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    const mimeType = sniffMediaMime(buffer, declaredMime);
    if (!mimeType?.startsWith('video/')) {
      throw new Error('xAI 视频下载结果不是受支持的视频');
    }
    // 流读取中的逐块检查覆盖下载过程；这里再封住最后一个分块读完到结果交给
    // cindy-media 之间的同步窗口，旧账号产物绝不跨 owner 边界返回。
    assertStillCurrent();
    return { buffer, mimeType };
  }

  return {
    id: 'xai-video',
    capabilities,
    submit,
    poll,
    download,
  };
}
