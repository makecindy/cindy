/**
 * Telegram 群历史检索的逐 turn 权限租约。
 *
 * MCP 工具不信任模型参数或持久 session 配置来判断 owner。个人/官方 Telegram
 * 只在 provider 真正开始当前 turn 前登记作用域，终态、重排或失败时同步释放。
 * sessionInstanceId 阻断同一业务 session 重建后，旧 MCP 请求借用新实例权限。
 */

import type { GroupHistorySearchLane } from './groupHistorySearch';

export type GroupHistoryAccessLevel = 'lane' | 'owner';

export interface GroupHistoryAccessScope {
  access: GroupHistoryAccessLevel;
  /** 当前 bot 的存储命名空间；owner 无当前群 lane 的 DM 轮次仍需要它。 */
  provider: string;
  /** 当前群/topic lane；owner DM 轮次为 null。 */
  lane: GroupHistorySearchLane | null;
}

interface ActiveAccess {
  sessionInstanceId: string;
  token: symbol;
  scope: GroupHistoryAccessScope;
}

const activeBySession = new Map<string, ActiveAccess>();

function assertScope(scope: GroupHistoryAccessScope): void {
  if (!scope.provider.trim()) throw new Error('group history access provider is required');
  if (scope.lane && scope.lane.provider !== scope.provider) {
    throw new Error('group history access lane provider mismatch');
  }
}

export function beginGroupHistoryAccess(args: {
  sessionId: string;
  sessionInstanceId: string;
  scope: GroupHistoryAccessScope;
}): () => void {
  if (!args.sessionId) throw new Error('group history access sessionId is required');
  if (!args.sessionInstanceId) {
    throw new Error('group history access sessionInstanceId is required');
  }
  assertScope(args.scope);
  const token = Symbol('group-history-access');
  activeBySession.set(args.sessionId, {
    sessionInstanceId: args.sessionInstanceId,
    token,
    scope: args.scope,
  });
  return () => {
    const active = activeBySession.get(args.sessionId);
    if (active?.token === token) activeBySession.delete(args.sessionId);
  };
}

export function readGroupHistoryAccess(args: {
  sessionId?: string;
  sessionInstanceId?: string;
}): GroupHistoryAccessScope | null {
  if (!args.sessionId || !args.sessionInstanceId) return null;
  const active = activeBySession.get(args.sessionId);
  if (!active || active.sessionInstanceId !== args.sessionInstanceId) return null;
  return active.scope;
}

/** 测试/进程级 teardown；生产授权仍必须通过租约 release 收口。 */
export function resetGroupHistoryAccessForTests(): void {
  activeBySession.clear();
}
