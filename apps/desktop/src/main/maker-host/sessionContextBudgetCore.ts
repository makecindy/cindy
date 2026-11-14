/**
 * The session working-context budget, shared by the desktop and the Node Host.
 *
 * Electron-free. The context-provider resolver, the stored-budget reader and
 * the logger are ports; model-context-settings.ts binds the desktop ones and
 * keeps its exported functions, so the desktop behaves exactly as before.
 * Bodies moved verbatim from model-context-settings.ts.
 */

import type { AgentKind, Catalog } from '@cindy/model-providers';

import { normalizeContextWindowBudget } from '../../shared/sessionContextWindowBudget.js';
import { resolveVerifiedContextWindow } from './catalog-to-descriptors.js';
import { readModelContextLimit } from './model-context-limit-store.js';
import type { ModelContextProviderResolver } from './routeModelEfforts.js';

export interface SessionContextBudgetOpts {
  contextWindowBudget?: number | null;
  agentKind: AgentKind;
  providerId?: string | null;
  model?: string | null;
}

export interface SessionContextBudgetPorts {
  resolveContextProviderId: ModelContextProviderResolver;
  readSessionContextWindowBudget(sessionId: string): number | null;
  logger: { warn(message: string, fields?: Record<string, unknown>): void };
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

export function createSessionContextBudget(ports: SessionContextBudgetPorts) {
  /** 该任务已保存的**原始**预算值（tokens）；null = 未自定义。切模/校验需要按目标路由重新收敛时用它。 */
  async function readStoredSessionContextWindowBudget(sessionId: string): Promise<number | null> {
    try {
      return ports.readSessionContextWindowBudget(sessionId);
    } catch (error) {
      ports.logger.warn('stored session context window budget read failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 把「本任务的工作上下文预算」写进会话创建参数（`opts.contextWindowBudget`）。
   *
   * 口径唯一：调用方（远程 / IM / 定时任务）显式带值时同样按目录物理上限与模型级上限
   * 重新收敛；未带则读本任务已保存的档位。按「未自定义」处理时不留下该字段，引擎回退
   * 到模型级上限 / 目录默认（旧行为零变化）；收敛不出值时**删掉**字段而不是透传未收敛的
   * 数字（引擎侧按「已收敛」信任，部分引擎甚至不做 >0 校验）。
   *
   * 为什么抽出来：会话启动有多个入口（createSession 的 prepareStartOptions 钩子、worker
   * 唤醒时的 resumeOrcaWorkerSessionIfMissing、goal 恢复…）。曾经只有钩子那一条注入预算，
   * worker 唤醒路径自己拼 opts 且不带预算 —— 预算就在「引擎进程重启」时静默丢失：档位卡仍
   * 显示 50%（宿主投影照算），而 Pi 的压缩阈值退回满窗（compaction.reserveTokens 写成无预算
   * 值），于是任务在预算窗口内跑到 100% 以上也不自动压缩（实测 reserveTokens=50000 ⇒
   * 阈值 950K，而预算窗口只有 500K）。每条入口都必须过这里，口径不许分叉。
   */
  async function applySessionContextWindowBudgetToCreateOpts(
    sessionId: string,
    opts: {
      contextWindowBudget?: number | null;
      agentKind: AgentKind;
      providerId?: string | null;
      model?: string | null;
    },
    catalog: Pick<Catalog, 'providers'>,
  ): Promise<void> {
    const explicitBudget = normalizeContextWindowBudget(opts.contextWindowBudget);
    const requestedBudget = explicitBudget ?? await readStoredSessionContextWindowBudget(sessionId);
    if (requestedBudget === null) {
      delete opts.contextWindowBudget;
      return;
    }
    // 未定型路由（无 model）时不做收敛：宁可不带预算（引擎回退默认），也不把
    // 未收敛的值透传给引擎。
    if (typeof opts.model !== 'string' || opts.model.length === 0) {
      delete opts.contextWindowBudget;
      return;
    }
    const resolvedBudget = resolveConfiguredContextWindow(
      catalog, opts.agentKind, opts.providerId ?? null, opts.model, requestedBudget,
    );
    if (resolvedBudget !== null) opts.contextWindowBudget = resolvedBudget;
    else delete opts.contextWindowBudget;
  }

  /** Working budgets can tighten history protection, but never raise its verified ceiling. */
  function resolveConfiguredContextWindow(
    catalog: Pick<Catalog, 'providers'>,
    agent: AgentKind,
    providerId: string | null | undefined,
    modelId: string,
    sessionBudget?: number | null,
  ): number | null {
    const source = ports.resolveContextProviderId(catalog, agent, providerId, modelId);
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

  return { readStoredSessionContextWindowBudget, applySessionContextWindowBudgetToCreateOpts, resolveConfiguredContextWindow };
}
