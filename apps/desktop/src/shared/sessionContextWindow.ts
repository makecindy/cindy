import type { AgentKind, Catalog, CatalogModel } from '@cindy/model-providers';
import { dbToMakerAgentKind } from './agentKindConversion';

/** Route identity carried by both persisted sessions and their renderer projection. */
export interface ContextWindowSession {
  agentKind?: string | null;
  model?: string | null;
  providerId?: string | null;
}

/**
 * Resolve catalog metadata for an unambiguous, verified route. Callers decide
 * whether it is a fallback or a projection; it cannot replace native Codex usage.
 * Never borrow a same-id model from another provider.
 */
export function resolveVerifiedContextWindow(
  catalog: Pick<Catalog, 'providers'>,
  agent: AgentKind,
  providerId: string | null | undefined,
  modelId: string,
  workingBudget?: number | null,
): number | null {
  const candidates: CatalogModel[] = [];
  for (const provider of catalog.providers) {
    if (provider.routing[agent]?.disabled === true) continue;
    if (providerId && provider.id !== providerId) continue;
    for (const model of provider.models[agent] ?? []) {
      if (model.id === modelId) candidates.push(model);
    }
  }
  if (candidates.length !== 1) return null;
  const only = candidates[0];
  if (only.contextWindowVerified !== true) return null;
  if (!Number.isFinite(only.contextWindow) || only.contextWindow <= 0) return null;
  // The working default may be deliberately below the verified route maximum.
  // An explicit budget can raise that default, but cannot raise physical capacity.
  const maximum = typeof only.contextWindowMax === 'number' &&
    Number.isFinite(only.contextWindowMax) && only.contextWindowMax > 0
    ? only.contextWindowMax : only.contextWindow;
  const budget = typeof workingBudget === 'number' && Number.isFinite(workingBudget) && workingBudget > 0
    ? workingBudget : only.contextWindow;
  return Math.min(budget, maximum);
}

/**
 * 该路由的窗口边界（默认工作窗口 + 声明上限），给任务级窗口档位用。
 *
 * 与 `resolveVerifiedContextWindow` 的区别：不要求 `contextWindowVerified === true`
 * （路由未核实但声明了 `max_context_window` 的目录形态真实存在，主进程同样会按它夹紧），
 * 且不借用「运行时上报才可信」那套 pi/codex 快照口径 —— 档位需要一个路由级锚点，
 * 否则 Pi / Codex 任务会回落成跨 provider 去重的扁平表值。
 *
 * 仍然要求路由唯一：同一 model id 由多个 provider 提供且未限定 providerId 时返回 null
 * （宁可只允许收紧，也不能把另一条路由的上限当成事实；这正是 availableModels 扁平表
 * 不能兼作上限来源的原因）。解出唯一候选时回传它解析到的 `providerId`，调用方据此读
 * 同一路由的模型级上限，不必自己再猜一遍来源。
 */
export function resolveRouteContextWindowBounds(
  catalog: Pick<Catalog, 'providers'>,
  agent: AgentKind,
  providerId: string | null | undefined,
  modelId: string,
): { providerId: string; defaultWindow: number; maxWindow: number | null } | null {
  const candidates: { providerId: string; model: CatalogModel }[] = [];
  for (const provider of catalog.providers) {
    if (provider.routing[agent]?.disabled === true) continue;
    if (providerId && provider.id !== providerId) continue;
    for (const model of provider.models[agent] ?? []) {
      if (model.id === modelId) candidates.push({ providerId: provider.id, model });
    }
  }
  if (candidates.length !== 1) return null;
  const { providerId: sourceProviderId, model } = candidates[0];
  const contextWindow = Number.isFinite(model.contextWindow) && model.contextWindow > 0
    ? Math.round(model.contextWindow)
    : null;
  const declaredMax = typeof model.contextWindowMax === 'number' &&
    Number.isFinite(model.contextWindowMax) && model.contextWindowMax > 0
      ? Math.round(model.contextWindowMax)
      : null;
  // 「物理上限」只收 main 真会拿来夹预算的数：
  //  - 声明了 `contextWindowMax`：未核实路由也按它夹（见 resolveConfiguredContextWindow）；
  //  - **已核实**路由的 `contextWindow`：resolveVerifiedContextWindow 按
  //    `min(预算, contextWindowMax ?? contextWindow)` 夹，它就是真容量；
  //  - **未核实且没声明上限**：目录里的 `contextWindow` 只是**兜底默认**（自定义连接未声明
  //    窗口时是 DEFAULT_CUSTOM_CONTEXT_WINDOW=200K），不是容量 —— main 刻意不按它夹，
  //    任务预算可以是它���倍且真的会生效。早先在这里兜底成 maxWindow，会让档位基准被 200K
  //    钉死，把「模型默认 1M」显示成 500%（用户实测报障，2026-09-22）。
  const maxWindow = declaredMax ?? (model.contextWindowVerified === true ? contextWindow : null);
  const anchor = maxWindow ?? contextWindow;
  if (anchor === null) return null;
  const defaultWindow = contextWindow === null ? anchor : Math.min(contextWindow, anchor);
  return { providerId: sourceProviderId, defaultWindow, maxWindow };
}

/** Codex and Pi report their effective runtime windows; catalogs cannot replace them. */
export function resolveSessionContextWindow(
  catalog: Pick<Catalog, 'providers'>,
  session: ContextWindowSession,
): number | null {
  if (!session.model || session.agentKind === 'pi' || session.agentKind === 'codex') return null;
  return resolveVerifiedContextWindow(
    catalog,
    dbToMakerAgentKind(session.agentKind),
    session.providerId,
    session.model,
  );
}

/** Preserve proven runtime budgets; legacy catalog snapshots retain read-time correction. */
export function projectSessionContextWindow<
  T extends ContextWindowSession & { contextWindow: number; contextWindowRuntime?: number | null },
>(session: T, resolve?: (session: ContextWindowSession) => number | null): T {
  if (Number.isFinite(session.contextWindow) && session.contextWindow > 0 &&
      session.contextWindowRuntime === session.contextWindow) return session;
  const window = resolve?.(session);
  return window && Number.isFinite(window) && window > 0 && window !== session.contextWindow
    ? { ...session, contextWindow: window }
    : session;
}
