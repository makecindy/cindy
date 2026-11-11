/**
 * Desktop 出站代理解析器的接线 —— 解析逻辑在 outboundProxyResolverCore.ts(与 Node Host
 * 共用),这里只把系统代理那一层的两个端口绑到 Electron:`app.isReady()` 与
 * `session.defaultSession`(Chromium 按系统设置 / PAC 逐 URL 解析)。
 *
 * 整个桌面进程只建一个实例,所有调用方共用同一份系统代理缓存与路径快照。
 */

import { app, session } from 'electron';

import type { OutboundProxyResolver } from '@cindy/anthropic-compat-proxy';

import { createOutboundProxyResolver } from './outboundProxyResolverCore.js';

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
 * 诊断探针(#9537):主动解析一次某 origin 的出站路径并返回快照,不发任何业务请求。
 *
 * 复用正式解析路径——env 优先 / 系统 PAC / 30s TTL 缓存 / 转发层可用性判定与真实
 * 转发逐字节同口径,顺带落进 outboundPathByKey(与其它消费方共享的诊断快照)。
 * 想问的 origin 还没被任何真实请求解析过时,这一步就是它的首次解析;已解析过则命中
 * 缓存,调用方可以放心在 UI 路径上调。返回 null = 同 origin 存在冲突判定(PAC 逐 path
 * 给出不同答案),按既有语义宁可不报。
 */
export async function probeOutboundPathFor(upstreamUrl: string): Promise<OutboundPathSnapshot | null> {
  await resolveDesktopOutboundProxy(upstreamUrl);
  return getOutboundPathSnapshotFor([upstreamUrl]);
}

/** @internal 单测用:清空系统代理解析缓存、日志去重与路径快照状态。 */
export const resetOutboundProxyResolverStateForTest =
  desktopOutboundProxyResolver.resetOutboundProxyResolverStateForTest;
