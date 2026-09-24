import type { AgentKind, Catalog } from '@cindy/model-providers';

import { desktopMakerLogger } from './logger-adapter.js';
import { readSessionContextWindowBudget } from './session-context-budget-store.js';
import { desktopCodexAuthAdapter, readClaudeApiKey } from './auth-adapters.js';
import { hasClaudeNativeLogin } from './claude-native-auth.js';
import { gatewayDefaultRouteDecision } from './provider-route.js';
import { resolveModelContextProviderId, resolveVerifiedContextWindow } from './catalog-to-descriptors.js';
import { readModelContextLimit } from './model-context-limit-store.js';
import { resolveRouteContextWindowBounds } from '../../shared/sessionContextWindow.js';
import type { SessionContextWindowBounds } from '../../shared/sessionContextWindowBounds.js';

/** Shared settings identity for startup, refresh and history protection of implicit routes. */
export function resolveDesktopModelContextProviderId(
  catalog: Pick<Catalog, 'providers'>,
  agent: AgentKind,
  providerId: string | null | undefined,
  modelId: string,
): string | null {
  const source = resolveModelContextProviderId(catalog, agent, providerId, modelId);
  if (source || providerId) return source;
  // Implicit Claude sessions use the gateway whenever a gateway key exists; only without one
  // do they fall back to the local Claude Code login (same order as the Claude auth adapter).
  // Codex's ordinary implicit models instead inherit subscription-first spawn credentials.
  const defaultSource = agent === 'claude-code'
    ? gatewayDefaultRouteDecision(agent, readClaudeApiKey()) ? 'xd'
      : hasClaudeNativeLogin() ? 'anthropic' : null
    : agent === 'codex'
      ? modelId.startsWith('codex/') ? 'xd'
        : desktopCodexAuthAdapter.hasCodexOAuthLoginReadOnly() ? 'openai' : 'xd'
      : null;
  return resolveModelContextProviderId(catalog, agent, providerId, modelId, defaultSource);
}

/** 取两个可选上限中更紧的那个（都缺省时返回 null = 跟随目录默认）。 */
function tighterBudget(
  sessionBudget: number | null | undefined,
  modelLimit: number | null,
): number | null {
  const session = typeof sessionBudget === 'number' && Number.isFinite(sessionBudget) && sessionBudget > 0
    ? Math.round(sessionBudget) : null;
  if (session === null) return modelLimit;
  if (modelLimit === null) return session;
  // 任务级预算可以比路由默认更省、也可以在上限内提高，但不得越过用户对这条路由
  // 设过的显式上限（那是一个更强的「别再多了」意图；两者冲突时取更紧者，
  // UI 用 buildContextWindowBudgetOptions 把上界体现在可选档位里）。
  return Math.min(session, modelLimit);
}

/** 该任务已保存的**原始**预算值（tokens）；null = 未自定义。切模/校验需要按目标路由重新收敛时用它。 */
export async function readStoredSessionContextWindowBudget(sessionId: string): Promise<number | null> {
  try {
    return readSessionContextWindowBudget(sessionId);
  } catch (error) {
    desktopMakerLogger.warn('stored session context window budget read failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
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

/** Working budgets can tighten history protection, but never raise its verified ceiling. */
export function resolveConfiguredContextWindow(
  catalog: Pick<Catalog, 'providers'>,
  agent: AgentKind,
  providerId: string | null | undefined,
  modelId: string,
  sessionBudget?: number | null,
): number | null {
  const source = resolveDesktopModelContextProviderId(catalog, agent, providerId, modelId);
  const modelLimit = source ? readModelContextLimit(agent, source, modelId) : null;
  const rows = catalog.providers
    .filter(provider => provider.id === source && provider.routing[agent]?.disabled !== true)
    .flatMap(provider => (provider.models[agent] ?? []).filter(model => model.id === modelId));
  const declaredMax = rows.length === 1
    && typeof rows[0]!.contextWindowMax === 'number'
    && Number.isFinite(rows[0]!.contextWindowMax)
    && rows[0]!.contextWindowMax > 0
    ? Math.round(rows[0]!.contextWindowMax)
    : null;
  // 任务预算是用户可写的设置，对外承诺「不越过目录声明的物理上限」：即使路由**未核实**
  // （contextWindowVerified !== true）也要夹一次 —— 未核实但声明了 max_context_window
  // 的目录形态真实存在（发现流程只拿到 max 时就是 verified=false + contextWindowMax 有值）。
  // 模型级上限刻意不夹：它同时是「路由把窗口配错时用户强行解开」的逃生口
  // （见 model-context-limit-store 头注），两者作用域不同。
  const requested = typeof sessionBudget === 'number' && Number.isFinite(sessionBudget) && sessionBudget > 0
    ? Math.round(sessionBudget) : null;
  const clampedByCatalog = requested !== null && declaredMax !== null
    ? Math.min(requested, declaredMax) : requested;
  const budget = tighterBudget(clampedByCatalog, modelLimit);
  const verified = resolveVerifiedContextWindow(catalog, agent, source, modelId, budget);
  if (verified !== null) return verified;
  // A saved budget configures the native runtime even if catalog capacity is
  // unknown. It is a working ceiling, not evidence of physical model capacity.
  return rows.length === 1 && rows[0]!.contextWindowVerified !== true && typeof budget === 'number' && Number.isFinite(budget) && budget > 0
    ? budget : null;
}
