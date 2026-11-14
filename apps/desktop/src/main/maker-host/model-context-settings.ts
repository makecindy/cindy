import { createModelContextProviderResolver } from './modelContextProvider.js';
import { isCodexGatewayWireModel, type AgentKind, type Catalog, type Effort } from '@cindy/model-providers';

import { desktopMakerLogger } from './logger-adapter.js';
import { readSessionContextWindowBudget } from './session-context-budget-store.js';
import { createSessionContextBudget, type SessionContextBudgetOpts } from './sessionContextBudgetCore.js';
import { desktopCodexAuthAdapter, readClaudeApiKey } from './auth-adapters.js';
import { hasClaudeNativeLogin } from './claude-native-auth.js';
import { gatewayDefaultRouteDecision } from './provider-route.js';
import { resolveModelContextProviderId, resolveVerifiedContextWindow } from './catalog-to-descriptors.js';
import { readModelContextLimit } from './model-context-limit-store.js';
import { resolveRouteModelEfforts } from './routeModelEfforts.js';
import { resolveRouteContextWindowBounds } from '../../shared/sessionContextWindow.js';
import type { SessionContextWindowBounds } from '../../shared/sessionContextWindowBounds.js';

/** Shared settings identity for startup, refresh and history protection of implicit routes. */
export const resolveDesktopModelContextProviderId = createModelContextProviderResolver({
  readGatewayKey: readClaudeApiKey, hasClaudeNativeLogin,
  hasCodexOAuthLogin: () => desktopCodexAuthAdapter.hasCodexOAuthLoginReadOnly(),
});

// Ports resolve at call time, not when this module loads.
const desktopContextBudget = createSessionContextBudget({
  resolveContextProviderId: (catalog, agent, providerId, modelId) =>
    resolveDesktopModelContextProviderId(catalog, agent, providerId, modelId),
  readSessionContextWindowBudget: (sessionId) => readSessionContextWindowBudget(sessionId),
  logger: { warn: (message, fields) => desktopMakerLogger.warn(message, fields) },
});

/** 该任务已保存的**原始**预算值（tokens）；null = 未自定义。口径见 sessionContextBudgetCore.ts。 */
export async function readStoredSessionContextWindowBudget(sessionId: string): Promise<number | null> {
  return desktopContextBudget.readStoredSessionContextWindowBudget(sessionId);
}

/** 把本任务的工作上下文预算写进会话创建参数；每条启动入口都必须经过这里。口径见 sessionContextBudgetCore.ts。 */
export async function applySessionContextWindowBudgetToCreateOpts(
  sessionId: string,
  opts: SessionContextBudgetOpts,
  catalog: Pick<Catalog, 'providers'>,
): Promise<void> {
  return desktopContextBudget.applySessionContextWindowBudgetToCreateOpts(sessionId, opts, catalog);
}

/** Working budgets can tighten history protection, but never raise its verified ceiling. */
export function resolveConfiguredContextWindow(
  catalog: Pick<Catalog, 'providers'>,
  agent: AgentKind,
  providerId: string | null | undefined,
  modelId: string,
  sessionBudget?: number | null,
): number | null {
  return desktopContextBudget.resolveConfiguredContextWindow(catalog, agent, providerId, modelId, sessionBudget);
}

/**
 * 预算变化是否真的改变**有效窗口**：不变时不必关掉活实例（模型级上限更紧、或重新选回
 * 当前档位造成的假变化都会落在 false）。收敛口径与运行时下发完全一致，否则会出现
 * 「判为无变化»不重建」但实际上引擎报文窗口不同的分叉。
 */
export function contextWindowBudgetChangesEffectiveWindow(input: {
  catalog: Pick<Catalog, 'providers'>;
  agent: AgentKind;
  providerId: string | null | undefined;
  modelId: string;
  previous: number | null;
  next: number | null;
}): boolean {
  const before = resolveConfiguredContextWindow(
    input.catalog, input.agent, input.providerId, input.modelId, input.previous,
  );
  const after = resolveConfiguredContextWindow(
    input.catalog, input.agent, input.providerId, input.modelId, input.next,
  );
  return before !== after;
}

/**
 * 会话级窗口边界：路由默认、路由物理上限、该路由的模型级上限。
 *
 * 与运行期收敛**同源**（同一批事实：目录路由唯一候选 + 该路由的模型级上限），
 * device-link 只读查询把它交给控制端，控制端才可能在远程任务上给出「更大」的档位。
 * 解不出路由时三个值都为 null（调用方必须退回「只允许收紧」，不要用扁平表猜）。
 */
export function resolveSessionContextWindowBounds(input: {
  catalog: Pick<Catalog, 'providers'>;
  agent: AgentKind;
  providerId: string | null | undefined;
  modelId: string;
  /**
   * 该任务已保存的预算（偏好文件里的**原始**用户值）与「是否显式设过」。
   * 缺省 = 跟随默认：不带会话上下文的调用方（如纯路由探测）不必关心它。
   */
  budget?: number | null;
  budgetCustomized?: boolean;
}): SessionContextWindowBounds {
  const source = resolveDesktopModelContextProviderId(
    input.catalog, input.agent, input.providerId, input.modelId,
  );
  const bounds = resolveRouteContextWindowBounds(input.catalog, input.agent, source, input.modelId);
  const modelLimit = source ? readModelContextLimit(input.agent, source, input.modelId) : null;
  const budget = typeof input.budget === 'number' && Number.isFinite(input.budget) && input.budget > 0
    ? Math.round(input.budget) : null;
  return {
    providerId: source,
    defaultWindow: bounds?.defaultWindow ?? null,
    maxWindow: bounds?.maxWindow ?? null,
    // 「清掉任务预算后跟随默认会得到多少」由主进程按同一套 resolveConfiguredContextWindow 算好
    // 下发（传 null 预算）；调用方不必（也不该）自己重推。刻意不带当前预算：档位表里的「模型默认」
    // 档选中后会写 null，运行期回到的正是这个值。
    defaultEffectiveWindow: resolveConfiguredContextWindow(
      input.catalog, input.agent, source, input.modelId, null,
    ),
    // main 会施加的物理上限。用同一支 resolveVerifiedContextWindow 传一个极大的预算取回它的
    // `contextWindowMax ?? contextWindow`（不为任何值做第二套推导）；路由不唯一/未核实 → null。
    maxEffectiveWindow: resolveVerifiedContextWindow(
      input.catalog, input.agent, source, input.modelId, Number.MAX_SAFE_INTEGER,
    ),
    // 本进程就是这两个字段的权威来源：显式申报，调用方据此区分「未核实 → 无这道夹」与
    // 「老被控端根本没申报 → 必须退回只允许收紧」。
    effectiveWindowsReported: true,
    modelLimit: typeof modelLimit === 'number' && Number.isFinite(modelLimit) && modelLimit > 0
      ? modelLimit : null,
    budget,
    budgetCustomized: input.budgetCustomized === true,
  };
}

/**
 * Efforts declared by the route this session actually uses. Same-ID models from different
 * providers can declare different efforts; null means the route is unknown or ambiguous.
 */
export function resolveDesktopModelEfforts(
  catalog: Pick<Catalog, 'providers'>,
  agent: AgentKind,
  providerId: string | null | undefined,
  modelId: string,
): readonly Effort[] | null {
  return resolveRouteModelEfforts(resolveDesktopModelContextProviderId, catalog, agent, providerId, modelId);
}
