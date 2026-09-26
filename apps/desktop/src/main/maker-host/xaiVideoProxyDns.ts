/** 仅供已鉴权 xAI 视频 CDN 在代理出口下解析；不改变系统 DNS/代理，也不绕过后续 SSRF/IP pinning。 */
import { isIP } from 'node:net';
import type { LookupFn } from '@cindy/browser-control-runtime/ssrf-runtime';

export const XAI_VIDEO_CDN_HOST = 'vidgen.x.ai';
const RESOLVER = 'https://cloudflare-dns.com/dns-query?name=vidgen.x.ai&type=A';
const MAX_DNS_BYTES = 16 * 1024;

export class XaiVideoDnsError extends Error {
  readonly code = 'XAI_CDN_DNS_UNAVAILABLE';
  constructor() {
    super('视频 CDN 的安全 DNS 解析暂不可用');
  }
}

/** fetch 必须是 Host 的既有代理感知出口；仅发送公共 hostname，不携带下载 URL 或账号凭据。 */
export function createXaiVideoProxyLookup(
  fetchImplementation: typeof fetch,
  signal?: AbortSignal,
): LookupFn {
  return (async (hostname: string, options: { all?: boolean }) => {
    if (hostname !== XAI_VIDEO_CDN_HOST || options?.all !== true) throw new XaiVideoDnsError();
    const boundedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000);
    let response: Response | undefined;
    try {
      response = await fetchImplementation(RESOLVER, {
        method: 'GET',
        redirect: 'error',
        signal: boundedSignal,
        headers: { Accept: 'application/dns-json' },
      });
      if (!response.ok || Number(response.headers.get('content-length')) > MAX_DNS_BYTES)
        throw new XaiVideoDnsError();
      const reader = response.body?.getReader();
      if (!reader) throw new XaiVideoDnsError();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_DNS_BYTES) throw new XaiVideoDnsError();
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const data = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as {
        Status?: unknown;
        Question?: Array<{ name?: unknown; type?: unknown }>;
        Answer?: Array<{ type?: unknown; data?: unknown }>;
      };
      if (
        data.Status !== 0 ||
        data.Question?.length !== 1 ||
        data.Question[0].type !== 1 ||
        String(data.Question[0].name).replace(/\.$/, '').toLowerCase() !== hostname ||
        !Array.isArray(data.Answer) ||
        data.Answer.length > 64
      )
        throw new XaiVideoDnsError();
      const addresses = [
        ...new Set(
          data.Answer.filter((record) => record.type === 1)
            .map((record) => record.data)
            .filter(
              (address): address is string => typeof address === 'string' && isIP(address) === 4,
            ),
        ),
      ];
      if (!addresses.length) throw new XaiVideoDnsError();
      // 不在这里信任 public/private；真实 resolvePinnedHostnameWithPolicy 必须继续验证全部答案。
      return addresses.map((address) => ({ address, family: 4 }));
    } catch {
      throw new XaiVideoDnsError();
    } finally {
      await response?.body?.cancel().catch(() => undefined);
    }
  }) as LookupFn;
}
