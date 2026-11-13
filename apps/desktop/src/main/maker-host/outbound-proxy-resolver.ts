/**
 * Desktop 出站代理解析器的接线 —— 解析逻辑在 outboundProxyResolverCore.ts(与 Node Host
 * 共用),这里只把系统代理那一层的两个端口绑到 Electron:`app.isReady()` 与
 * `session.defaultSession`(Chromium 按系统设置 / PAC 逐 URL 解析)。
 *
 * 整个桌面进程只建一个实例,所有调用方共用同一份系统代理缓存与路径快照。
 */

import { app, session } from 'electron';

import { isLoopbackHostname, type OutboundProxyResolver } from '@cindy/anthropic-compat-proxy';

import { createOutboundProxyResolver } from './outboundProxyResolverCore.js';
import type { OutboundPathSnapshot } from './outboundProxyResolverCore.js';
// 传输层(真实 socket)自己的解析口径:诊断探针必须用同一把尺子,否则判出来的路径
// 与真实请求不是同一条(协议归一 + path + 明文 ws 的代理限制)。
import { transportIsPlaintextWebSocket, transportProxyResolveKey } from './outbound-fetch.js';

export {
  parseChromiumProxyResult,
  type ChromiumProxyVerdict,
  type OutboundPathKind,
  type OutboundPathSnapshot,
  type OutboundPathUnknownReason,
} from './outboundProxyResolverCore.js';

const desktopOutboundProxyResolver = createOutboundProxyResolver({
  isAppReady: () => app.isReady(),
  getProxySession: () => session.defaultSession,
});

/** 两个 proxy host 与通用出站共用的解析器(见 outboundProxyResolverCore.ts)。 */
export const resolveDesktopOutboundProxy: OutboundProxyResolver =
  desktopOutboundProxyResolver.resolveDesktopOutboundProxy;

/** 取指定上游的出站路径判定(只读诊断,见 outboundProxyResolverCore.ts)。 */
export const getOutboundPathSnapshotFor = desktopOutboundProxyResolver.getOutboundPathSnapshotFor;

/**
 * 诊断探针(#9537):主动解析一次候选 origin 的出站路径并返回快照,不发任何业务请求。
 *
 * 复用正式解析路径——env 优先 / 系统 PAC / 30s TTL 缓存 / 转发层可用性判定与真实
 * 转发逐字节同口径,顺带落进 outboundPathByKey(与其它消费方共享的诊断快照)。
 * 想问的 origin 还没被任何真实请求解析过时,这一步就是它的首次解析;已解析过则命中
 * 缓存,调用方可以放心在 UI 路径上调。
 *
 * 入参是**候选 origin 列表**而不是单个值:调用方(连接诊断)往往无法确知这次失败走的
 * 是哪条线路 —— 自建中转选中时,同账号设备走自建 relay,而共享任务走独立的官方连接
 * (routedClient 的 crossAccountConnection,见 device-link/index.ts)。因此:
 *
 * 1. **候选里出现 loopback 一律不报**:自建中转常驻 127.0.0.1,而真实传输层对 loopback
 *    上游一律直连(outbound-fetch 的 resolveProxyTarget 与 dispatcher pick 都先跳过)。
 *    env 里的 HTTP_PROXY(无对应 NO_PROXY)会让通用解析器返回代理,照报就是谎称走了
 *    代理;同时 loopback 候选也意味着链路不止一条路径,无从断言「当前连接经代理」。
 * 2. **候选之间判定必须一致**:getOutboundPathSnapshotFor 的冲突判定只在同 origin
 *    组内,跨 origin 取最新 —— 对「任一候选都可能是当前路径」的诊断不够,一致性的
 *    校验在这里做。不一致(PAC 逐 path / NO_PROXY 差异)按宁可不报处理。
 */
export async function probeOutboundPathFor(
  upstreamUrls: readonly string[],
): Promise<OutboundPathSnapshot | null> {
  // 与传输层同一把尺子:解析键 = 协议归一(ws→http / wss→https)+ host + path。
  // 只送 origin 会让 env 代理读到另一个协议槽(HTTPS_PROXY / HTTP_PROXY)、让 PAC
  // 丢掉逐 path 的判定 —— 判出来的路径可能与真实 socket 正好相反(#9537 评审)。
  const targets = [...new Map(
    upstreamUrls.map((url) => [url, {
      url,
      resolveKey: transportProxyResolveKey(url),
      plaintextWebSocket: transportIsPlaintextWebSocket(url),
    }]),
  ).values()];
  if (targets.length === 0) return null;
  if (targets.some((t) => isLoopbackOrigin(originForLog(t.url)))) return null;
  await Promise.all(targets.map((t) => resolveDesktopOutboundProxy(t.resolveKey)));
  const verdicts = targets.map((t) => {
    const snap = getOutboundPathSnapshotFor([t.resolveKey]);
    if (!snap) return null;
    // 明文 ws:// 遇到 HTTP 代理:传输层拒用该代理(upgrade 握手必须是隧道),实际是
    // 直连 —— 报「经代理」是谎报,宁可不报。socks5 不受这条限制。
    if (t.plaintextWebSocket && snap.kind === 'proxy' && isHttpProxyAddress(snap.proxy)) return null;
    return snap;
  });
  const first = verdicts[0];
  if (!first) return null;
  for (const v of verdicts) {
    // 组内冲突(同 origin 多条判定不一致)→ 无快照;候选之间结论不同 → 宁可不报。
    if (!v || v.kind !== first.kind || v.proxy !== first.proxy) return null;
  }
  return first;
}

/** 快照里的代理地址是不是 HTTP 代理(脱敏形态 scheme://host:port)。 */
function isHttpProxyAddress(proxy: string | null | undefined): boolean {
  return typeof proxy === 'string' && proxy.startsWith('http://');
}

/** origin(protocol//host)的 hostname 是否 loopback —— 传输层对此类上游一律直连。 */
function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** 日志维度恒为 origin:path 可能带业务语义;这里只用来把候选 URL 归一到 origin 去重。 */
function originForLog(upstreamUrl: string): string {
  try {
    const u = new URL(upstreamUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return upstreamUrl;
  }
}

/** @internal 单测用:清空系统代理解析缓存、日志去重与路径快照状态。 */
export const resetOutboundProxyResolverStateForTest =
  desktopOutboundProxyResolver.resetOutboundProxyResolverStateForTest;
