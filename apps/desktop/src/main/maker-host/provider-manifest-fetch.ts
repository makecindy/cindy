/**
 * provider-manifest-fetch —— 外部供应商 manifest（settings/providers?manifest= 深链）的
 * 主进程受限拉取。
 *
 * 信任边界设计（对应 issue #3387 的契约 + PR review 加固）：
 *   - 下载只在主进程发生，renderer 只拿结构化结果；
 *   - 仅 https、无凭证 URL（深链解析层已过 `isDeepLinkProviderManifestUrl`，这里
 *     再复核一次——本模块也被 IPC 直接暴露，不能假设调用方已校验）；
 *   - 经 `fetchWithSsrFGuard`（同 IM 公网图片下载器）发起：DNS 解析结果逐跳校验，
 *     loopback / 私网 / 特殊用途地址与 DNS 重绑定一律拒绝——深链是攻击者可投递的
 *     输入，main 不能被用作内网 SSRF 读原语；
 *   - **拒绝一切重定向**（maxRedirects=0）：确认屏展示的来源 origin 恒等于
 *     manifest URL 的 origin，不存在"重定向后最终来源"的歧义面；
 *   - 响应体**边读边限量**（64 KiB，Content-Length 声明超限直接拒绝，流式累计超限
 *     即取消读取），超时 10s；非 2xx、非 JSON、超限一律结构化失败；
 *   - 内容校验走 `parseProviderManifest`（fail-closed，见 @cindy/model-providers），
 *     任何字段越界整条拒绝，绝不部分预填；
 *   - 通过后把 preset.id 重写为 `manifest:<host>`：含 `:` 的命名空间值永不与
 *     catalog preset id / 内置 provider id / 本机检测特例（如 lmstudio）碰撞;
 *     最终落库 id 由用户侧 `uniqueCustomProviderId` 生成，manifest id 纯模板元数据。
 *
 * 查询型结构化返回（规则 13 例外条款，同 provider-model-fetch）：renderer 需要
 * reason 渲染分类文案，网络 / 内容失败不抛 IPC 错误。guardedFetch 可注入（单测不联网）。
 */

import {
  fetchWithSsrFGuard,
  type GuardedFetchResult,
} from '@cindy/browser-control-runtime/ssrf-runtime';

import {
  parseProviderManifest,
  type ProviderManifestRejectReason,
  type ProviderPreset,
} from '@cindy/model-providers';

import { isDeepLinkProviderManifestUrl } from '../../shared/deepLinkSchemes.js';

/** 拉取超时（与「获取模型列表」同量级）。 */
const FETCH_TIMEOUT_MS = 10_000;
/** manifest 响应体上限：单 preset 形态的 JSON 远小于此，超限视为异常输入。 */
const MAX_MANIFEST_BYTES = 64 * 1024;

/** SSRF 守卫拉取的注入面（模式同 publicImageFetch 的 GuardedImageFetch）。 */
export type GuardedManifestFetch = (params: {
  url: string;
  init?: RequestInit;
  signal: AbortSignal;
  requireHttps: true;
  maxRedirects: number;
}) => Promise<GuardedFetchResult>;

/** 拉取失败分类（网络 / 响应层）+ 内容校验拒绝原因（透传 parse reason）。 */
export type ProviderManifestFetchFailureReason =
  | 'invalid-url'
  | 'network'
  | 'timeout'
  | 'redirect'
  | 'blocked-address'
  | 'http-status'
  | 'oversize'
  | ProviderManifestRejectReason;

export type ProviderManifestFetchResult =
  | {
      ok: true;
      /** manifest URL 的 origin（确认屏展示来源；因拒绝重定向，恒等于请求 origin）。 */
      origin: string;
      preset: ProviderPreset;
    }
  | { ok: false; reason: ProviderManifestFetchFailureReason; status?: number };

/** 流式读体：累计超限立即取消读取并抛 oversize 标记，不把超大响应整段吸进内存。 */
const OVERSIZE = Symbol('manifest-oversize');

async function readBodyLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
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
        throw OVERSIZE;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function classifyFetchError(err: unknown): ProviderManifestFetchFailureReason {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
    // SSRF 守卫拒绝(loopback / 私网 / DNS 重绑定 / 非白名单主机)。
    if (err.name === 'SsrFBlockedError') return 'blocked-address';
    // maxRedirects=0 下任何重定向都会以 Too many redirects 结束。
    if (err.message.toLowerCase().includes('redirect')) return 'redirect';
  }
  return 'network';
}

/** 拉取并校验一份外部供应商 manifest。任何一步不合规都整条失败，绝无部分结果。 */
export async function fetchProviderManifest(
  url: string,
  guardedFetch: GuardedManifestFetch = fetchWithSsrFGuard,
): Promise<ProviderManifestFetchResult> {
  if (!isDeepLinkProviderManifestUrl(url)) return { ok: false, reason: 'invalid-url' };
  const parsedUrl = new URL(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let guarded: GuardedFetchResult | null = null;
  try {
    try {
      guarded = await guardedFetch({
        url,
        init: { method: 'GET', headers: { accept: 'application/json' } },
        signal: controller.signal,
        requireHttps: true,
        maxRedirects: 0,
      });
    } catch (err) {
      return { ok: false, reason: classifyFetchError(err) };
    }
    const { response } = guarded;
    // 守卫实现按 redirect: manual 返回时的兜底(常规路径已在守卫内抛 redirect)。
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, reason: 'redirect' };
    }
    if (!response.ok) return { ok: false, reason: 'http-status', status: response.status };
    // 声明长度超限直接拒绝,不开始读体;未声明或谎报的由流式限量兜底。
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_MANIFEST_BYTES) return { ok: false, reason: 'oversize' };
    let body: Uint8Array;
    try {
      body = await readBodyLimited(response, MAX_MANIFEST_BYTES);
    } catch (err) {
      if (err === OVERSIZE) return { ok: false, reason: 'oversize' };
      return { ok: false, reason: classifyFetchError(err) };
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(body);
    const parsed = parseProviderManifest(text);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    return {
      ok: true,
      origin: parsedUrl.origin,
      // id 重写为命名空间值(见文件头);其余字段保持 parse 输出的逐字段重建结果。
      preset: { ...parsed.preset, id: `manifest:${parsedUrl.host}` },
    };
  } finally {
    clearTimeout(timer);
    await guarded?.release().catch(() => undefined);
  }
}
