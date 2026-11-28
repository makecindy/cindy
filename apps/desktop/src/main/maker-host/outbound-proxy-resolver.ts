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

/** @internal 单测用:清空系统代理解析缓存、日志去重与路径快照状态。 */
export const resetOutboundProxyResolverStateForTest =
  desktopOutboundProxyResolver.resetOutboundProxyResolverStateForTest;
