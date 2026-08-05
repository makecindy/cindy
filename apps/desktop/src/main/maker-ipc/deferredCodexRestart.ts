import { isCredentialModeSwitchBusyError } from '../maker-host/codex-credential-switch.js';

/**
 * DeferredCodexRestartService —— 全局 Codex 软重启的「延迟兑现」登记。
 *
 * 背景:Memory 设置是 Codex shared app-server 的 spawn-time 状态,改动后要靠一次
 * 软重启让**存活**的本地 Codex 会话换到新状态。旧行为在任何本地 Codex 会话跑
 * turn 时直接拒绝整个设置变更(CREDENTIAL_SWITCH_BUSY 裸 toast),与
 * PendingCredentialSwitchService 已确立的「切换永远成功,只是生效时机不同」语义
 * 相悖(2026-07-04 拍板)。新语义:设置立即落盘、manager 状态立即翻转(新会话
 * 立刻按新值注入),存活会话的 native 热推 + 软重启登记到这里,在所有本地 Codex
 * 会话空闲后自动补做。
 *
 * 兑现路径(与 PendingCredentialSwitchService 同款结构):
 *   turn done/error / 会话关闭(register.ts 接线)→ onSessionSettled:
 *     仍有本地 Codex 会话在 turn 内 → 静默保留 pending,等下一个边界;
 *     全部空闲 → 先执行登记的 applyRuntime(native setMemory 热推,此刻无
 *     in-flight turn 可打扰),再 restartCodexAfterAuthModeChange(关会话 +
 *     dispose host,下一次发送按新设置重建),最后 onApplied 唤醒被 pending 门
 *     挡住的输入队列。
 *   排队门:pending 期间本地 Codex live 会话的输入队列被 coordinator 的
 *     hasPendingCredentialSwitch 谓词(register.ts 扩展)挡住 —— 否则排队消息
 *     会在旧 host 上接续开新 turn,重启被无限顺延(review P1 2026-07-23)。
 *     未 spawn 的会话不挡:fresh spawn 本来就读新设置。
 *   自愈兜底:stop/interrupt 可能只发 status idle 不发 done/error,事件路径
 *   不触发 —— 周期定时器重试,杜绝「事件丢失 → 永不生效」。
 *
 * 全局单件(不 per-session):重启动作本身就是全 host 级的,多次 schedule 合并
 * 为一次兑现(applyRuntime 取最后一次登记,last-write-wins 与设置语义一致)。
 * 数据 owner 边界(登出 / 切账号)时 bootstrap 调 clear() 丢弃 pending —— 旧
 * owner 的设置变更不得触发新 owner 的会话重启(review P1 2026-07-23)。
 */

/** 自愈兜底重试间隔(事件路径正常时用户感知不到它)。 */
const DEFERRED_RESTART_RETRY_DELAY_MS = 10_000;

export interface DeferredCodexRestartDeps {
  /** 实际执行软重启(maker-host restartCodexAfterAuthModeChange)。busy 时抛 CredentialModeSwitchBusyError。 */
  restart: () => Promise<void>;
  /**
   * 兑现前置探测:仍有本地 Codex 会话在 turn 内时跳过本轮,避免注定失败的
   * close 尝试刷 warn 日志。探测与真正兑现之间存在竞态窗口 —— restart 内部的
   * busy fail-closed 是正确性兜底,这里只是降噪。
   */
  hasBusyLocalCodexSession: () => boolean;
  /**
   * 兑现前采集当前本地 Codex live 会话 id —— restart 会把它们全部关闭,收口后
   * 通过 onApplied 逐个唤醒(它们的输入队列此前被 pending 门挡着,漏唤 = 冻结)。
   */
  listLocalCodexSessionIds: () => string[];
  /** 兑现成功后回调:唤醒被 pending 门挡住的会话输入队列。 */
  onApplied?: (sessionIds: string[]) => void;
  /** 自愈兜底重试间隔覆写(测试用)。 */
  retryDelayMs?: number;
  logger?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
}

export class DeferredCodexRestartService {
  private pending = false;
  /** 兑现时机才执行的 runtime 变更(native setMemory 热推);最后一次登记生效。 */
  private pendingApplyRuntime: (() => Promise<void>) | null = null;
  /** 兑现串行化:turn done/error 双事件可能背靠背触发。 */
  private applying = false;
  /**
   * 失效代:clear()(owner 边界 / 立即路径收口)时自增。已进入 tryApply 的
   * in-flight 兑现在每个 await 之后、副作用之前核对 —— clear 前捕获的闭包不得
   * 在 clear 后继续 restart/唤醒(否则旧 owner 的登记会关掉新 owner 的会话,
   * review P1 2026-07-23)。
   */
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: DeferredCodexRestartDeps) {}

  isPending(): boolean {
    return this.pending;
  }

  /**
   * 登记一次延迟重启;已有 pending 时合并(重启是全局动作,一次兑现覆盖所有
   * 登记),applyRuntime 覆盖为最新(设置本身 last-write-wins)。
   */
  schedule(reason: string, applyRuntime?: () => Promise<void>): void {
    const alreadyPending = this.pending;
    this.pending = true;
    this.pendingApplyRuntime = applyRuntime ?? null;
    if (!alreadyPending) {
      this.scheduleRetry();
    }
    this.deps.logger?.info('deferred codex restart scheduled', { reason, merged: alreadyPending });
  }

  /**
   * turn 结束边界 / 会话关闭回调(register.ts 接线 + 自愈定时器共用)。
   * 任何路径都不允许向外抛错(register 侧 fire-and-forget)。
   */
  onSessionSettled(): void {
    if (!this.pending) return;
    void this.tryApply();
  }

  /**
   * 新本地 Codex 会话加入 shared host **之前**的兑现尝试(maker-host
   * lifecycleHooks.onBeforeStart 接线)。此刻其它会话若已全部空闲,先兑现再放行,
   * 新会话直接在新状态的 fresh host 上起跑;仍有会话 busy 则立即放行不阻塞
   * (残余窗口:该新会话在旧 native 状态的 host 上运行,直至兑现后被关闭重建,
   * 见模块注释)。串行化冲突(别的边界正在兑现)同样放行,不让会话创建卡等。
   */
  async flushBeforeLocalCodexSessionStart(): Promise<void> {
    if (!this.pending) return;
    await this.tryApply();
  }

  /**
   * 丢弃 pending 并失效 in-flight 兑现(数据 owner 边界 / 立即路径已覆盖登记 /
   * 测试收尾)。不执行任何登记中的变更。
   */
  clear(): void {
    this.generation += 1;
    this.clearRetry();
    this.pending = false;
    this.pendingApplyRuntime = null;
  }

  /**
   * 当前被 pending 门挡住派发的本地 Codex live 会话名单。立即路径覆盖 pending
   * 登记时,调用方在 prepare 关会话**前**采集,clear 后逐个补唤醒 —— 门谓词变
   * false 不会自己触发 drain,漏唤 = 队列停到下一次无关唤醒(review P1
   * 2026-07-23)。无 pending 时为空;facade 边界窗口抛错按空处理。
   */
  listGatedSessionIds(): string[] {
    if (!this.pending) return [];
    try {
      return this.deps.listLocalCodexSessionIds();
    } catch {
      return [];
    }
  }

  private async tryApply(): Promise<void> {
    if (!this.pending || this.applying) return;
    const gen = this.generation;
    this.applying = true;
    try {
      // deps 走 dynamic Maker facade,owner 边界期间会抛 —— 整段兜住,
      // 靠兜底定时器(或边界时的 clear())收口,不产生 unhandled rejection。
      if (this.deps.hasBusyLocalCodexSession()) return;
      // claim-before-await 循环:await 期间新 schedule 覆盖登记时,下一轮取到
      // 最新闭包接着应用(last-write-wins),旧闭包收口不会误清新登记(review
      // P1 2026-07-23)。
      for (;;) {
        const applyRuntime = this.pendingApplyRuntime;
        if (!applyRuntime) break;
        this.pendingApplyRuntime = null;
        try {
          await applyRuntime();
        } catch (err) {
          // runtime 热推失败不阻塞重启:agent 级 memoryOverride 已在 setMemory
          // 内先行落位,restart 后新 host ensure 时会补推,重启本身是最终收敛。
          this.deps.logger?.warn('deferred memory runtime apply failed; proceeding with restart', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (gen !== this.generation) return;
      }
      const sessionIds = this.deps.listLocalCodexSessionIds();
      await this.deps.restart();
      if (gen !== this.generation) {
        // clear 与 restart 的 await 竞态:restart 副作用已发生(TOCTOU 无法避免,
        // owner 边界窗口内 facade 会抛、真正跨 owner 的 restart 到不了这里),
        // 但状态收口与唤醒都属于旧代,不再执行。
        return;
      }
      if (this.pendingApplyRuntime) {
        // restart await 期间又有新登记:重启已带最新 persist 值,但新登记的
        // runtime 尚未应用 —— 本轮不收口(pending 保持,兜底定时器仍在),
        // 下一边界把新 runtime 应用后再重启一次收口。
        return;
      }
      this.pending = false;
      this.clearRetry();
      this.deps.logger?.info('deferred codex restart applied', {
        wokenSessions: sessionIds.length,
      });
      try {
        this.deps.onApplied?.(sessionIds);
      } catch (err) {
        this.deps.logger?.warn('deferred codex restart: onApplied hook failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      // busy:settle 与新 turn start 的竞态,静默保留 pending 等下一个边界。
      // 其它失败(close/dispose 异常 / owner 边界窗口):同样保留 pending 交给
      // 兜底重试 —— 设置已落盘,存活会话不能因一次重启失败而永远停在旧状态。
      if (!isCredentialModeSwitchBusyError(err)) {
        this.deps.logger?.warn('deferred codex restart failed; will retry', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.applying = false;
    }
  }

  private scheduleRetry(): void {
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.pending) return;
      void this.tryApply().finally(() => {
        // 仍未收口(还在跑 / busy 竞态)→ 继续兜底。成功路径已 clearRetry。
        if (this.pending && !this.retryTimer) {
          this.scheduleRetry();
        }
      });
    }, this.deps.retryDelayMs ?? DEFERRED_RESTART_RETRY_DELAY_MS);
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

export interface MemoryChangeParts<T extends object> {
  /**
   * 立即执行的部分:settings 落盘 + manager 状态翻转(不含 native 热推)。
   * 无论重启是否延迟,新会话 / 新 spawn 都要立刻读到新值。
   */
  persist: () => Promise<T>;
  /**
   * 会打到 live Codex host 的 runtime 变更(native setMemory RPC 热推)。
   * 立即路径在 persist 后原地执行;延迟路径挪到所有会话空闲、重启前执行 ——
   * 不能 mid-turn 热更正在跑的任务(review P1 2026-07-23)。
   */
  applyRuntime: () => Promise<void>;
}

export interface MemoryChangeWithCodexRestartDeps {
  /**
   * maker-host prepareCodexForAuthModeChange:busy fail-closed + 持 credential
   * guard。register.ts 侧负责把非 busy 失败包装成结构化 IPC error 再抛
   * (busy 异常必须原样透传,本执行体靠它分流延迟路径)。
   */
  prepare: () => Promise<void>;
  /** maker-host finalizeCodexAfterAuthModeChange:dispose host + 释放 guard。 */
  finalize: () => Promise<void>;
  /** maker-host cancelCodexAuthModeChange:change 失败时释放 guard。 */
  cancel: () => void;
  /** prepare 抛明确 busy 时登记延迟重启(applyRuntime 在兑现时执行)。 */
  scheduleDeferredRestart: (reason: string, applyRuntime: () => Promise<void>) => void;
  /**
   * 立即路径成功后丢弃仍然挂着的旧延迟登记:本次变更已带最新设置完成重启,
   * 旧登记完全被覆盖 —— 不清的话兜底重试会拿旧 MemorySettings 的 applyRuntime
   * 把 memoryOverride 打回旧值(review P1 2026-07-23)。
   */
  clearDeferredRestart: () => void;
  logger?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
}

/**
 * Memory 设置变更的统一执行体:能立即软重启就重启,Codex busy 就把重启延迟兑现。
 *
 * 收口矩阵:
 *  - prepare 成功 → persist → applyRuntime → finalize(finalize 失败仅 warn:
 *    设置已提交,下一次 Codex spawn 仍读新值,不能让 main/renderer 各持一个值);
 *  - prepare 抛**明确的 busy**(本地 Codex 会话在 turn 内)→ persist 照常提交 +
 *    scheduleDeferredRestart(applyRuntime 延迟到兑现时),返回
 *    codexRestartDeferred: true 供 UI 提示「任务结束后对运行中会话生效」;
 *  - prepare 其它失败(并发凭证切换在飞 / 空闲会话 close 异常)→ 原样上抛,
 *    设置不提交 —— 延迟降级只适用于「确定会自然解除」的 busy,把真实故障也
 *    包装成延迟成功会让用户误以为已生效(review P1 2026-07-23);
 *  - persist / applyRuntime 自身失败 → 原样上抛(cancel 释放 guard)。
 */
export async function runMemoryChangeWithCodexRestart<T extends object>(
  deps: MemoryChangeWithCodexRestartDeps,
  parts: MemoryChangeParts<T>,
): Promise<T & { codexRestartDeferred: boolean }> {
  let prepared = false;
  try {
    await deps.prepare();
    prepared = true;
  } catch (err) {
    if (!isCredentialModeSwitchBusyError(err)) {
      throw err;
    }
    deps.logger?.info('codex busy during memory change; deferring live-session restart', {
      error: err.message,
    });
  }
  if (!prepared) {
    const result = await parts.persist();
    deps.scheduleDeferredRestart('memory-change', parts.applyRuntime);
    return { ...result, codexRestartDeferred: true };
  }
  let changed = false;
  try {
    const result = await parts.persist();
    await parts.applyRuntime();
    changed = true;
    // 本次立即变更已带最新设置走完 persist + runtime,任何仍挂着的旧延迟登记
    // 都被覆盖 —— 即使下方 finalize 失败也要清(设置已提交,旧 applyRuntime
    // 不能再回放)。
    deps.clearDeferredRestart();
    try {
      await deps.finalize();
    } catch (err) {
      deps.logger?.warn('codex restart failed after memory setting change', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { ...result, codexRestartDeferred: false };
  } finally {
    if (!changed) {
      deps.cancel();
    }
  }
}
