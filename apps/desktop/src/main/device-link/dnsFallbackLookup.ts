/**
 * device-link relay 建连的 DNS 回退层。
 *
 * 弱网(尤其 VPN 接管 DNS)下 getaddrinfo 可能直接失败或挂起数秒,把 15s 握手
 * 窗口整段吃掉(2026-08-02/03 实测:DNS 单段 5s 超时,relay 握手连续 25 分钟
 * 全部失败)。而 relay 域名的解析结果在一次会话内基本稳定,所以:
 *
 *  - 每次成功解析都刷新 host(+family)→ 地址 的内存缓存(不落盘);
 *  - 解析**失败**且有缓存 → 回退最近成功地址。stale-ok:地址若已轮换,后果只是
 *    TCP/TLS 连接失败走既有退避,与没有缓存时相同,不会更糟;
 *  - 解析**超过 slowFallbackMs** 且有缓存 → 先用缓存建连,不等原生结果;原生
 *    结果迟到后仍刷新缓存,供下一轮使用;
 *  - `options.all`(多地址形态,net 直连不走)与「无缓存的慢解析」不介入,
 *    保持原生行为。
 *
 * 只挂在 device-link 的 WebSocket 工厂上(代理模式下由代理解析域名,本层自然
 * 旁路),不影响 auth / heartbeat 等 HTTP 链路。
 */
import dns from 'node:dns';

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | dns.LookupAddress[],
  family?: number,
) => void;

/** net/tls 的 lookup 注入点形态(net 总是传 options 对象;宽容函数形态以防万一)。 */
export type DnsLookupFn = (
  hostname: string,
  options: dns.LookupOptions | LookupCallback,
  callback?: LookupCallback,
) => void;

export interface DnsFallbackLookupOptions {
  /** 测试注入;默认 node:dns 的 lookup。 */
  lookupImpl?: DnsLookupFn;
  /** 原生解析超过该时长且有缓存时,先用缓存建连。 */
  slowFallbackMs?: number;
  log?: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
  };
}

export const DNS_SLOW_FALLBACK_MS = 4_000;

interface CachedAddress {
  address: string;
  family: number;
}

export function createDnsFallbackLookup(opts: DnsFallbackLookupOptions = {}): DnsLookupFn {
  const lookupImpl: DnsLookupFn = opts.lookupImpl ?? (dns.lookup as unknown as DnsLookupFn);
  const slowFallbackMs = opts.slowFallbackMs ?? DNS_SLOW_FALLBACK_MS;
  const log = opts.log;
  const cache = new Map<string, CachedAddress>();

  return (hostname, optionsOrCb, maybeCb) => {
    const options: dns.LookupOptions = typeof optionsOrCb === 'function' ? {} : optionsOrCb;
    const callback = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb) as LookupCallback;

    // all 形态(回调收数组)极少出现在 socket 建连路径;不缓存、不回退,原样透传。
    if (options.all) {
      lookupImpl(hostname, options, callback);
      return;
    }

    const cacheKey = `${hostname}|${options.family ?? 0}`;
    const cached = cache.get(cacheKey);
    let settled = false;

    const settle = (err: NodeJS.ErrnoException | null, address?: string, family?: number): void => {
      if (settled) return;
      settled = true;
      if (slowTimer) clearTimeout(slowTimer);
      callback(err, address, family);
    };

    // 有缓存才 arm 慢解析回退:无缓存时提前失败只会更糟,等原生结果。
    const slowTimer = cached
      ? setTimeout(() => {
          log?.warn(
            `DNS lookup slow (>${slowFallbackMs}ms) for ${hostname}; using cached ${cached.address}`,
          );
          settle(null, cached.address, cached.family);
        }, slowFallbackMs)
      : null;
    (slowTimer as unknown as { unref?: () => void } | null)?.unref?.();

    lookupImpl(hostname, options, (err, address, family) => {
      // 迟到的原生结果(慢回退已建连)仍然刷新缓存,供下一轮使用。
      if (!err && typeof address === 'string' && address) {
        cache.set(cacheKey, { address, family: typeof family === 'number' ? family : 4 });
      }
      if (settled) return;
      if (err && cached) {
        log?.warn(
          `DNS lookup failed for ${hostname} (${err.code ?? err.message}); falling back to cached ${cached.address}`,
        );
        settle(null, cached.address, cached.family);
        return;
      }
      settle(err, typeof address === 'string' ? address : undefined, family);
    });
  };
}
