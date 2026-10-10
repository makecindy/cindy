/**
 * 这台电脑上每个供应商正在运行一轮的任务数(docs/product-rules/provider-groups.md §5)：Agent 在本机运行的
 * 本机任务，加上替其他电脑运行的远程 Agent 任务，不论是谁发起的、是否经过供应商组。
 *
 * 组所在电脑用它显示组里的「本机」这台；同账号电脑把它放进给组所在电脑的目录(`runningTurns`)，组所在电脑
 * 据此显示那台。只读运行状态与任务记录，不落盘。
 */
import type { AgentKind } from '@cindy/maker-core';

export interface ProviderLocalLoadRoute {
  id: string;
  agentKind: AgentKind;
  model: string | null;
  providerId: string | null;
  agentDeviceId: string | null;
  remoteHostId: string | null;
}

export interface ProviderLocalLoadDeps {
  /** 本机正在运行一轮的任务 id。 */
  listTurnRunningSessions(): readonly string[];
  readSessionRoutes(sessionIds: readonly string[]): Promise<readonly ProviderLocalLoadRoute[]>;
  /** 任务记录没写来源(provider_id 为空)时本机实际会用的来源。 */
  resolveImplicitProvider(agentKind: AgentKind, model: string): Promise<string | null>;
  /** 替其他电脑运行、正在运行一轮的远程 Agent 任务用的本机供应商(每个任务一项)。 */
  hostRunningProviders(): readonly string[];
}

export async function countProviderRunningTurns(deps: ProviderLocalLoadDeps): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const add = (providerId: string) => counts.set(providerId, (counts.get(providerId) ?? 0) + 1);
  for (const providerId of deps.hostRunningProviders()) add(providerId);
  const running = deps.listTurnRunningSessions();
  if (running.length === 0) return counts;
  const implicit = new Map<string, Promise<string | null>>();
  for (const route of await deps.readSessionRoutes(running)) {
    // Agent 在另一台电脑、分享来的电脑或 SSH 主机上运行的任务算在那里，不算本机。
    if (route.agentDeviceId || route.remoteHostId) continue;
    let providerId = route.providerId;
    if (!providerId && route.model) {
      const key = `${route.agentKind}\u0000${route.model}`;
      if (!implicit.has(key)) implicit.set(key, deps.resolveImplicitProvider(route.agentKind, route.model).catch(() => null));
      providerId = await implicit.get(key)!;
    }
    if (providerId) add(providerId);
  }
  return counts;
}
