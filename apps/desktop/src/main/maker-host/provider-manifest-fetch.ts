/**
 * provider-manifest-fetch —— 外部供应商 manifest（settings/providers?manifest= 深链）的
 * 主进程受限拉取。
 *
 * 信任边界设计（对应 issue #3387 的契约）：
 *   - 下载只在主进程发生，renderer 只拿结构化结果；
 *   - 仅 https、无凭证 URL（深链解析层已过 `isDeepLinkProviderManifestUrl`，这里
 *     再复核一次——本模块也被 IPC 直接暴露，不能假设调用方已校验）；
 *   - **拒绝一切重定向**（`redirect: 'error'`）：确认屏展示的来源 origin 恒等于
 *     manifest URL 的 origin，不存在"重定向后最终来源"的歧义面；
 *   - 响应体大小上限 64 KiB、超时 10s；非 2xx、非 JSON、超限一律结构化失败；
 *   - 内容校验走 `parseProviderManifest`（fail-closed，见 @cindy/model-providers），
 *     任何字段越界整条拒绝，绝不部分预填；
 *   - 通过后把 preset.id 重写为 `manifest:<host>`：含 `:` 的命名空间值永不与
 *     catalog preset id / 内置 provider id / 本机检测特例（如 lmstudio）碰撞;
 *     最终落库 id 由用户侧 `uniqueCustomProviderId` 生成，manifest id 纯模板元数据。
 *
 * 查询型结构化返回（规则 13 例外条款，同 provider-model-fetch）：renderer 需要
 * reason 渲染分类文案，网络 / 内容失败不抛 IPC 错误。fetch 可注入（单测不联网）。
 */

import {
  parseProviderManifest,
  type ProviderManifestRejectReason,
  type ProviderPreset,
} from '@cindy/model-providers';

import { isDeepLinkProviderManifestUrl } from '../../shared/deepLinkSchemes.js';
import { outboundFetch } from './outbound-fetch.js';

/** 拉取超时（与「获取模型列表」同量级）。 */
const FETCH_TIMEOUT_MS = 10_000;
/** manifest 响应体上限：单 preset 形态的 JSON 远小于此，超限视为异常输入。 */
const MAX_MANIFEST_BYTES = 64 * 1024;

/** 拉取失败分类（网络 / 响应层）+ 内容校验拒绝原因（透传 parse reason）。 */
export type ProviderManifestFetchFailureReason =
  | 'invalid-url'
  | 'network'
  | 'timeout'
  | 'redirect'
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

/** 拉取并校验一份外部供应商 manifest。任何一步不合规都整条失败，绝无部分结果。 */
export async function fetchProviderManifest(
  url: string,
  fetchImpl: typeof fetch = outboundFetch,
): Promise<ProviderManifestFetchResult> {
  if (!isDeepLinkProviderManifestUrl(url)) return { ok: false, reason: 'invalid-url' };
  const parsedUrl = new URL(url);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { ok: false, reason: 'timeout' };
    }
    // undici 把 redirect: 'error' 的命中包成 TypeError(cause 里带说明);无法与
    // 其它网络失败稳定区分的实现下统一归 network——两者对用户的处置一致(换直链)。
    if (isRedirectError(err)) return { ok: false, reason: 'redirect' };
    return { ok: false, reason: 'network' };
  }
  // 个别 fetch 实现对 redirect: 'error' 不抛而是返回 opaque/redirect 响应,兜底拒绝。
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    return { ok: false, reason: 'redirect' };
  }
  if (!res.ok) return { ok: false, reason: 'http-status', status: res.status };
  let body: ArrayBuffer;
  try {
    body = await res.arrayBuffer();
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (body.byteLength > MAX_MANIFEST_BYTES) return { ok: false, reason: 'oversize' };
  const text = new TextDecoder('utf-8', { fatal: false }).decode(body);
  const parsed = parseProviderManifest(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return {
    ok: true,
    origin: parsedUrl.origin,
    // id 重写为命名空间值(见文件头);其余字段保持 parse 输出的逐字段重建结果。
    preset: { ...parsed.preset, id: `manifest:${parsedUrl.host}` },
  };
}

function isRedirectError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const texts = [err.message, err.cause instanceof Error ? err.cause.message : ''];
  return texts.some((t) => typeof t === 'string' && t.toLowerCase().includes('redirect'));
}
