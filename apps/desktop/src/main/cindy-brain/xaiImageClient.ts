/**
 * xAI Imagine image channel backed by the user's existing SuperGrok OAuth login.
 *
 * The OAuth bearer used by the xAI agent bridge also works on the OpenAI-compatible
 * Imagine endpoints. Credentials stay in Main; local source images are sent as data
 * URIs and the response is normalized to ImageChannelResult.
 */

import fs from 'node:fs/promises';

import type { GhostImageAspectRatio } from '../../shared/ghost.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';
import type { ImageChannel, ImageChannelResult } from './imageChannelRegistry.js';

const XAI_API_BASE = 'https://api.x.ai/v1';
const MAX_EDIT_SOURCES = 3;
const MAX_IMAGE_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface XaiImageResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
    mime_type?: string;
  }>;
  error?: { message?: string };
}

export interface CreateXaiImageChannelOptions {
  hasOAuthLogin(): boolean;
  getAccessToken(): Promise<string>;
  getCredentialGeneration(): number;
  getOwnerScopeKey(): string;
  isOwnerBoundaryPending(): boolean;
  fetchImplementation?: typeof fetch;
  /** 测试/宿主可收紧下载上限，但不能放宽生产硬顶。 */
  maxImageDownloadBytes?: number;
  beforeDispatch?(model: string): void;
  onAuthRejected?(failure: {
    status: number;
    body: string;
    failedAccessToken: string;
  }): Promise<unknown>;
}

function upstreamModelId(catalogId: string): string {
  return catalogId.startsWith('xai/') ? catalogId.slice('xai/'.length) : catalogId;
}

async function sourceImage(path: string): Promise<{ type: 'image_url'; url: string }> {
  const bytes = await fs.readFile(path);
  const mime = sniffMediaMime(bytes);
  if (!mime || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) {
    throw new Error(`xAI 参考图格式不支持:${mime ?? '未知格式'}`);
  }
  return { type: 'image_url', url: `data:${mime};base64,${bytes.toString('base64')}` };
}

function parseResponse(text: string): XaiImageResponse {
  try {
    return JSON.parse(text) as XaiImageResponse;
  } catch {
    throw new Error('xAI 图像通道返回了无效响应');
  }
}

function assertXaiImageUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('xAI 图像通道返回了不可信的图片地址');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !(url.hostname === 'x.ai' || url.hostname.endsWith('.x.ai'))
  ) {
    throw new Error('xAI 图像通道返回了不可信的图片地址');
  }
  return url.toString();
}

async function fetchXaiImageDownload(
  doFetch: typeof fetch,
  sourceUrl: string,
  assertStillCurrent: () => void,
): Promise<Response> {
  assertStillCurrent();
  const response = await doFetch(sourceUrl, { redirect: 'manual' });
  assertStillCurrent();
  if (!REDIRECT_STATUSES.has(response.status)) return response;

  const location = response.headers.get('location');
  await response.body?.cancel().catch(() => undefined);
  assertStillCurrent();
  if (!location) throw new Error('xAI 图片下载重定向缺少 Location');
  const redirectUrl = assertXaiImageUrl(new URL(location, sourceUrl).toString());
  const redirected = await doFetch(redirectUrl, { redirect: 'manual' });
  assertStillCurrent();
  return redirected;
}

function captureOwnerScope(opts: CreateXaiImageChannelOptions): string {
  if (opts.isOwnerBoundaryPending()) {
    throw new Error('xAI 图片请求期间账号正在切换,请稍后重试');
  }
  return opts.getOwnerScopeKey();
}

function assertOwnerScopeCurrent(opts: CreateXaiImageChannelOptions, expected: string): void {
  if (opts.isOwnerBoundaryPending() || opts.getOwnerScopeKey() !== expected) {
    throw new Error('xAI 图片请求期间账号已切换,请重试');
  }
}

function assertRequestScopeCurrent(
  opts: CreateXaiImageChannelOptions,
  ownerScopeKey: string,
  credentialGeneration: number,
): void {
  assertOwnerScopeCurrent(opts, ownerScopeKey);
  if (opts.getCredentialGeneration() !== credentialGeneration) {
    throw new Error('xAI 图片请求期间 SuperGrok 凭证已切换,请重试');
  }
}

async function readBoundedImageResponse(
  response: Response,
  maxBytes: number,
  assertStillCurrent: () => void,
): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`xAI 图片下载超过大小上限(${maxBytes} 字节)`);
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
        throw new Error(`xAI 图片下载超过大小上限(${maxBytes} 字节)`);
      }
      chunks.push(value);
    }
  } finally {
    // 超限、账号切换或流异常时立即断开上游；正常读完时 cancel 是 no-op。
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export function createXaiImageChannel(opts: CreateXaiImageChannelOptions): ImageChannel {
  const doFetch = opts.fetchImplementation ?? fetch;
  const requestedDownloadLimit = opts.maxImageDownloadBytes;
  const maxImageDownloadBytes =
    typeof requestedDownloadLimit === 'number' &&
    Number.isSafeInteger(requestedDownloadLimit) &&
    requestedDownloadLimit > 0
      ? Math.min(requestedDownloadLimit, MAX_IMAGE_DOWNLOAD_BYTES)
      : MAX_IMAGE_DOWNLOAD_BYTES;

  async function call(params: {
    model: string;
    prompt: string;
    aspectRatio?: GhostImageAspectRatio;
    imagePaths?: string[];
  }): Promise<ImageChannelResult> {
    const paths = params.imagePaths ?? [];
    if (paths.length > MAX_EDIT_SOURCES) {
      throw new Error(`xAI 图像编辑最多支持 ${MAX_EDIT_SOURCES} 张源图`);
    }
    // 先在任何凭证刷新或本地文件读取之前拦截已停用模型；后面的二次检查
    // 继续覆盖准备请求期间发生的配置变化。
    opts.beforeDispatch?.(params.model);
    // OAuth token 与源图都属于当前数据 owner。任务跨 await 后必须仍在同一稳定
    // owner scope，不能把 A 的 token 或图片派发进 B 的运行时。
    const ownerScopeKey = captureOwnerScope(opts);
    const credentialGeneration = opts.getCredentialGeneration();
    const assertStillCurrent = (): void =>
      assertRequestScopeCurrent(opts, ownerScopeKey, credentialGeneration);
    assertStillCurrent();
    const [token, images] = await Promise.all([
      opts.getAccessToken(),
      Promise.all(paths.map(sourceImage)),
    ]);
    const isEdit = images.length > 0;
    const body: Record<string, unknown> = {
      model: upstreamModelId(params.model),
      prompt: params.prompt,
      response_format: 'b64_json',
      resolution: '1k',
      ...(params.aspectRatio ? { aspect_ratio: params.aspectRatio } : {}),
    };
    if (isEdit) {
      if (images.length === 1) body.image = images[0];
      else body.images = images;
    }

    opts.beforeDispatch?.(params.model);
    assertStillCurrent();
    const response = await doFetch(`${XAI_API_BASE}/images/${isEdit ? 'edits' : 'generations'}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    const responseText = await response.text();
    assertStillCurrent();
    if (!response.ok) {
      if ((response.status === 401 || response.status === 403) && opts.onAuthRejected) {
        await opts
          .onAuthRejected({
            status: response.status,
            body: responseText.slice(0, 8 * 1024),
            failedAccessToken: token,
          })
          .catch(() => undefined);
      }
      const parsed = (() => {
        try {
          return JSON.parse(responseText) as XaiImageResponse;
        } catch {
          return null;
        }
      })();
      const detail = parsed?.error?.message ?? (responseText.slice(0, 500) || '未知错误');
      throw new Error(`xAI 图像请求失败(HTTP ${response.status}):${detail}`);
    }

    const parsed = parseResponse(responseText);
    const first = parsed.data?.[0];
    if (first?.b64_json) {
      assertStillCurrent();
      return {
        data: [{ b64_json: first.b64_json }],
        output_format: first.mime_type?.split('/')[1] ?? 'png',
      };
    }
    if (first?.url) {
      // Imagine URLs are short-lived. Materialize immediately so the shared media
      // pipeline receives stable bytes instead of persisting an expiring URL. The
      // initial URL and at most one redirect must both remain trusted x.ai targets.
      const imageResponse = await fetchXaiImageDownload(
        doFetch,
        assertXaiImageUrl(first.url),
        assertStillCurrent,
      );
      if (!imageResponse.ok) {
        throw new Error(`xAI 图片下载失败(HTTP ${imageResponse.status})`);
      }
      const bytes = await readBoundedImageResponse(
        imageResponse,
        maxImageDownloadBytes,
        assertStillCurrent,
      );
      const mime = sniffMediaMime(bytes);
      if (!mime?.startsWith('image/')) throw new Error('xAI 图片下载结果不是有效图片');
      assertStillCurrent();
      return { data: [{ b64_json: bytes.toString('base64') }], output_format: mime.split('/')[1] };
    }
    throw new Error('xAI 图像通道未返回图片');
  }

  return {
    ready: opts.hasOAuthLogin,
    maxEditImages: MAX_EDIT_SOURCES,
    generateImage: ({ model, prompt, aspectRatio }) => call({ model, prompt, aspectRatio }),
    editImage: ({ model, prompt, imagePaths, aspectRatio }) =>
      call({ model, prompt, imagePaths, aspectRatio }),
  };
}
