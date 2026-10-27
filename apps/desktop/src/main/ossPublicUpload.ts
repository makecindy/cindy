/**
 * ossPublicUpload.ts — 公开资产经 oss-server 预签名直传(当前场景:头像)。
 * ---------------------------------------------------------------------------
 * 流程(接口契约见服务端仓 docs/oss-server.md):
 *   1. POST {ossApiBaseUrl}/api/oss/presign-put  { scene, contentType, size }(Bearer)
 *      → { putUrl, publicUrl, key, headers, expiresAt }
 *   2. PUT putUrl,body 为文件字节,**原样携带返回的 headers**(Content-Type
 *      已签进预签名,PUT 时不一致会被 OSS 拒);
 *   3. PUT 返回 200 后 publicUrl 才可访问(之前是 404),此时才能把
 *      publicUrl 交给业务接口(如 PATCH /api/me/profile)。
 *
 * 纯逻辑 + 依赖注入(规则 14):fetch / token / base url 全部由调用方注入,
 * 测试用内存 harness 直测,不碰 Electron;失败以结果值返回而非抛异常,
 * IPC 错误语义由上层业务体(profileEdit)统一映射。
 */

import { requestErrorMessage } from './requestErrorMessage';

/** presign-put 成功响应(只校验消费到的字段)。 */
export interface PresignPutResponse {
  putUrl: string;
  publicUrl: string;
  key: string;
  headers: Record<string, string>;
}

export type PublicUploadResult =
  | { ok: true; publicUrl: string; key: string }
  /** stage: presign = 预签名接口失败;put = 直传 OSS 失败。status 0 = 网络层失败。 */
  | { ok: false; stage: 'presign' | 'put'; status: number; code?: string };

export interface PublicUploadDeps {
  /** 生产实现为 Electron net.fetch(走系统代理);测试注入内存 fake。 */
  fetchImpl(input: string, init?: RequestInit): Promise<Response>;
  /** ossApiBaseUrl(端点清单,惰性读取——启动期清单尚未解析时不许固化)。 */
  getBaseUrl(): string;
  /** 当前 access token;未登录返回 null。 */
  getToken(): string | null;
  onError?: (stage: 'presign' | 'put', message: string) => void;
}

/** presign 是纯本地签名计算,15s 足够;PUT 按 5MB 上限 + 慢网余量放宽。 */
const PRESIGN_TIMEOUT_MS = 15_000;
const PUT_TIMEOUT_MS = 60_000;

async function fetchWithTimeout(
  fetchImpl: PublicUploadDeps['fetchImpl'],
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parsePresignResponse(data: unknown): PresignPutResponse | null {
  if (data === null || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (
    typeof record.putUrl !== 'string' ||
    record.putUrl === '' ||
    typeof record.publicUrl !== 'string' ||
    record.publicUrl === '' ||
    typeof record.key !== 'string'
  ) {
    return null;
  }
  const headers: Record<string, string> = {};
  if (record.headers !== null && typeof record.headers === 'object') {
    for (const [name, value] of Object.entries(record.headers as Record<string, unknown>)) {
      if (typeof value === 'string') headers[name] = value;
    }
  }
  return { putUrl: record.putUrl, publicUrl: record.publicUrl, key: record.key, headers };
}

/**
 * 预签名 + 直传一条龙。任何阶段失败都返回 ok:false(不抛),调用方按 stage
 * 决定错误呈现;成功后返回可提交给业务接口的 publicUrl(与推荐存储的 key)。
 */
export async function uploadPublicAsset(
  deps: PublicUploadDeps,
  params: { scene: 'avatar'; contentType: string; body: Uint8Array },
): Promise<PublicUploadResult> {
  const token = deps.getToken();
  if (!token) {
    return { ok: false, stage: 'presign', status: 0, code: 'NOT_AUTHENTICATED' };
  }
  const logError = (stage: 'presign' | 'put', error: unknown) => {
    try { deps.onError?.(stage, requestErrorMessage(error)); }
    catch { /* Logging must not change the upload result. */ }
  };

  let presign: PresignPutResponse;
  try {
    const response = await fetchWithTimeout(
      deps.fetchImpl,
      `${deps.getBaseUrl()}/api/oss/presign-put`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          scene: params.scene,
          contentType: params.contentType,
          size: params.body.byteLength,
        }),
      },
      PRESIGN_TIMEOUT_MS,
    );
    if (!response.ok) {
      let code: string | undefined;
      try {
        const data = (await response.json()) as { error?: { code?: string } } | null;
        code = data?.error?.code;
      } catch (error) {
        logError('presign', error);
        // 非 JSON 错误体,只保留 status
      }
      return { ok: false, stage: 'presign', status: response.status, ...(code ? { code } : {}) };
    }
    const parsed = parsePresignResponse(await response.json());
    if (!parsed) {
      return { ok: false, stage: 'presign', status: response.status, code: 'MALFORMED_RESPONSE' };
    }
    presign = parsed;
  } catch (error) {
    logError('presign', error);
    return { ok: false, stage: 'presign', status: 0 };
  }

  try {
    const response = await fetchWithTimeout(
      deps.fetchImpl,
      presign.putUrl,
      {
        method: 'PUT',
        headers: presign.headers,
        // Electron net.fetch 的 RequestInit body 接受 Uint8Array 底层 buffer 切片
        body: params.body as unknown as BodyInit,
      },
      PUT_TIMEOUT_MS,
    );
    if (!response.ok) {
      return { ok: false, stage: 'put', status: response.status };
    }
  } catch (error) {
    logError('put', error);
    return { ok: false, stage: 'put', status: 0 };
  }

  return { ok: true, publicUrl: presign.publicUrl, key: presign.key };
}
