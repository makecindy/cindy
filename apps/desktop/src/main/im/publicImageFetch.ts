/**
 * IM 公网图片安全下载器。
 *
 * Agent Markdown 与平台签发的临时媒体 URL 都属于不可信输入。下载必须逐跳
 * 校验 HTTPS、DNS 解析结果与重定向，避免 main 进程成为内网 / metadata SSRF
 * 读原语；字节边读边限流，不创建临时文件，也不把带查询参数的 URL 写入日志。
 */
import {
  fetchWithSsrFGuard,
  type GuardedFetchResult,
} from '@cindy/browser-control-runtime/ssrf-runtime';

const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;

export type GuardedImageFetch = (params: {
  url: string;
  signal: AbortSignal;
  requireHttps: true;
  maxRedirects: number;
}) => Promise<GuardedFetchResult>;

async function readBodyLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) throw new Error('remote image response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('remote image exceeds the size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error('remote image response is empty');
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function fetchPublicImageBytes(
  url: string,
  maxBytes: number,
  guardedFetch: GuardedImageFetch = fetchWithSsrFGuard,
): Promise<{ buffer: Uint8Array; mimeType?: string }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('invalid remote image size limit');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let result: GuardedFetchResult | null = null;
  try {
    result = await guardedFetch({
      url,
      signal: controller.signal,
      requireHttps: true,
      maxRedirects: MAX_REDIRECTS,
    });
    const { response } = result;
    if (!response.ok) throw new Error(`remote image request failed: HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > maxBytes) throw new Error('remote image exceeds the size limit');
    const buffer = await readBodyLimited(response, maxBytes);
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
    return {
      buffer,
      ...(contentType?.startsWith('image/') ? { mimeType: contentType } : {}),
    };
  } finally {
    clearTimeout(timer);
    await result?.release();
  }
}
