/**
 * The context window budget reconcile of the desktop's maker IPC (register.ts): the reconcile under the
 * task's send lock, the runtime hook a saved budget calls (sessionContextWindowBudgetApplier, which
 * takes that lock itself), and the replay at a send boundary. Moved verbatim out of register.ts so the
 * Node Host applies a budget the same way; register.ts binds the ports and takes the applier and the
 * replay from here.
 *
 * Ports: the Maker (null until it is ready), the stored budget reader and the effective-window check
 * (the budget core, sessionContextBudgetCore.ts), the pending credential switch reader and register,
 * the runtime mutation dependencies of applyRuntimeSetModelChange, and the logger. The two tables are
 * the shared state module's (sessionContextWindowBudgetState.ts).
 */
import { eq } from 'drizzle-orm';
import type { Maker } from '@cindy/maker-core';
import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import type { createSessionContextBudget } from '../maker-host/sessionContextBudgetCore.js';
import type { Logger } from '../logger.js';
import { applyRuntimeSetModelChange } from './runtimeSetModel.js';
import { withSendToSessionLock } from './sendToSessionLock.js';
import { appliedContextWindowBudgets, pendingSessionContextWindowBudgetReconciles } from './sessionContextWindowBudgetState.js';

type SessionContextBudget = ReturnType<typeof createSessionContextBudget>;
type PendingCredentialSwitchTarget = { model: string; providerId: string | null; forceSessionRebuild?: boolean; selectionSource?: 'agent' };

export interface SessionContextWindowBudgetReconcilePorts {
  getMakerIfReady: () => Pick<Maker, 'getSession'> | null;
  readStoredSessionContextWindowBudget: SessionContextBudget['readStoredSessionContextWindowBudget'];
  contextWindowBudgetChangesEffectiveWindow: SessionContextBudget['contextWindowBudgetChangesEffectiveWindow'];
  getPendingCredentialSwitchTarget: (sessionId: string) => PendingCredentialSwitchTarget | undefined;
  registerPendingCredentialSwitchForSession: (sessionId: string, target: PendingCredentialSwitchTarget) => Promise<void>;
  runtimeMutationDeps: () => Omit<Parameters<typeof applyRuntimeSetModelChange>[0], 'sessionId' | 'model' | 'providerId' | 'forceSessionRebuild'>;
  log: Pick<Logger, 'debug' | 'info'>;
}

/** register.ts's budget reconcile, applier and replay, as register.ts defined them. */
export function createSessionContextWindowBudgetReconcile(ports: SessionContextWindowBudgetReconcilePorts) {
  const {
    getMakerIfReady, readStoredSessionContextWindowBudget, contextWindowBudgetChangesEffectiveWindow,
    getPendingCredentialSwitchTarget, registerPendingCredentialSwitchForSession, runtimeMutationDeps, log,
  } = ports;
  let sessionContextWindowBudgetApplier:
    | ((sessionId: string, change: { previous: number | null; next: number | null }) => Promise<void>)
    | null = null;

  /**
   * 预算对账（**锁内**，调用方已持 send 锁）：把偏好文件里的当前预算落到活实例。
   *
   * 两条调用路径共用：
   * - 偏好变更通知（回合中登记 pending、空闲直接重建）；
   * - 发送边界重放 —— 回合中登记的重建意图可能被随后的「重选当前模型」清掉
   *   （SET_MODEL 成功路径会 `agentSwitchPending.clear`），而预算通知只来一次，
   *   光靠通知就再也没有第二次机会，活实例会永久停在旧窗口（Greptile P1，2026-10-24）。
   */
  const reconcileSessionContextWindowBudgetUnderLock = async (
    sessionId: string,
    previous: number | null,
  ): Promise<void> => {
    const live = getMakerIfReady()?.getSession(sessionId);
    if (!live) {
      // 实例已关：下次启动会按偏好文件注入预算，没有需要重放的意图了。
      appliedContextWindowBudgets.delete(sessionId);
      pendingSessionContextWindowBudgetReconciles.delete(sessionId);
      return;
    }
    // 已应用（偏好文件里的当前值 == 记账值）→ 立即返回：发送边界每次都会调这里，
    // 正常路径必须只有一次内存/文件比较，不能为此多查一次会话行。
    const latestBudget = await readStoredSessionContextWindowBudget(sessionId);
    if (appliedContextWindowBudgets.has(sessionId)
      && appliedContextWindowBudgets.get(sessionId) === latestBudget) {
      pendingSessionContextWindowBudgetReconciles.delete(sessionId);
      log.debug('session context window budget already applied', {
        sessionId, budget: latestBudget,
      });
      return;
    }
    // 会话行（路由快照）必须在**锁内**重读：锁外读到的是「加锁前」的路由，若期间用户切了模，
    // 有效窗口判定会按旧路由算成「没变」而漏掉一次必需的重建（第 1 轮的洞在这条窄路径的复发）。
    const [row] = await getDbClient()
      .drizzle.select({
        agentKind: sessions.agentKind,
        model: sessions.model,
        providerId: sessions.providerId,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row?.model) return;
    const agent = dbToMakerAgentKind(row.agentKind);
    const providerId = getSessionProvider(sessionId) ?? row.providerId;
    const catalog = getActiveCatalog();
    // 并发改档位（双窗口、连点）时两条通知会乱序到达：`latestBudget` 取的是**当下偏好文件
    // 里的值**（上面已读），让 live 与落库终值对齐（否则后执行的旧通知会把活实例重建回旧窗口）。
    // 有效窗口（预算与模型级上限取更紧者）没变就不重建：避免每次改档位都关活实例。
    if (!contextWindowBudgetChangesEffectiveWindow({
      catalog, agent, providerId, modelId: row.model,
      previous, next: latestBudget,
    })) {
      // **不能**在这里清重放意图：`previous` 只是「上一个保存值」，不是活实例当前的窗口。
      // 例：实例 300K、模型级上限 500K，回合中先存 500K 再存 600K —— 第二次比较的两个保存
      // 值都收敛到 500K，判为「没变」，但实例仍是 300K；此刻清掉意图，随后重选模型取消
      // pending，预算就永久不生效（Greptile P1，2026-10-24）。
      // 意图只在三种终态清除：真正 applied、记账值等于偏好值（已应用）、实例已关。
      log.debug('session context window budget does not change the effective window', {
        sessionId, previous, next: latestBudget,
      });
      return;
    }
    // 待定选择是**更晚的意图**，而 pending 是整体替换：读-改-写必须在同一把锁里，
    // 否则会在 await 窗口把用户期间新选的模型/引擎冲掉（SET_MODEL 持锁登记，我们必须在锁内对齐）。
    const pendingTarget = getPendingCredentialSwitchTarget(sessionId);
    if (pendingTarget) {
      // 已登记的凭证 pending（目标模型就是用户选的 B）：**原样保留其 model/provider**，
      // 只补 forceSessionRebuild；跨引擎意图在另一套 store，不在这里动。
      // 绝不能以「当前 live 路由」重登记 —— 那会把用户的模型选择冲掉且不报错。
      // 这里**不**记 dedup：真正的重建发生在收口时，pending 被取消/超车的话什么都没做，
      // 记了就会把后续同值通知全部挡掉，活实例永久停在旧窗口。
      await registerPendingCredentialSwitchForSession(sessionId, {
        ...pendingTarget,
        forceSessionRebuild: true,
      });
      // 意图必须一起登记：那条 pending 随时可能被「重选当前模型」清掉（SET_MODEL 成功
      // 路径 agentSwitchPending.clear），清掉之后没人再应用预算（Greptile P1，2026-10-24）。
      pendingSessionContextWindowBudgetReconciles.add(sessionId);
      log.info('session context window budget merged into the pending route switch', {
        sessionId, previous,
        next: latestBudget, targetModel: pendingTarget.model,
      });
      return;
    }
    // 无凭证 pending 时（含仅轴 pending / runtime-control 显式路由 pending / 跨引擎切换）：
    // 以**当前 live 路由**补一个 forceSessionRebuild。取舍说明：这几套意图各自存在别的 store，
    // 这里不会覆盖它们，但确实会多登记一条「当前引擎」的凭证 pending —— 它与跨引擎意图在同一个
    // 收口边界先后生效，最坏是多一次关会话/重建（写入的路由就等于 live 路由，不会复活旧路由）；
    // 换来的是「跨引擎切换被取消时预算仍会生效」这个更强保证（第 3 轮 review 的反向要求）。
    // 少登记一条会反过来丢掉那个保证，所以这里选择保留登记。
    const result = await applyRuntimeSetModelChange({
      ...runtimeMutationDeps(),
      sessionId,
      model: live.model,
      providerId: getSessionProvider(sessionId),
      forceSessionRebuild: true,
    });
    // **只有真正落到活实例**才算已应用：回合中这条路返回 `deferred`（只登记了
    // pending），此时记 dedup 会让后续同值对账全部被挡掉；一旦那条 pending 被
    // 随后的「重选当前模型」清掉，预算就永久不生效（Greptile P1，2026-10-24）。
    // 不记的话发送边界的对账会一直重试，直到新实例确实采用预算。
    if (result.status === 'applied') {
      appliedContextWindowBudgets.set(sessionId, latestBudget);
      pendingSessionContextWindowBudgetReconciles.delete(sessionId);
      log.info('session context window budget applied via runtime rebuild', {
        sessionId, previous, next: latestBudget,
      });
      return;
    }
    // 只登记意图、不记 dedup：发送边界会重试，直到新实例确实采用预算。
    pendingSessionContextWindowBudgetReconciles.add(sessionId);
    log.info('session context window budget rebuild deferred to the send boundary', {
      sessionId, previous, next: latestBudget,
    });
  };
  sessionContextWindowBudgetApplier = async (sessionId, change) => {
    const activeMaker = getMakerIfReady();
    if (!activeMaker || !activeMaker.getSession(sessionId)) return;
    await withSendToSessionLock(sessionId, () => (
      reconcileSessionContextWindowBudgetUnderLock(sessionId, change.previous)
    ));
  };
  /**
   * 预算重放（**锁内**，调用方持 send 锁）：只在有未完成意图时跑一次对账。
   *
   * 两条发送边界共用：直发（IM / Goal / 定时任务）与**桌面 UI 发送事务**
   * （createMakerSendTransaction 的 applyPendingAgentSwitch）。只做直发那一处的话，
   * 回合中改预算、随后在模型选择器里点选而清掉 pending 的用户——也就是最普通的那条
   * 操作路径——永远等不到预算生效（GLM-5.3 独立审查，2026-10-24）。
   */
  const replayPendingSessionContextWindowBudgetUnderLock = async (
    sessionId: string,
    before?: () => void,
  ): Promise<void> => {
    if (!pendingSessionContextWindowBudgetReconciles.has(sessionId)) return;
    before?.();
    await reconcileSessionContextWindowBudgetUnderLock(
      sessionId, appliedContextWindowBudgets.get(sessionId) ?? null,
    );
  };

  return { sessionContextWindowBudgetApplier: sessionContextWindowBudgetApplier!, replayPendingSessionContextWindowBudgetUnderLock };
}
