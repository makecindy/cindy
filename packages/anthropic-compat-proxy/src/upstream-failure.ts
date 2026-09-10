/**
 * 上游连接失败的分类(#4100)。
 *
 * 代理把上游请求错误原样塞进 502 body(`upstream unreachable: <err>`),harness 再把它
 * 展示给用户。对「连本机回环端口被拒」这一种情况,原样文案会把人带偏:自定义供应商指向
 * 本地代理 / SSH 隧道(如 127.0.0.1:18080),隧道没起来时用户看到的是「上游不可达,通常
 * 是服务端临时问题」,进而去查远端服务或订阅。实际上只是本机没有进程监听那个端口。
 *
 * 这里只做**判定与措辞**,不改任何转发行为:ECONNREFUSED + 目标为回环地址 → 明确说
 * 「本机 <addr>:<port> 没有监听;若该端点是本地代理或 SSH 隧道,先把它启动再重试」,并
 * 给一个稳定的 code 供上层 / 用户识别。happy-eyeballs 的 AggregateError 逐个看内层错误。
 * 经出站代理转发时被拒的是代理本身,措辞随之改成「出站代理没有监听」。
 */

export const UPSTREAM_LOOPBACK_REFUSED_CODE = 'upstream_loopback_refused';

export interface RefusedConnection {
  address: string;
  port: number | null;
}

interface ErrnoLike {
  code?: unknown;
  address?: unknown;
  port?: unknown;
  errors?: unknown;
  cause?: unknown;
}

function isLoopbackAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  if (a === 'localhost' || a === '::1') return true;
  if (a.startsWith('::ffff:')) return isLoopbackAddress(a.slice('::ffff:'.length));
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/**
 * 从错误链里找出「连接被拒 + 回环地址」的那一条:沿 AggregateError.errors(happy-eyeballs)
 * 与 Error.cause(出站代理 agent 的包装错误,见 outbound-proxy.ts / socks5.ts)逐层查看。
 * 只认 ECONNREFUSED:ETIMEDOUT / ENOTFOUND 等不是「本机没监听」,不改措辞。
 */
export function findLoopbackRefusedConnection(err: unknown): RefusedConnection | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const e = current as ErrnoLike;
    if (e.code === 'ECONNREFUSED' && typeof e.address === 'string' && isLoopbackAddress(e.address)) {
      const port = typeof e.port === 'number' && Number.isFinite(e.port) ? e.port : null;
      return { address: e.address, port };
    }
    if (Array.isArray(e.errors)) queue.push(...e.errors);
    if (e.cause !== undefined) queue.push(e.cause);
  }
  return null;
}

export interface UpstreamFailureDescription {
  message: string;
  code?: string;
}

/**
 * 生成 502 body 的 message / code。默认保持既有文案(`upstream unreachable: <err>`)逐字
 * 不变;只有「回环地址 ECONNREFUSED」这一种情况换成可操作的措辞。
 */
export function describeUpstreamRequestFailure(
  err: unknown,
  opts: { viaOutboundProxy: boolean },
): UpstreamFailureDescription {
  const refused = findLoopbackRefusedConnection(err);
  if (!refused) return { message: `upstream unreachable: ${String(err)}` };
  const endpoint = refused.port === null ? refused.address : `${refused.address}:${refused.port}`;
  const what = opts.viaOutboundProxy
    ? `the outbound proxy at ${endpoint} on this machine`
    : `the configured upstream at ${endpoint} on this machine`;
  return {
    code: UPSTREAM_LOOPBACK_REFUSED_CODE,
    message:
      `upstream unreachable: connect ECONNREFUSED ${endpoint} — nothing is listening on that ` +
      `local port, so ${what} is not running. This is not a remote service or subscription ` +
      `problem: if that endpoint is a local proxy or an SSH tunnel, start it and retry.`,
  };
}
