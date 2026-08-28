import type { AgentKind } from '@cindy/maker-core';

import {
  isCredentialModeSwitchBusyError,
  isLocalSessionBusy,
  prepareLocalSessionCredentialModeSwitch,
  shouldCloseSessionForCredentialSwitch,
} from '../maker-host/codex-credential-switch.js';
import {
  CODEX_CINDY_COMPACT_PROVIDER_ID,
  CODEX_GATEWAY_PROVIDER_ID,
} from '../maker-host/codex-gateway-config.js';
import {
  setSessionEffort,
  setSessionFastMode,
} from '../maker-host/session-effort-store.js';
import { setSessionProvider } from '../maker-host/session-provider-store.js';
import {
  isCodexProviderThreadRelinkCompensationRequiredError,
  type CodexProviderThreadRelinkReceipt,
} from './codexProviderThreadRelink.js';

/**
 * PendingCredentialSwitchService —— 会话凭证形态切换的「延迟生效」登记表。
 *
 * 背景:切换模型来源本质只影响**下一次** spawn 用哪把钥匙。旧行为在会话自己
 * 跑任务时直接拒绝整个切换(CREDENTIAL_SWITCH_BUSY toast),用户的选择被丢弃
 * 且极易误以为已生效(2026-07-04 实报:06:35 切换被拒未察觉,11:07 发消息才
 * 撞出真相)。新语义:busy 时把目标 (model, providerId) 登记为 pending,当前
 * turn 结束后自动关会话,下一次发送按新来源重建 —— 切换永远"成功",只是生效
 * 时机不同。
 *
 * 生效路径(代码保证确定性,不依赖任何 LLM 行为):
 *   turn done/error(register.ts 接线)→ onTurnSettled:
 *     仍在跑(steer 接续等)→ 保留 pending,等下一个 turn 边界;
 *     已空闲 → 关闭本会话(rehydrate suppressed)→ 写 provider store → 广播。
 *   会话被其它路径关闭 → onSessionClosed:直接写 route + 广播(下一次加载
 *     hydrate 也会从 DB 读到新值,双保险)。
 *   自愈兜底:turn 可能只发 status idle、不发 done/error(stop/interrupt/SDK
 *     crash),此时上面两条事件路径都不触发,而 pending 存在期间输入队列被
 *     coordinator 的 hasPendingCredentialSwitch 门冻结 —— register 起周期定时器
 *     重试 onTurnSettled,杜绝"事件丢失 → 永久冻结"。
 *
 * 跨 Codex thread family 的 deferred 登记期间，SQLite 必须保留源 route/thread；
 * finalizer 确认 close + relink 后才由 persistRoute 一次提交目标四轴。进程若提前
 * 退出，内存 pending 虽丢失，重启也只会安全恢复源 route，不会跨来源 resume。
 */

/** 自愈兜底重试间隔(事件路径正常时用户感知不到它)。 */
const PENDING_APPLY_RETRY_DELAY_MS = 10_000;

export interface PendingCredentialSwitchOwnerScope {
  ownerScopeKey: string;
  runtimeOwnerEpoch: string;
}

export interface PendingCredentialSwitchPersistedRoute {
  model: string;
  providerId: string | null;
  effort?: string;
  fastMode?: boolean;
}

export interface PendingCredentialSwitch {
  model: string;
  providerId: string | null;
  /** relink 成功后随 route 一次提交的目标运行轴；deferred 期间 SQLite 保持旧 route。 */
  effort?: string;
  fastMode?: boolean;
  /** 跨 cindy_gateway / cindy_openai 身份边界，收口前必须换成新的 native thread。 */
  rebuildCodexThread?: boolean;
  /** relink 已提交且回滚失败时，重试只补 route persist，不能再次 fork 新 thread。 */
  codexThreadRelinkCommitted?: boolean;
  /** app-server 确认的源 thread provider 身份，路由 store 被提前覆盖时仍是事实源。 */
  sourceCodexThreadModelProviderId?: string | null;
  /** 目标会话的 agent(register 时由调用方捕获,收口前的停用重裁决用;可缺席 = 不裁决)。 */
  agentKind?: AgentKind;
  /**
   * 切换前的运行路由(register 时由调用方从 live handle / provider store 捕获)。
   * 收口重裁决发现目标全停且目录无启用兜底模型时回滚到它 —— renderer 已把停用目标
   * 预写进 DB,不回滚的话懒 resume 会经停用隐式来源重建(PR #744 review 第十六轮)。
   * 缺席 = 无从回滚,退化为只清显式来源。
   */
  previousRoute?: {
    model: string;
    providerId: string | null;
    effort?: string;
    fastMode?: boolean;
  };
  /** 登记时的 data owner + runtime epoch；跨账号/teardown 后旧 target 必须终态丢弃。 */
  ownerScope?: PendingCredentialSwitchOwnerScope;
  /** 针对登记时捕获的旧 Profile 成套恢复 thread + route；第二参数用于迟到提交 CAS。 */
  restoreStaleOwnerRoute?: (
    persistedRoute?: PendingCredentialSwitchPersistedRoute,
    expectedSdkSessionId?: string,
  ) => Promise<boolean>;
  requestedAt: number;
}

interface PendingSwitchSession {
  id: string;
  agentKind: AgentKind;
  remoteHostId?: string | null;
  isTurnRunning?: () => boolean;
}

export interface PendingCredentialSwitchDeps {
  maker: {
    listActiveSessions: () => PendingSwitchSession[];
    closeSession: (sessionId: string) => Promise<void>;
  };
  isSessionInTurn?: (sessionId: string) => boolean;
  /** 缺席仅供旧调用方/最小测试；生产必须校验 pending 登记时捕获的 owner。 */
  isOwnerScopeCurrent?: (scope: PendingCredentialSwitchOwnerScope) => boolean;
  /** 生效后广播给 renderer(清「任务结束后生效」标记 / 会话内 toast)。 */
  broadcastApplied?: (payload: {
    sessionId: string;
    model: string;
    providerId: string | null;
  }) => void;
  /** 生效后唤醒该会话的输入队列(排队消息此前被 pending 门挡住)。 */
  onApplied?: (sessionId: string) => void;
  /** clear 撞上 finalizer 时，待补偿/关闭完成后再次唤醒此前被临时门挡住的队列。 */
  onCancellationCompensated?: (sessionId: string) => void;
  /**
   * 停用轴裁决(生产 = model-route-guard-live 的 resolveLenientSessionRoute)。
   * SET_MODEL 请求时刻已裁决过,但 deferred 切换的**生效**可能在数分钟后 —— 期间
   * 目标模型 / 来源可能已被用户停用,收口前必须重裁决(PR #744 review 第七轮)。
   * 宽松降级形态:模型原样 = 只调来源;模型换了 = 目标全停、已解析出启用兜底
   * (renderer 预写进 DB 的停用模型必须连模型一起纠正,否则下一次懒 resume 经
   * 停用的隐式来源重建,第十四轮);model 缺席 = 目录全停。缺席 = 不裁决。
   */
  resolveRoute?: (
    agent: AgentKind,
    model: string,
    providerId: string | null,
    opts?: { desiredFastMode?: boolean },
  ) => Promise<{
    model?: string;
    providerId: string | null;
    degraded: boolean;
    effort?: string;
    fastMode?: boolean;
  }>;
  /**
   * 把收口裁决后的实际 route 持久化(生产 = 直写 sessions 行 + 广播
   * sessions:patched)。跨 family relink 在此首次提交目标 route；其它 deferred 可能已由
   * renderer 按请求值落盘，若收口裁决改道仍必须回写实际值。缺席 = 只写内存 store
   * (测试最小 harness)。
   */
  persistRoute?: (
    sessionId: string,
    route: {
      providerId: string | null;
      model?: string;
      effort?: string;
      fastMode?: boolean;
    },
  ) => Promise<void>;
  /**
   * 把旧 Codex rollout 安全 fork 到目标来源使用的新 thread，并 CAS 替换持久化
   * sdkSessionId。失败时 pending 保留、输入队列继续 gated，等待自愈重试。
   */
  relinkCodexThreadForProviderSwitch?: (input: {
    sessionId: string;
    sourceModel: string;
    sourceProviderId: string | null;
    sourceThreadModelProviderId?: string | null;
    targetModel: string;
    targetProviderId: string | null;
    isCurrent: () => boolean;
  }) => Promise<CodexProviderThreadRelinkReceipt | null>;
  /** 自愈兜底重试间隔覆写(测试用)。 */
  retryDelayMs?: number;
  logger?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  };
}

export class PendingCredentialSwitchService {
  private readonly pending = new Map<string, PendingCredentialSwitch>();
  /** 同一会话的 apply 串行化:turn done/error 双事件可能背靠背触发。 */
  private readonly applying = new Set<string>();
  /** 自愈兜底定时器(per session,pending 收口即清)。 */
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** owner-stale 补偿中的 target；同步 has/get 重入不得重复写旧 Profile。 */
  private readonly staleDiscards = new Set<PendingCredentialSwitch>();
  /** owner-stale Profile 补偿未完成时按 session 保持输入 gate，且不让新 owner 重跑 apply。 */
  private readonly staleCompensations = new Map<string, Set<PendingCredentialSwitch>>();
  /** owner-stale 只重试捕获的 Profile CAS；绝不重跑 close / relink / route persist。 */
  private readonly staleCompensationRetryTimers = new Map<
    PendingCredentialSwitch,
    ReturnType<typeof setTimeout>
  >();
  /** A finalizer may learn the persisted tuple after has()/get() already began stale cleanup. */
  private readonly staleCompensationContexts = new Map<
    PendingCredentialSwitch,
    {
      persistedRoute?: PendingCredentialSwitchPersistedRoute;
      expectedSdkSessionId?: string;
    }
  >();
  /** Serialize captured-Profile CAS attempts while allowing a later finalizer to upgrade context. */
  private readonly staleCompensationRunning = new Set<PendingCredentialSwitch>();
  /** clear() / owner-stale 不能在迟到 finalizer 完成 Profile 补偿前解除输入队列门。 */
  private readonly clearedDuringApply = new Set<string>();
  /** wake:false 的显式替换由新选择收尾，旧 finalizer 不得代为唤醒。 */
  private readonly suppressedCancellationWakes = new Set<string>();
  /** 新选择已完成但唤醒曾被旧 finalizer barrier 挡住，补偿结束后补发。 */
  private readonly deferredCancellationWakes = new Set<string>();
  /** SQLite 暂时失败时保持 gate，并用捕获的旧 Profile 继续补偿。 */
  private readonly compensationFailures = new Map<
    string,
    Set<PendingCredentialSwitch>
  >();
  private readonly compensationRetryTimers = new Map<
    PendingCredentialSwitch,
    ReturnType<typeof setTimeout>
  >();

  constructor(private readonly deps: PendingCredentialSwitchDeps) {}

  async register(
    sessionId: string,
    target: {
      model: string;
      providerId: string | null;
      effort?: string;
      fastMode?: boolean;
      rebuildCodexThread?: boolean;
      codexThreadRelinkCommitted?: boolean;
      sourceCodexThreadModelProviderId?: string | null;
      agentKind?: AgentKind;
      previousRoute?: {
        model: string;
        providerId: string | null;
        effort?: string;
        fastMode?: boolean;
      };
      ownerScope?: PendingCredentialSwitchOwnerScope;
      restoreStaleOwnerRoute?: (
        persistedRoute?: PendingCredentialSwitchPersistedRoute,
        expectedSdkSessionId?: string,
      ) => Promise<boolean>;
    },
  ): Promise<boolean> {
    const pending: PendingCredentialSwitch = {
      model: target.model,
      providerId: target.providerId,
      ...(target.effort !== undefined ? { effort: target.effort } : {}),
      ...(target.fastMode !== undefined ? { fastMode: target.fastMode } : {}),
      ...(target.rebuildCodexThread ? { rebuildCodexThread: true } : {}),
      ...(target.codexThreadRelinkCommitted ? { codexThreadRelinkCommitted: true } : {}),
      ...(target.sourceCodexThreadModelProviderId !== undefined
        ? { sourceCodexThreadModelProviderId: target.sourceCodexThreadModelProviderId }
        : {}),
      ...(target.agentKind ? { agentKind: target.agentKind } : {}),
      ...(target.previousRoute ? { previousRoute: target.previousRoute } : {}),
      ...(target.ownerScope ? { ownerScope: target.ownerScope } : {}),
      ...(target.restoreStaleOwnerRoute
        ? { restoreStaleOwnerRoute: target.restoreStaleOwnerRoute }
        : {}),
      requestedAt: Date.now(),
    };
    if (!this.ownerScopeCurrent(pending)) {
      const existing = this.pending.get(sessionId);
      if (existing && !this.ownerScopeCurrent(existing)) {
        this.discardIfOwnerStale(sessionId, existing);
      }
      // This target never enters the map, so discardIfOwnerStale cannot compensate it later.
      // Finish its captured old-Profile restore before the caller receives registration failure.
      const compensation = await this.compensateStaleOwnerRoute(sessionId, pending);
      if (compensation === 'retry') {
        throw new Error('Stale pending credential switch route compensation failed');
      }
      this.deps.logger?.info('stale pending credential switch discarded at registration', {
        sessionId,
      });
      return false;
    }
    this.pending.set(sessionId, pending);
    this.scheduleRetry(sessionId);
    this.deps.logger?.info('pending credential switch registered', {
      sessionId,
      model: target.model,
      providerId: target.providerId,
    });
    return true;
  }

  has(sessionId: string): boolean {
    if (this.clearedDuringApply.has(sessionId) || this.staleCompensations.has(sessionId)) {
      return true;
    }
    const target = this.pending.get(sessionId);
    if (!target) return false;
    if (!this.discardIfOwnerStale(sessionId, target)) return true;
    return this.clearedDuringApply.has(sessionId) || this.staleCompensations.has(sessionId);
  }

  get(sessionId: string): PendingCredentialSwitch | undefined {
    const target = this.pending.get(sessionId);
    if (!target || this.discardIfOwnerStale(sessionId, target)) return undefined;
    return target;
  }

  clear(sessionId: string, opts?: { wake?: boolean }): void {
    this.pending.delete(sessionId);
    this.clearRetry(sessionId);
    if (this.applying.has(sessionId)) {
      this.clearedDuringApply.add(sessionId);
      if (opts?.wake === false) this.suppressedCancellationWakes.add(sessionId);
    }
  }

  requestWakeAfterCancellationBarrier(sessionId: string): boolean {
    if (!this.clearedDuringApply.has(sessionId)) return true;
    this.deferredCancellationWakes.add(sessionId);
    return false;
  }

  /**
   * turn 结束边界回调(register.ts done/error 接线 + 自愈定时器共用)。会话仍在
   * 跑(steer 接续 / 竞态)时保留 pending 等下一个边界;空闲则关会话 + 写 route,
   * 让下一次发送按新来源重建。任何路径都不允许向外抛错(register 侧 fire-and-forget)。
   */
  async onTurnSettled(sessionId: string): Promise<void> {
    if (this.staleCompensations.has(sessionId)) return;
    const target = this.pending.get(sessionId);
    if (!target) return;
    if (this.discardIfOwnerStale(sessionId, target)) return;
    if (this.applying.has(sessionId)) return;
    const session = this.deps.maker
      .listActiveSessions()
      .find((candidate) => candidate.id === sessionId);
    if (session && isLocalSessionBusy(session, this.deps.isSessionInTurn)) return;

    this.applying.add(sessionId);
    try {
      if (session) {
        try {
          await prepareLocalSessionCredentialModeSwitch({
            maker: this.deps.maker,
            sessionId,
            isSessionInTurn: this.deps.isSessionInTurn,
          });
        } catch (err) {
          if (isCredentialModeSwitchBusyError(err)) {
            // turn done 与新 turn start 竞态:保留 pending,等下一个边界。
            return;
          }
          // A rejected close leaves the live Session state unknown. Keep the pending gate and
          // retry from the close boundary; relinking or persisting a target route here could
          // pair the still-live source thread with the target provider/model.
          this.deps.logger?.error?.(
            'pending credential switch: close session failed; keeping queue gated for retry',
            {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            },
          );
          const latest = this.pending.get(sessionId);
          if (latest && !this.discardIfOwnerStale(sessionId, latest)) {
            this.scheduleRetry(sessionId);
          }
          return;
        }
      }
      // await close 期间用户可能又 register(改选)或 clear(取消):以**当前**登记为准
      // 收口,不能用进入函数时捕获的 stale target 覆盖后选(后选覆盖先选)。
      const latest = this.pending.get(sessionId);
      if (!latest) return;
      if (this.discardIfOwnerStale(sessionId, latest)) return;
      await this.finalizeApplyChecked(sessionId, latest, 'turn end');
    } finally {
      this.finishApplying(sessionId);
    }
  }

  /**
   * 会话被其它路径关闭(stop 后手动关 / 升级重建等)。会话已不在,直接写 route
   * 并收口 pending;下一次加载 hydrate 从 DB 读到的也是新值(renderer 已落盘)。
   *
   * onTurnSettled 的 apply 自己 closeSession 也会触发本钩子 —— applying 守卫
   * 让完成权归 turn-settled 路径,避免双写 route / 双广播(renderer 双 toast)。
   */
  onSessionClosed(sessionId: string): void {
    if (this.staleCompensations.has(sessionId)) return;
    if (this.applying.has(sessionId)) return;
    const target = this.pending.get(sessionId);
    if (!target) return;
    if (this.discardIfOwnerStale(sessionId, target)) return;
    this.applying.add(sessionId);
    void this.finalizeApplyChecked(sessionId, target, 'session close').finally(() => {
      this.finishApplying(sessionId);
    });
  }

  /**
   * 收口前的停用重裁决(PR #744 review 第七轮起):SET_MODEL 时刻裁决过,但 deferred
   * 生效可能在数分钟后,期间目标可能被停用。走宽松降级(resolveRoute):
   *   - 模型原样 ⇒ 只按裁决调整来源(pass 原样 / reroute 替代 / 丢弃停用显式来源);
   *   - 模型换了 ⇒ 目标全部拷贝被停用、已解析出启用兜底模型 —— 连模型一起落地
   *     (renderer 预写进 DB 的停用模型必须纠正,否则下一次懒 resume 经停用的隐式
   *     来源重建,第十四轮);
   *   - model 缺席 ⇒ 目录里一个启用对话模型都没有,只清显式来源(最小错状态)。
   * 裁决异常按「不写 route」保守处理(第八轮);agentKind 缺席时只做「原样通过 /
   * 清空来源」二choice,绝不采纳按别的 agent 解析出的来源或模型(第十二、十三轮)。
   */
  private async resolveApplyRoute(
    target: PendingCredentialSwitch,
  ): Promise<{
    providerId: string | null;
    model?: string;
    effort?: string;
    fastMode?: boolean;
    apply: boolean;
  }> {
    const { resolveRoute } = this.deps;
    const targetAxes = {
      ...(target.effort !== undefined ? { effort: target.effort } : {}),
      ...(target.fastMode !== undefined ? { fastMode: target.fastMode } : {}),
    };
    if (!resolveRoute) return { providerId: target.providerId, ...targetAxes, apply: true };
    try {
      if (!target.agentKind) {
        for (const agent of ['claude-code', 'codex', 'pi'] as AgentKind[]) {
          const resolved = await resolveRoute(agent, target.model, target.providerId);
          if (
            resolved.model !== target.model ||
            resolved.providerId !== target.providerId ||
            resolved.degraded
          ) {
            return { providerId: null, ...targetAxes, apply: true };
          }
        }
        return { providerId: target.providerId, ...targetAxes, apply: true };
      }
      // desiredFastMode = 会话当前 fast(previousRoute 捕获;renderer 在 set-model 时
      // 不动 fast,DB 现值即它):目标全停换兜底模型时按落地拷贝 reconcile,不支持
      // Fast 的兜底不再带着 fast 标志被上游拒(PR #744 review 第十九轮)。
      const resolved = await resolveRoute(target.agentKind, target.model, target.providerId, {
        desiredFastMode: target.previousRoute?.fastMode === true,
      });
      if (!resolved.model) {
        // 目标全停且目录里没有任何启用兜底模型:回滚到切换前的运行路由(register 时
        // 捕获)—— renderer 已把停用目标预写进 DB,只清来源仍会让懒 resume 用停用
        // 模型经隐式来源重建(PR #744 review 第十六轮)。切换前路由属于「本来就在
        // 跑」的豁免域,是此刻唯一有依据的安全落点;无 previousRoute 才退化为只清
        // 显式来源。
        if (target.previousRoute) {
          const prev = target.previousRoute;
          // 回滚成套:renderer 已把目标 model/effort/fast 落盘,只回滚 model 会让
          // 旧模型配上目标档位(如 max effort / Fast)被上游拒(第十八轮)。模型
          // 未变(只换来源被拒)时 effort/fast 本就没动,不带。
          return {
            providerId: prev.providerId,
            ...(prev.model !== target.model
              ? {
                  model: prev.model,
                  ...(prev.effort !== undefined ? { effort: prev.effort } : {}),
                  ...(prev.fastMode !== undefined ? { fastMode: prev.fastMode } : {}),
                }
              : {}),
            apply: true,
          };
        }
        return { providerId: null, apply: true };
      }
      if (resolved.model !== target.model) {
        return {
          providerId: resolved.providerId,
          model: resolved.model,
          ...(resolved.effort ? { effort: resolved.effort } : {}),
          ...(resolved.fastMode !== undefined ? { fastMode: resolved.fastMode } : {}),
          apply: true,
        };
      }
      return { providerId: resolved.providerId, ...targetAxes, apply: true };
    } catch (err) {
      // 复核异常按「不写 route」保守处理:目标可能恰在等待期间被停用,异常放行会把
      // 停用来源写回会话(PR #744 review 第八轮)。生产 resolveRoute
      // (resolveLenientSessionRoute)自带目录故障降级、不抛,此分支纯防御 ——
      // 保守方向零日常代价;登记照常收口,模型选择本身已由 renderer 落盘,不丢失。
      this.deps.logger?.warn('pending credential switch revalidation failed; route not applied', {
        model: target.model,
        providerId: target.providerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { providerId: target.providerId, apply: false };
    }
  }

  /** 重裁决 + 身份守卫后收口:await 期间用户改选/取消 ⇒ 本次让位(新登记有自己的定时器)。 */
  private async finalizeApplyChecked(
    sessionId: string,
    target: PendingCredentialSwitch,
    reason: string,
  ): Promise<void> {
    // 无裁决依赖:同步快路径(onSessionClosed 的调用方不 await,收口必须在同一
    // tick 完成才能保住既有「关闭即生效」时序)。注入了 resolveRoute 就必审 ——
    // agentKind 缺席不构成绕过(resolveApplyRoute 内对双 agent 保守裁决)。
    if (!this.deps.resolveRoute) {
      await this.finalizeApply(
        sessionId,
        target,
        {
          providerId: target.providerId,
          ...(target.effort !== undefined ? { effort: target.effort } : {}),
          ...(target.fastMode !== undefined ? { fastMode: target.fastMode } : {}),
          apply: true,
        },
        reason,
      );
      return;
    }
    const resolved = await this.resolveApplyRoute(target);
    if (!this.targetCurrent(sessionId, target)) {
      this.discardIfOwnerStale(sessionId, target);
      return;
    }
    await this.finalizeApply(sessionId, target, resolved, reason);
  }

  /**
   * 收口一条 pending:删登记、清兜底定时器、写 route,然后**先**唤醒队列再广播。
   * 唤醒是正确性关键(排队消息被 pending 门挡着,漏掉 = 队列冻结);广播只是 UI
   * 提示,单独 try/catch,坏窗口等异常不允许连带吞掉唤醒或向上抛(register 侧
   * fire-and-forget,抛出去就是 unhandled rejection)。
   */
  private async finalizeApply(
    sessionId: string,
    target: PendingCredentialSwitch,
    resolved: {
      providerId: string | null;
      model?: string;
      effort?: string;
      fastMode?: boolean;
      apply: boolean;
    },
    reason: string,
  ): Promise<void> {
    let relinkReceipt: CodexProviderThreadRelinkReceipt | null = null;
    if (resolved.apply) {
      // 等待期间停用裁决可能把最终 provider/model 改到另一 thread 身份家族。
      // source thread 身份完整时必须按最终 route 重算，不能沿用登记时冻结的 marker；
      // 身份不完整时保留旧 marker 的 fail-closed 兼容语义。
      const shouldRelinkCodexThread =
        target.codexThreadRelinkCommitted !== true &&
        (target.agentKind === 'codex' &&
          target.previousRoute &&
          target.sourceCodexThreadModelProviderId !== undefined
          ? shouldCloseSessionForCredentialSwitch({
              agentKind: 'codex',
              remoteHostId: null,
              currentProviderId: target.previousRoute.providerId,
              nextProviderId: resolved.providerId,
              currentModel: target.previousRoute.model,
              nextModel: resolved.model ?? target.model,
              currentCodexProxyActive: true,
              currentCodexThreadModelProviderId: target.sourceCodexThreadModelProviderId,
              currentCodexCindyRemoteCompactionCompatible:
                target.sourceCodexThreadModelProviderId === CODEX_GATEWAY_PROVIDER_ID
                  ? false
                  : target.sourceCodexThreadModelProviderId === CODEX_CINDY_COMPACT_PROVIDER_ID
                    ? true
                    : undefined,
            })
          : target.rebuildCodexThread === true);
      if (shouldRelinkCodexThread) {
        const relink = this.deps.relinkCodexThreadForProviderSwitch;
        if (!relink) {
          this.deps.logger?.error?.(
            'pending credential switch: Codex thread relink dependency is unavailable; keeping queue gated',
            { sessionId, model: resolved.model ?? target.model, providerId: resolved.providerId },
          );
          if (this.targetCurrent(sessionId, target)) this.scheduleRetry(sessionId);
          else this.discardIfOwnerStale(sessionId, target);
          return;
        }
        try {
          relinkReceipt = await relink({
            sessionId,
            sourceModel: target.previousRoute?.model ?? target.model,
            sourceProviderId: target.previousRoute?.providerId ?? target.providerId,
            ...(target.sourceCodexThreadModelProviderId !== undefined
              ? {
                  sourceThreadModelProviderId: target.sourceCodexThreadModelProviderId,
                }
              : {}),
            targetModel: resolved.model ?? target.model,
            targetProviderId: resolved.providerId,
            isCurrent: () => this.targetCurrent(sessionId, target),
          });
        } catch (err) {
          this.deps.logger?.error?.(
            'pending credential switch: Codex thread relink failed; keeping queue gated for retry',
            {
              sessionId,
              model: resolved.model ?? target.model,
              providerId: resolved.providerId,
              error: err instanceof Error ? err.message : String(err),
            },
          );
          if (isCodexProviderThreadRelinkCompensationRequiredError(err)) {
            const receipt = err.receipt;
            if (!this.ownerScopeCurrent(target)) {
              this.discardIfOwnerStale(
                sessionId,
                target,
                undefined,
                receipt.newSdkSessionId,
              );
            } else {
              await this.compensateSupersededPersistedRoute(
                sessionId,
                target,
                undefined,
                receipt,
              );
              if (this.targetCurrent(sessionId, target)) this.scheduleRetry(sessionId);
            }
          } else if (this.targetCurrent(sessionId, target)) {
            this.scheduleRetry(sessionId);
          } else {
            this.discardIfOwnerStale(sessionId, target);
          }
          return;
        }
        if (!this.targetCurrent(sessionId, target)) {
          let rollbackRestored = relinkReceipt === null;
          if (relinkReceipt) {
            try {
              rollbackRestored = await relinkReceipt.rollback();
            } catch (rollbackError) {
              this.deps.logger?.error?.(
                'pending credential switch: superseded Codex relink rollback failed',
                {
                  sessionId,
                  error:
                    rollbackError instanceof Error
                      ? rollbackError.message
                      : String(rollbackError),
                },
              );
            }
          }
          if (!rollbackRestored && relinkReceipt) {
            if (!this.ownerScopeCurrent(target)) {
              this.discardIfOwnerStale(
                sessionId,
                target,
                undefined,
                relinkReceipt.newSdkSessionId,
              );
            } else {
              await this.compensateSupersededPersistedRoute(
                sessionId,
                target,
                undefined,
                relinkReceipt,
              );
            }
          } else {
            this.discardIfOwnerStale(sessionId, target);
          }
          return;
        }
      }
      setSessionProvider(sessionId, resolved.providerId);
      // 跨 family deferred 在登记时刻刻意让 DB 保持源 route；只有 relink 成功后才
      // 在这里提交目标 route。裁决改道也必须回写，否则下次懒 resume 会按旧值重建。
      // 回写必须 **await 且先于**删登记 /
      // 唤醒队列:排队消息在唤醒后立刻按 DB 懒 resume,fire-and-forget 会让它抢在
      // 替换模型落库前用停用目标重建(PR #744 review 第十五轮);await 期间 pending
      // 仍在,coordinator 的 pending 门保持关闭。失败留痕后仍收口(队列不能永久
      // 冻结;内存 store 已是权威路由,DB 差异在下次显式切换收敛)。
      const modelChanged = !!resolved.model && resolved.model !== target.model;
      const routeChanged = resolved.providerId !== target.providerId || modelChanged;
      const resolvedRoute: PendingCredentialSwitchPersistedRoute = {
        providerId: resolved.providerId,
        model: resolved.model ?? target.model,
        ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}),
        ...(resolved.fastMode !== undefined ? { fastMode: resolved.fastMode } : {}),
      };
      // Only a successful await proves this exact fallback tuple reached SQLite. If the owner
      // expires in that window, stale cleanup must compare against it rather than the request.
      let persistedResolvedRoute: PendingCredentialSwitchPersistedRoute | undefined;
      // 恒写幂等回正(最后收口者赢,PR #744 review 第二十三轮):旧登记的 finalizer 在
      // await persistRoute 期间被新选择替换时,旧写可能晚于新选择的登记/落盘;
      // 若新登记收口时因「裁决未改路由」跳过回写,DB 会留着旧 finalizer 的迟到值,
      // 下次懒 resume 用错路由。收口时恒写 (providerId, model) —— 正常路径是对
      // 已写值的幂等重写,零语义差;不做 per-session 写锁(产品口径:先可用,
      // 低概率竞态由幂等回写收敛,见 model-route-guard.ts 头注)。
      // 仅在裁决接线存在时恒写:该竞态面来自 resolveRoute/persist 的 await 窗口,
      // 无接线的同步快路径(onSessionClosed 不 await,「关闭即生效」须同 tick 完成)
      // 既无竞态也不能引入异步,保持只在路由改动时回写。
      if (
        this.deps.persistRoute &&
        (routeChanged ||
          this.deps.resolveRoute ||
          shouldRelinkCodexThread ||
          target.codexThreadRelinkCommitted === true)
      ) {
        try {
          await this.deps.persistRoute(sessionId, resolvedRoute);
          persistedResolvedRoute = resolvedRoute;
        } catch (err) {
          let relinkRollbackError: unknown;
          let relinkRestored = relinkReceipt === null;
          if (relinkReceipt) {
            try {
              const restored = await relinkReceipt.rollback();
              if (!restored) {
                throw new Error('Codex thread relink rollback was superseded');
              }
              relinkRestored = true;
            } catch (rollbackError) {
              relinkRollbackError = rollbackError;
              // The replacement thread still owns sdk_session_id. Avoid forking it again on
              // retry; the pending gate remains closed until route persistence succeeds.
              target.rebuildCodexThread = false;
              target.codexThreadRelinkCommitted = true;
            }
          }
          // fail-closed(PR #744 review 第十六轮):DB 里躺着 renderer 预写的停用
          // 目标,回写失败就唤醒队列 = 排队消息立刻按停用路由懒 resume。保留登记
          // (pending 门继续挡住派发)+ 自愈定时器重试整个收口(重新裁决 + 回写);
          // 用户改选 / 取消随时接管。error 级留痕 —— 这是会冻结该会话队列的状态。
          this.deps.logger?.error?.(
            'pending credential switch: persist resolved route failed; keeping queue gated for retry',
            {
            sessionId,
            providerId: resolved.providerId,
            model: resolved.model,
            error: err instanceof Error ? err.message : String(err),
              ...(relinkRollbackError
                ? {
                    relinkRollbackError:
                      relinkRollbackError instanceof Error
                        ? relinkRollbackError.message
                        : String(relinkRollbackError),
                  }
                : {}),
            },
          );
          if (this.targetCurrent(sessionId, target)) {
            this.scheduleRetry(sessionId);
          } else if (this.ownerScopeCurrent(target)) {
            // persistRoute did not prove that any target tuple reached SQLite. A same-owner
            // cancellation may nevertheless have deleted pending after setSessionProvider()
            // switched the in-memory route. Only release its cancellation barrier after the
            // thread is back on the source and all captured runtime axes are restored.
            if (relinkRestored) {
              this.restoreCancelledRuntimeRoute(sessionId, target);
            } else {
              // The failed persist may have written nothing or may have committed before a
              // later hook rejected. The captured Profile callback accepts either the resolved
              // tuple or previousRoute and retries fail-closed until thread + route are safe.
              await this.compensateSupersededPersistedRoute(
                sessionId,
                target,
                resolvedRoute,
                relinkReceipt,
              );
            }
          } else {
            this.discardIfOwnerStale(sessionId, target);
          }
          return;
        }
        // await 期间用户可能改选 / 取消:本次让位,新登记有自己的收口路径。
        // 同 owner 的迟到写必须把实际 route + replacement thread 作为一个 CAS
        // 成套补偿；先单独回滚 thread 会留下可被唤醒队列/重启观察到的裂分状态。
        if (!this.targetCurrent(sessionId, target)) {
          if (!this.ownerScopeCurrent(target)) {
            // The captured old-Profile callback restores sdk_session_id and the complete source
            // route in one CAS. Never call receipt.rollback() first: a crash between that write
            // and route compensation would persist target provider/model with the source thread.
            this.discardIfOwnerStale(
              sessionId,
              target,
              persistedResolvedRoute,
              relinkReceipt?.newSdkSessionId,
            );
          } else {
            await this.compensateSupersededPersistedRoute(
              sessionId,
              target,
              persistedResolvedRoute,
              relinkReceipt,
            );
          }
          return;
        }
      }
      this.deps.logger?.info(`pending credential switch applied on ${reason}`, {
        sessionId,
        model: resolved.model ?? target.model,
        providerId: resolved.providerId,
      });
    } else {
      // 复核异常(唯一的 apply=false 情形)同 persist 失败一样 fail-closed:此刻
      // DB 里躺着 renderer 预写的目标路由,它可能恰在等待期间被停用 —— 收口唤醒
      // 会让排队消息按未经复核的路由懒 resume(PR #744 review 第二十轮)。保留
      // 登记(pending 门继续挡派发)+ 自愈定时器重试整个收口;生产 resolveRoute
      // 自带降级不抛,此分支纯防御,fail-closed 零日常代价。
      this.deps.logger?.error?.(
        'pending credential switch revalidation failed; keeping queue gated for retry',
        {
        sessionId,
        model: target.model,
        providerId: target.providerId,
        },
      );
      if (this.targetCurrent(sessionId, target)) this.scheduleRetry(sessionId);
      else this.discardIfOwnerStale(sessionId, target);
      return;
    }
    // 删登记(解除 coordinator 的 pending 门)必须在 route 写入 + DB 回写之后。
    this.pending.delete(sessionId);
    this.clearRetry(sessionId);
    this.requestWakeAfterCancellationBarrier(sessionId);
    try {
      this.deps.onApplied?.(sessionId);
    } catch (err) {
      this.deps.logger?.warn('pending credential switch: onApplied hook failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      this.deps.broadcastApplied?.({
        sessionId,
        model: resolved.model ?? target.model,
        providerId: resolved.providerId,
      });
    } catch (err) {
      this.deps.logger?.warn('pending credential switch: applied broadcast failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private scheduleRetry(sessionId: string): void {
    this.clearRetry(sessionId);
    const target = this.pending.get(sessionId);
    if (!target || this.discardIfOwnerStale(sessionId, target)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(sessionId);
      const current = this.pending.get(sessionId);
      if (!current || this.discardIfOwnerStale(sessionId, current)) return;
      void this.onTurnSettled(sessionId).finally(() => {
        // 仍未收口(还在跑 / busy 竞态)→ 继续兜底。收口路径已 clearRetry。
        if (this.has(sessionId) && !this.retryTimers.has(sessionId)) {
          this.scheduleRetry(sessionId);
        }
      });
    }, this.deps.retryDelayMs ?? PENDING_APPLY_RETRY_DELAY_MS);
    this.retryTimers.set(sessionId, timer);
  }

  private clearRetry(sessionId: string): void {
    const timer = this.retryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(sessionId);
  }

  private finishApplying(sessionId: string): void {
    this.applying.delete(sessionId);
    this.maybeReleaseCancellationBarrier(sessionId);
  }

  private hasCompensationFailures(sessionId: string): boolean {
    return (this.compensationFailures.get(sessionId)?.size ?? 0) > 0;
  }

  private maybeReleaseCancellationBarrier(sessionId: string): void {
    if (
      this.applying.has(sessionId) ||
      this.staleCompensations.has(sessionId) ||
      this.hasCompensationFailures(sessionId)
    ) {
      return;
    }
    this.releaseClearedDuringApply(sessionId);
  }

  private releaseClearedDuringApply(sessionId: string): void {
    if (!this.clearedDuringApply.delete(sessionId)) return;
    const wakeSuppressed = this.suppressedCancellationWakes.delete(sessionId);
    const deferredWake = this.deferredCancellationWakes.delete(sessionId);
    // clearPendingCredentialSwitchForSession() may already have tried to wake the queue, but
    // has() kept it gated until the late finalizer finished compensating the captured Profile.
    // A replacement target remains gated by pending.has(); a pure cancellation may now drain.
    if (wakeSuppressed && !deferredWake) return;
    try {
      this.deps.onCancellationCompensated?.(sessionId);
    } catch (err) {
      this.deps.logger?.warn('pending credential switch: compensated cancellation wake failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private ownerScopeCurrent(target: PendingCredentialSwitch): boolean {
    return !target.ownerScope || !this.deps.isOwnerScopeCurrent
      ? true
      : this.deps.isOwnerScopeCurrent(target.ownerScope);
  }

  private targetCurrent(sessionId: string, target: PendingCredentialSwitch): boolean {
    return this.pending.get(sessionId) === target && this.ownerScopeCurrent(target);
  }

  private async compensateStaleOwnerRoute(
    sessionId: string,
    target: PendingCredentialSwitch,
    persistedRoute?: PendingCredentialSwitchPersistedRoute,
    expectedSdkSessionId?: string,
  ): Promise<'safe' | 'retry'> {
    try {
      if (target.restoreStaleOwnerRoute) {
        const restored = await target.restoreStaleOwnerRoute(
          persistedRoute,
          expectedSdkSessionId,
        );
        if (!restored) {
          this.deps.logger?.warn(
            'stale pending credential switch route compensation was superseded',
            { sessionId },
          );
          return 'safe';
        }
      }
      return 'safe';
    } catch (error) {
      this.deps.logger?.error?.('stale pending credential switch route compensation failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'retry';
    }
  }

  private async retryStaleOwnerCompensation(
    sessionId: string,
    target: PendingCredentialSwitch,
  ): Promise<void> {
    if (this.staleCompensationRunning.has(target)) return;
    this.staleCompensationRunning.add(target);
    const context = this.staleCompensationContexts.get(target);
    const compensation = await this.compensateStaleOwnerRoute(
      sessionId,
      target,
      context?.persistedRoute,
      context?.expectedSdkSessionId,
    );
    this.staleCompensationRunning.delete(target);
    // persistRoute may have completed while an earlier no-context cleanup was awaiting SQLite.
    // Ignore that obsolete result and immediately retry with the exact tuple + replacement id.
    if (this.staleCompensationContexts.get(target) !== context) {
      this.requestStaleOwnerCompensation(sessionId, target);
      return;
    }
    if (compensation === 'retry') {
      this.scheduleStaleOwnerCompensationRetry(sessionId, target);
      return;
    }
    this.completeStaleOwnerCompensation(sessionId, target);
  }

  private scheduleStaleOwnerCompensationRetry(
    sessionId: string,
    target: PendingCredentialSwitch,
  ): void {
    if (this.staleCompensationRetryTimers.has(target)) return;
    const timer = setTimeout(() => {
      this.staleCompensationRetryTimers.delete(target);
      this.requestStaleOwnerCompensation(sessionId, target);
    }, this.deps.retryDelayMs ?? PENDING_APPLY_RETRY_DELAY_MS);
    this.staleCompensationRetryTimers.set(target, timer);
  }

  private requestStaleOwnerCompensation(
    sessionId: string,
    target: PendingCredentialSwitch,
  ): void {
    const timer = this.staleCompensationRetryTimers.get(target);
    if (timer) clearTimeout(timer);
    this.staleCompensationRetryTimers.delete(target);
    if (this.staleCompensationRunning.has(target)) return;
    void this.retryStaleOwnerCompensation(sessionId, target);
  }

  private completeStaleOwnerCompensation(
    sessionId: string,
    target: PendingCredentialSwitch,
  ): void {
    const timer = this.staleCompensationRetryTimers.get(target);
    if (timer) clearTimeout(timer);
    this.staleCompensationRetryTimers.delete(target);
    this.staleCompensationContexts.delete(target);
    this.staleCompensationRunning.delete(target);
    this.staleDiscards.delete(target);
    const targets = this.staleCompensations.get(sessionId);
    targets?.delete(target);
    if (targets?.size === 0) this.staleCompensations.delete(sessionId);
    if (this.pending.get(sessionId) === target) {
      this.pending.delete(sessionId);
    }
    this.deps.logger?.info('stale pending credential switch discarded after owner boundary', {
      sessionId,
    });
    this.maybeReleaseCancellationBarrier(sessionId);
  }

  /**
   * persistRoute() may finish after this generation was cancelled or replaced while the data
   * owner is still valid. Owner-stale cleanup intentionally ignores that case, so compensate
   * the exact tuple and replacement thread this finalizer wrote in one captured-Profile CAS.
   * A newer route/thread therefore wins without being overwritten.
   */
  private async compensateSupersededPersistedRoute(
    sessionId: string,
    target: PendingCredentialSwitch,
    persistedRoute: PendingCredentialSwitchPersistedRoute | undefined,
    relinkReceipt: CodexProviderThreadRelinkReceipt | null,
  ): Promise<void> {
    const safe = await this.tryCompensateSupersededPersistedRoute(
      sessionId,
      target,
      persistedRoute,
      relinkReceipt,
    );
    if (safe) {
      this.completeSupersededCompensation(sessionId, target);
      return;
    }
    const failures = this.compensationFailures.get(sessionId) ?? new Set();
    failures.add(target);
    this.compensationFailures.set(sessionId, failures);
    this.scheduleCompensationRetry(sessionId, target, persistedRoute, relinkReceipt);
  }

  private async tryCompensateSupersededPersistedRoute(
    sessionId: string,
    target: PendingCredentialSwitch,
    persistedRoute: PendingCredentialSwitchPersistedRoute | undefined,
    relinkReceipt: CodexProviderThreadRelinkReceipt | null,
  ): Promise<boolean> {
    try {
      const restored = target.restoreStaleOwnerRoute
        ? await target.restoreStaleOwnerRoute(persistedRoute, relinkReceipt?.newSdkSessionId)
        : relinkReceipt
          ? await relinkReceipt.rollback()
          : false;
      if (!restored) {
        this.deps.logger?.warn(
          'superseded pending credential switch route compensation was superseded',
          { sessionId },
        );
        return true;
      }
      // A pure cancellation has no newer runtime selection to preserve. Re-align the provider
      // store only after the captured Profile CAS succeeded; replacement targets own their store.
      this.restoreCancelledRuntimeRoute(sessionId, target);
      return true;
    } catch (error) {
      this.deps.logger?.error?.('superseded pending credential switch route compensation failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private restoreCancelledRuntimeRoute(
    sessionId: string,
    target: PendingCredentialSwitch,
  ): void {
    if (this.pending.has(sessionId) || !target.previousRoute) return;
    // The finalizer already closed the old live Session before relink/persist. The next lazy
    // creation reads model + sdk_session_id from the unchanged/restored SQLite source tuple;
    // these three owner-scoped stores are the remaining runtime axes that must match it.
    setSessionProvider(sessionId, target.previousRoute.providerId);
    setSessionEffort(sessionId, target.previousRoute.effort);
    if (target.previousRoute.fastMode !== undefined) {
      setSessionFastMode(sessionId, target.previousRoute.fastMode);
    }
  }

  private scheduleCompensationRetry(
    sessionId: string,
    target: PendingCredentialSwitch,
    persistedRoute: PendingCredentialSwitchPersistedRoute | undefined,
    relinkReceipt: CodexProviderThreadRelinkReceipt | null,
  ): void {
    if (this.compensationRetryTimers.has(target)) return;
    const timer = setTimeout(() => {
      this.compensationRetryTimers.delete(target);
      void this.tryCompensateSupersededPersistedRoute(
        sessionId,
        target,
        persistedRoute,
        relinkReceipt,
      ).then((safe) => {
        if (!safe) {
          this.scheduleCompensationRetry(sessionId, target, persistedRoute, relinkReceipt);
          return;
        }
        this.completeSupersededCompensation(sessionId, target);
      });
    }, this.deps.retryDelayMs ?? PENDING_APPLY_RETRY_DELAY_MS);
    this.compensationRetryTimers.set(target, timer);
  }

  private completeSupersededCompensation(
    sessionId: string,
    target: PendingCredentialSwitch,
  ): void {
    const timer = this.compensationRetryTimers.get(target);
    if (timer) clearTimeout(timer);
    this.compensationRetryTimers.delete(target);
    const failures = this.compensationFailures.get(sessionId);
    failures?.delete(target);
    if (failures?.size === 0) this.compensationFailures.delete(sessionId);
    this.maybeReleaseCancellationBarrier(sessionId);
  }

  private discardIfOwnerStale(
    sessionId: string,
    target: PendingCredentialSwitch,
    persistedRoute?: PendingCredentialSwitchPersistedRoute,
    expectedSdkSessionId?: string,
  ): boolean {
    if (this.ownerScopeCurrent(target)) return false;
    const existingContext = this.staleCompensationContexts.get(target);
    const nextContext = {
      ...(persistedRoute !== undefined
        ? { persistedRoute }
        : existingContext?.persistedRoute !== undefined
          ? { persistedRoute: existingContext.persistedRoute }
          : {}),
      ...(expectedSdkSessionId !== undefined
        ? { expectedSdkSessionId }
        : existingContext?.expectedSdkSessionId !== undefined
          ? { expectedSdkSessionId: existingContext.expectedSdkSessionId }
          : {}),
    };
    const contextChanged =
      !existingContext ||
      nextContext.persistedRoute !== existingContext.persistedRoute ||
      nextContext.expectedSdkSessionId !== existingContext.expectedSdkSessionId;
    if (contextChanged) this.staleCompensationContexts.set(target, nextContext);
    if (!this.staleDiscards.has(target)) {
      // Stop normal apply retries immediately, but keep a compensation barrier until the exact
      // old Profile CAS succeeds (or proves a newer selection won). A new owner may register the
      // same session id meanwhile; target identity keeps the old cleanup from deleting it.
      if (this.pending.get(sessionId) === target) this.clearRetry(sessionId);
      this.staleDiscards.add(target);
      const targets = this.staleCompensations.get(sessionId) ?? new Set();
      targets.add(target);
      this.staleCompensations.set(sessionId, targets);
      // Reuse the cancellation barrier lifecycle so finishApplying cannot release the queue
      // while SQLite is temporarily unavailable; successful compensation performs one wake.
      this.clearedDuringApply.add(sessionId);
      this.requestStaleOwnerCompensation(sessionId, target);
    } else if (contextChanged) {
      // A post-persist finalizer upgrades an earlier has()/get()-triggered cleanup with the
      // replacement sdk id; wake the retry loop now instead of keeping the obsolete closure.
      this.requestStaleOwnerCompensation(sessionId, target);
    }
    return true;
  }
}
