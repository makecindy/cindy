/**
 * ensureRemoteReadyForSessionStart 的跨层 holder。
 *
 * 真实现定义在 maker-ipc/register.ts 的 IPC 注册闭包里 (依赖同层大量闭包:
 * ensureRemoteHostReady / cc-manager install / codex MCP ensure / maker),
 * maker-host 构造 orca bridge deps 时拿不到;经本模块注入 / 读取,避免
 * maker-host 反向依赖 maker-ipc (依赖方向见 architecture-invariants)。
 *
 * 写入时机:register.ts 注册 IPC 时 (app 启动期, 早于任何 bridge 回调)。
 * 读取时机:orca bridge rehydrate remote session 前;未注入时 no-op,等价于
 * bridge 既有行为 (无远端能力的环境)。
 */

import type { AgentKind } from '@cindy/maker-core';

export interface RemoteSessionStartEnsureResult {
  remoteCodexDaemonRebootstrapped?: true;
}

export type RemoteSessionStartEnsure = (params: {
  session?: { agentKind: AgentKind; remoteHostId: string | null } | null;
  createOpts?: unknown;
}) => Promise<void | RemoteSessionStartEnsureResult>;

let impl: RemoteSessionStartEnsure | null = null;

export function setRemoteSessionStartEnsure(fn: RemoteSessionStartEnsure): void {
  impl = fn;
}

export function getRemoteSessionStartEnsure(): RemoteSessionStartEnsure | null {
  return impl;
}

/**
 * codex 远端 host 的 live-turn 判定 (register.ts 的 coordinator 真源)。
 * bridge 重建后的恢复遍历 (remote-codex-mcp-recovery) 经它决定 bootstrap
 * 是否推迟;未装配时恢复遍历整体不触发 (宁可不补刀, 不误杀 turn)。
 */
export type RemoteCodexLiveTurnChecker = (hostId: string) => boolean;

let liveTurnChecker: RemoteCodexLiveTurnChecker | null = null;

export function setRemoteCodexLiveTurnChecker(fn: RemoteCodexLiveTurnChecker): void {
  liveTurnChecker = fn;
}

export function getRemoteCodexLiveTurnChecker(): RemoteCodexLiveTurnChecker | null {
  return liveTurnChecker;
}

/**
 * 远端 CC session turn 收口的补偿判定 (maker-host 装配, register.ts 的
 * turn 收口路径经 holder 调用):fresh 标记已失效且无 turn 时 detach 旧
 * query, 下次 send 重新注入。
 */
export type RemoteCcTurnSettledHandler = (sessionId: string) => void;

let ccTurnSettledHandler: RemoteCcTurnSettledHandler | null = null;

export function setRemoteCcTurnSettledHandler(fn: RemoteCcTurnSettledHandler): void {
  ccTurnSettledHandler = fn;
}

export function getRemoteCcTurnSettledHandler(): RemoteCcTurnSettledHandler | null {
  return ccTurnSettledHandler;
}

/**
 * 远端 CC session 是否被显式 invalidate (staleInvalidatedCcSessions 成员,
 * maker-host 装配)。live SEND 路径在直发前查询:命中必须先 detach 走
 * lazy-resume (forceFresh), 否则 invalidate 的 fire-and-forget detach 与
 * 用户立即发送形成竞态 — 消息会进带旧 MCP URL 的活跃 query
 * (codex-connector R23 P2)。
 */
export type RemoteCcStaleQuery = (sessionId: string) => boolean;

let ccStaleQuery: RemoteCcStaleQuery | null = null;

export function setRemoteCcStaleQuery(fn: RemoteCcStaleQuery): void {
  ccStaleQuery = fn;
}

export function getRemoteCcStaleQuery(): RemoteCcStaleQuery | null {
  return ccStaleQuery;
}
