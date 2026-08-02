import type { AgentKind } from '@cindy/maker-core';

import {
  isCredentialModeSwitchBusyError,
  isLocalSessionBusy,
  prepareLocalSessionCredentialModeSwitch,
} from '../maker-host/codex-credential-switch.js';
import { setSessionProvider } from '../maker-host/session-provider-store.js';

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
 * DB 持久化不在本模块:renderer 在 set-model 返回 deferred 后照常
 * sessionService.update 落盘 sessions.{model,provider_id},重启后 hydrate 生效。
 */

/** 自愈兜底重试间隔(事件路径正常时用户感知不到它)。 */
const PENDING_APPLY_RETRY_DELAY_MS = 10_000;

export interface PendingCredentialSwitch {
  model: string;
  providerId: string | null;
  /** 目标会话的 agent(register 时由调用方捕获,收口前的停用重裁决用;可缺席 = 不裁决)。 */
  agentKind?: AgentKind;
  /**
   * 切换前的运行路由(register 时由调用方从 live handle / provider store 捕获)。
   * 收口重裁决发现目标全停且目录无启用兜底模型时回滚到它 —— renderer 已把停用目标
   * 预写进 DB,不回滚的话懒 resume 会经停用隐式来源重建(PR #744 review 第十六轮)。
   * 缺席 = 无从回滚,退化为只清显式来源。
   */
  previousRoute?: { model: string; providerId: string | null; effort?: string; fastMode?: boolean };
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
  /** 生效后广播给 renderer(清「任务结束后生效」标记 / 会话内 toast)。 */
  broadcastApplied?: (payload: {
    sessionId: string;
    model: string;
    providerId: string | null;
  }) => void;
  /** 生效后唤醒该会话的输入队列(排队消息此前被 pending 门挡住)。 */
  onApplied?: (sessionId: string) => void;
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
   * sessions:patched)。renderer 在 deferred 被接受那一刻已按**请求值**落盘 DB;
   * 收口裁决改道 / 丢弃被停用的显式来源 / 全停换模型时必须回写实际值 —— 否则下
   * 一次懒 resume 按 DB 里的停用路由重建(resume 免裁决,PR #744 review 第十、
   * 十四轮)。缺席 = 只写内存 store(测试最小 harness)。
   */
  persistRoute?: (
    sessionId: string,
    route: { providerId: string | null; model?: string; effort?: string; fastMode?: boolean },
  ) => Promise<void>;
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

  constructor(private readonly deps: PendingCredentialSwitchDeps) {}

  register(
    sessionId: string,
    target: {
      model: string;
      providerId: string | null;
      agentKind?: AgentKind;
      previousRoute?: { model: string; providerId: string | null; effort?: string; fastMode?: boolean };
    },
  ): void {
    this.pending.set(sessionId, {
      model: target.model,
      providerId: target.providerId,
      ...(target.agentKind ? { agentKind: target.agentKind } : {}),
      ...(target.previousRoute ? { previousRoute: target.previousRoute } : {}),
      requestedAt: Date.now(),
    });
    this.scheduleRetry(sessionId);
    this.deps.logger?.info('pending credential switch registered', {
      sessionId,
      model: target.model,
      providerId: target.providerId,
    });
  }

  has(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  get(sessionId: string): PendingCredentialSwitch | undefined {
    return this.pending.get(sessionId);
  }

  clear(sessionId: string): void {
    this.pending.delete(sessionId);
    this.clearRetry(sessionId);
  }

  /**
   * turn 结束边界回调(register.ts done/error 接线 + 自愈定时器共用)。会话仍在
   * 跑(steer 接续 / 竞态)时保留 pending 等下一个边界;空闲则关会话 + 写 route,
   * 让下一次发送按新来源重建。任何路径都不允许向外抛错(register 侧 fire-and-forget)。
   */
  async onTurnSettled(sessionId: string): Promise<void> {
    const target = this.pending.get(sessionId);
    if (!target) return;
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
          // 关闭失败也要落 route:下一次发送的 getHost 仲裁仍会按新来源协调,
          // 不能让用户的选择因一次 close 失败而静默蒸发。
          this.deps.logger?.warn('pending credential switch: close session failed; applying route anyway', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // await close 期间用户可能又 register(改选)或 clear(取消):以**当前**登记为准
      // 收口,不能用进入函数时捕获的 stale target 覆盖后选(后选覆盖先选)。
      const latest = this.pending.get(sessionId);
      if (!latest) return;
      await this.finalizeApplyChecked(sessionId, latest, 'turn end');
    } finally {
      this.applying.delete(sessionId);
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
    if (this.applying.has(sessionId)) return;
    const target = this.pending.get(sessionId);
    if (!target) return;
    this.applying.add(sessionId);
    void this.finalizeApplyChecked(sessionId, target, 'session close').finally(() => {
      this.applying.delete(sessionId);
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
  ): Promise<{ providerId: string | null; model?: string; effort?: string; fastMode?: boolean; apply: boolean }> {
    const { resolveRoute } = this.deps;
    if (!resolveRoute) return { providerId: target.providerId, apply: true };
    try {
      if (!target.agentKind) {
        for (const agent of ['claude-code', 'codex', 'pi'] as AgentKind[]) {
          const resolved = await resolveRoute(agent, target.model, target.providerId);
          if (
            resolved.model !== target.model ||
            resolved.providerId !== target.providerId ||
            resolved.degraded
          ) {
            return { providerId: null, apply: true };
          }
        }
        return { providerId: target.providerId, apply: true };
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
                  ...(prev.effort ? { effort: prev.effort } : {}),
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
      return { providerId: resolved.providerId, apply: true };
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
        { providerId: target.providerId, apply: true },
        reason,
      );
      return;
    }
    const resolved = await this.resolveApplyRoute(target);
    if (this.pending.get(sessionId) !== target) return;
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
    resolved: { providerId: string | null; model?: string; effort?: string; fastMode?: boolean; apply: boolean },
    reason: string,
  ): Promise<void> {
    if (resolved.apply) {
      setSessionProvider(sessionId, resolved.providerId);
      // 裁决改了落地路由(reroute / 丢弃停用显式来源 / 全停换模型或清空):回写 DB
      // —— renderer 在 deferred 接受时已按请求值落盘 sessions 行,不纠正的话下一次
      // 懒 resume 按停用路由重建(resume 免裁决)。回写必须 **await 且先于**删登记 /
      // 唤醒队列:排队消息在唤醒后立刻按 DB 懒 resume,fire-and-forget 会让它抢在
      // 替换模型落库前用停用目标重建(PR #744 review 第十五轮);await 期间 pending
      // 仍在,coordinator 的 pending 门保持关闭。失败留痕后仍收口(队列不能永久
      // 冻结;内存 store 已是权威路由,DB 差异在下次显式切换收敛)。
      const modelChanged = !!resolved.model && resolved.model !== target.model;
      const routeChanged = resolved.providerId !== target.providerId || modelChanged;
      // 恒写幂等回正(最后收口者赢,PR #744 review 第二十三轮):旧登记的 finalizer 在
      // await persistRoute 期间被新选择替换时,旧写可能晚于 renderer 为新选择落的盘;
      // 若新登记收口时因「裁决未改路由」跳过回写,DB 会留着旧 finalizer 的迟到值,
      // 下次懒 resume 用错路由。收口时恒写 (providerId, model) —— 正常路径是对
      // renderer 已写值的幂等重写,零语义差;不做 per-session 写锁(产品口径:先可用,
      // 低概率竞态由幂等回写收敛,见 model-route-guard.ts 头注)。
      // 仅在裁决接线存在时恒写:该竞态面来自 resolveRoute/persist 的 await 窗口,
      // 无接线的同步快路径(onSessionClosed 不 await,「关闭即生效」须同 tick 完成)
      // 既无竞态也不能引入异步,保持只在路由改动时回写。
      if (this.deps.persistRoute && (routeChanged || this.deps.resolveRoute)) {
        try {
          await this.deps.persistRoute(sessionId, {
            providerId: resolved.providerId,
            model: resolved.model ?? target.model,
            ...(modelChanged
              ? {
                  ...(resolved.effort ? { effort: resolved.effort } : {}),
                  ...(resolved.fastMode !== undefined ? { fastMode: resolved.fastMode } : {}),
                }
              : {}),
          });
        } catch (err) {
          // fail-closed(PR #744 review 第十六轮):DB 里躺着 renderer 预写的停用
          // 目标,回写失败就唤醒队列 = 排队消息立刻按停用路由懒 resume。保留登记
          // (pending 门继续挡住派发)+ 自愈定时器重试整个收口(重新裁决 + 回写);
          // 用户改选 / 取消随时接管。error 级留痕 —— 这是会冻结该会话队列的状态。
          this.deps.logger?.error?.('pending credential switch: persist resolved route failed; keeping queue gated for retry', {
            sessionId,
            providerId: resolved.providerId,
            model: resolved.model,
            error: err instanceof Error ? err.message : String(err),
          });
          if (this.pending.get(sessionId) === target) this.scheduleRetry(sessionId);
          return;
        }
        // await 期间用户可能改选 / 取消:本次让位,新登记有自己的收口路径。
        if (this.pending.get(sessionId) !== target) return;
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
      this.deps.logger?.error?.('pending credential switch revalidation failed; keeping queue gated for retry', {
        sessionId,
        model: target.model,
        providerId: target.providerId,
      });
      if (this.pending.get(sessionId) === target) this.scheduleRetry(sessionId);
      return;
    }
    // 删登记(解除 coordinator 的 pending 门)必须在 route 写入 + DB 回写之后。
    this.pending.delete(sessionId);
    this.clearRetry(sessionId);
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
    const timer = setTimeout(() => {
      this.retryTimers.delete(sessionId);
      if (!this.pending.has(sessionId)) return;
      void this.onTurnSettled(sessionId).finally(() => {
        // 仍未收口(还在跑 / busy 竞态)→ 继续兜底。收口路径已 clearRetry。
        if (this.pending.has(sessionId) && !this.retryTimers.has(sessionId)) {
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
}
