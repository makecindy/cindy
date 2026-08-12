/**
 * 中断自愈的**每会话簿记**：被压住的错误详情、待确认的重连记录、退避排期。
 *
 * 从 register.ts 抽出来的唯一理由是**可测**。这三份状态各自都简单，但它们的生命周期彼此
 * 咬合，而错法只有一种表现：历史里少一条错误卡、或多一条假的「已重新连接」—— 都不会
 * 抛异常、typecheck 与既有单测全绿。它原先长在 register 的巨型 wiring 里（那个模块拉
 * electron / DB / 全套 IPC，起不了单测），于是同一族问题被 review 连着抓出四轮：
 * 悬空结算、定时器不撤、句柄被覆盖而不取消、暂存被覆盖或丢弃而不补落。搬出来 + 锁住
 * 不变量之后，这类回归由测试兜住，不再靠人逐行读。
 *
 * **不变量（与 PR 说明的 I2 / I5 / I6 对应）**
 *  - 被压住的错误详情**必有人补落**：覆盖前补落、会话终止前补落、放弃时补落。丢弃即
 *    等于那次中断在历史里彻底消失。
 *  - 待确认记录（`pendingOutcome`）**必有一次结算**：不结算会被之后任何一个无关事件
 *    误标成 `succeeded`（历史里一条假的「已重新连接」）。
 *  - 排期**必可撤销**：每次排期带令牌，回调只认自己那次；撤销分两种语义（会话终止要
 *    回滚守卫额度，新排期顶替旧排期不能回滚——那份额度属于新那次）。
 *
 * 本模块**只做簿记**，不做判定、不碰额度上限（那些在 interruptedTurnAutoResume.ts），
 * 副作用全部经注入的 deps，因此可以在没有 electron / DB 的环境里整体驱动。
 */

export type AutoResumeOutcome = 'succeeded' | 'failed';

/** 被压住的那条 terminal error 的可落库详情（已 redact，与 error 行的 content 同形）。 */
export interface SuppressedTurnError {
  message?: string;
  reason?: string;
  sdkError?: string;
}

/** Exact coordinator owner for a deferred terminal error. */
export interface SuppressedTurnErrorOwner {
  generation: number;
  clientId: string;
}

interface SuppressedTurnErrorEntry {
  detail: SuppressedTurnError;
  /** Runtime owner of this suppressed error; null is bound by beginAttempt for deferred paths. */
  attemptToken: number | null;
  /** Deferred terminal-error owner; null for already-decided auto-resume paths. */
  deferredOwner: SuppressedTurnErrorOwner | null;
  /** The retry queue item that will replace the failed turn. */
  retryOwnerClientId: string | null;
  /**
   * Agent Island tail ownership and vendor dispatch are separate boundaries:
   * preview can fail while dispatch still proceeds (for example Island is
   * disabled), and a rejected dispatch rolls both boundaries back.
   */
  islandReplacementPreviewed: boolean;
  replacementDispatching: boolean;
}

export interface AutoResumeScheduleAttempt {
  /** Still owns this session after the timer fires and while async retry work awaits. */
  isCurrent: () => boolean;
}

export interface AutoResumeBookkeepingDeps {
  /** 把压住的 error 行补落进历史。**不负责横幅** —— 横幅由 abandonTakeover 决定。 */
  persistSuppressedError: (sessionId: string, detail: SuppressedTurnError) => void;
  /** 这条错误已确定需要呈现给用户；由 host 同步到聊天之外的错误表面（如 Agent Island）。 */
  surfaceSuppressedError?: (sessionId: string, detail: SuppressedTurnError) => void;
  /** 回填一条自动续跑记录的结果（`agentMeta.autoResumeOutcome`）。 */
  markOutcome: (sessionId: string, clientId: string, outcome: AutoResumeOutcome) => void;
  /** 回滚守卫的 pendingResume（不回滚会让该会话之后的中断永远被判成「上一次还在路上」）。 */
  rollbackGuardPendingResume: (sessionId: string, attemptToken?: number) => void;
  /** 清 coordinator 的接管态；带 message 时把红横幅回落出来。 */
  abandonTakeover: (sessionId: string, message?: string, attemptToken?: number) => void;
  /** 已接管的自动续跑最终没能继续；Schedule runner 用它结束同一个逻辑 run。 */
  onAutoResumeFailed?: (sessionId: string, attemptToken?: number) => void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export class AutoResumeBookkeeping {
  /**
   * 自愈接管中的会话 → 当初被压住的错误详情。
   *
   * 接管期间刻意**不落 error 行**：自愈成功时用户看到的应该是聊天流里一条低调的活动行，
   * 而不是一张红色错误卡 + 一条活动行。最终没救回来时用这份详情补落。
   */
  private readonly suppressedErrors = new Map<string, SuppressedTurnErrorEntry>();

  /**
   * 已落库、但还不知道结果的自动续跑消息（sessionId → clientId）。
   *
   * 那条消息在「续跑指令发出去」的瞬间就落库，那时还不知道有没有真连上；结果由
   * `settleOutcome` 在后续事件里回填。
   */
  private readonly pendingOutcomes = new Map<
    string,
    { clientId: string; attemptToken: number | null }
  >();

  /** Current automatic recovery owner. Every async settlement must match it. */
  private readonly currentAttempts = new Map<string, number>();

  /** Exact retry queue item that owns the suppressed error during pre-dispatch. */
  private readonly suppressedErrorClients = new Map<string, string>();

  /** 待触发或正在异步判定的退避 attempt（sessionId → 句柄 + ownership 令牌）。 */
  private readonly schedules = new Map<
    string,
    { timer: ReturnType<typeof setTimeout> | null; token: number; attemptToken: number | null }
  >();

  /** 排期令牌自增源（全局单调；只用来判「是不是我那次」，跨会话共享无妨）。 */
  private scheduleSeq = 0;

  constructor(private readonly deps: AutoResumeBookkeepingDeps) {}

  /** Start an attempt; deferred errors stashed before the decision inherit this token. */
  beginAttempt(sessionId: string, attemptToken: number): void {
    this.currentAttempts.set(sessionId, attemptToken);
    const suppressed = this.suppressedErrors.get(sessionId);
    if (suppressed?.attemptToken === null) suppressed.attemptToken = attemptToken;
  }

  isCurrentAttempt(sessionId: string, attemptToken: number): boolean {
    return this.currentAttempts.get(sessionId) === attemptToken;
  }

  // ── 被压住的错误详情 ───────────────────────────────────────────────────────

  /**
   * 记下被压住的那条 error 的详情，供后续补落。**每次中断只调一次**（落库被压住的那一刻）。
   *
   * 已经存着一条时先把它补落再覆盖：那条属于**上一次**中断（用户在退避里接手 → 新 turn
   * 起来 → 又被打断），而它剩下的唯一补落路径就是自己那次排期的回调，新排期一撤就没人管了
   * ——直接覆盖等于让上一次中断从历史里彻底消失（codex P1）。
   *
   * 「每次中断只调一次」是这条 flush 成立的前提：同一次中断若前后 stash 两遍，第二遍会把
   * 正在压制中的自己补落出来，红色错误卡与活动行同时出现，本功能也就白做了。
   */
  stashSuppressedError(
    sessionId: string,
    data: unknown,
    attemptToken: number | null = null,
    deferredOwner: SuppressedTurnErrorOwner | null = null,
  ): void {
    const previous = this.suppressedErrors.get(sessionId);
    if (previous?.replacementDispatching) {
      // The replacement has crossed the vendor boundary. A terminal error that
      // arrives now belongs to that new attempt; the older transient error was
      // successfully replaced and must not be restored beside it.
      this.suppressedErrors.delete(sessionId);
      this.suppressedErrorClients.delete(sessionId);
    } else {
      // A newer error owns the session now. Release the previous entry before
      // installing the replacement, but only release its exact attempt owner
      // after the new entry is present. This preserves ownership when both
      // entries happen to belong to the same attempt token.
      if (previous) {
        this.suppressedErrors.delete(sessionId);
        this.suppressedErrorClients.delete(sessionId);
        this.deps.persistSuppressedError(sessionId, previous.detail);
      }
    }
    const d = (data ?? {}) as { message?: unknown; reason?: unknown; sdkError?: unknown };
    this.suppressedErrors.set(sessionId, {
      attemptToken,
      deferredOwner,
      detail: {
        ...(typeof d.message === 'string' ? { message: d.message } : {}),
        ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
        ...(typeof d.sdkError === 'string' ? { sdkError: d.sdkError } : {}),
      },
      retryOwnerClientId: null,
      islandReplacementPreviewed: false,
      replacementDispatching: false,
    });
    if (previous?.attemptToken !== null && previous?.attemptToken !== undefined) {
      this.releaseAttemptIfUnowned(sessionId, previous.attemptToken);
    }
  }

  /** Bind a tokenized automatic queue item to the suppressed error it will replace. */
  bindSuppressedErrorToClient(
    sessionId: string,
    attemptToken: number,
    clientId: string,
  ): void {
    const entry = this.suppressedErrors.get(sessionId);
    if (
      this.isCurrentAttempt(sessionId, attemptToken) &&
      entry?.attemptToken === attemptToken
    ) {
      this.suppressedErrorClients.set(sessionId, clientId);
      entry.retryOwnerClientId = clientId;
    }
  }

  /** Whether the exact token/client still owns either side of the retry lifecycle. */
  hasPendingLifecycleForClient(
    sessionId: string,
    attemptToken: number,
    clientId: string,
  ): boolean {
    if (!this.isCurrentAttempt(sessionId, attemptToken)) return false;
    const entry = this.suppressedErrors.get(sessionId);
    const pending = this.pendingOutcomes.get(sessionId);
    return (
      this.suppressedErrorClients.get(sessionId) === clientId ||
      entry?.retryOwnerClientId === clientId ||
      (pending?.clientId === clientId && pending.attemptToken === attemptToken)
    );
  }

  /** Bind the suppressed failure to the exact retry queue item that will replace it. */
  claimSuppressedErrorForRetry(
    sessionId: string,
    clientId: string,
    source: 'manual' | 'auto' = 'auto',
  ): boolean {
    // Manual Retry transfers the failure to a user-owned queue item. Invalidate
    // even an already-fired backoff attempt before assigning the new owner.
    if (source === 'manual') this.cancelSchedule(sessionId);
    const entry = this.suppressedErrors.get(sessionId);
    if (!entry) return false;
    if (entry.retryOwnerClientId !== null && entry.retryOwnerClientId !== clientId) return false;
    entry.retryOwnerClientId = clientId;
    return true;
  }

  isSuppressedErrorClaimedByRetry(sessionId: string, clientId: string | undefined): boolean {
    if (!clientId) return false;
    return this.suppressedErrors.get(sessionId)?.retryOwnerClientId === clientId;
  }

  /** Agent Island accepted the replacement prompt and can now absorb the old completion tail. */
  markReplacementPreviewed(sessionId: string, clientId: string): boolean {
    const entry = this.suppressedErrors.get(sessionId);
    if (entry?.retryOwnerClientId !== clientId) return false;
    entry.islandReplacementPreviewed = true;
    return true;
  }

  /** The replacement is about to enter vendor code; later errors belong to the new attempt. */
  markReplacementDispatching(sessionId: string, clientId: string): boolean {
    const entry = this.suppressedErrors.get(sessionId);
    if (entry?.retryOwnerClientId !== clientId) return false;
    entry.replacementDispatching = true;
    return true;
  }

  /** Preview rollback returns tail ownership to bookkeeping until failure disposition runs. */
  rollbackReplacementPreview(sessionId: string, clientId: string): boolean {
    const entry = this.suppressedErrors.get(sessionId);
    if (entry?.retryOwnerClientId !== clientId) return false;
    entry.islandReplacementPreviewed = false;
    entry.replacementDispatching = false;
    return true;
  }

  /**
   * 只把压住的 error 行补落（不碰接管态、不弹横幅）。没有压住任何东西时是 no-op。
   *
   * 用于「决策推迟但最终没接管」与「旧的一条被新中断顶替」：前者横幅由 coordinator 在
   * 同一拍里自己设好，后者用户已经自己接手了，再弹横幅只是打扰 —— 但两种情况下那次
   * 中断都必须在历史里留下痕迹。
   */
  flushSuppressedError(
    sessionId: string,
    opts?: {
      attemptToken?: number;
      deferredOwner?: SuppressedTurnErrorOwner;
      force?: boolean;
    },
  ): boolean {
    const entry = this.suppressedErrors.get(sessionId);
    if (!entry) return false;
    if (!opts?.force) {
      const currentAttemptToken = this.currentAttempts.get(sessionId);
      if (opts?.attemptToken !== undefined) {
        if (entry.attemptToken !== opts.attemptToken) return false;
      } else if (opts?.deferredOwner === undefined && currentAttemptToken !== undefined) {
        // Session-only stale cleanup must never flush a newer attempt's error.
        return false;
      }
      if (
        opts?.deferredOwner !== undefined &&
        !sameSuppressedTurnErrorOwner(entry.deferredOwner, opts.deferredOwner)
      ) {
        return false;
      }
    }
    return this.releaseSuppressedError(sessionId, false);
  }

  /** 把压住的错误一次性补落，并通知 host 将它呈现到其它用户可见表面。 */
  surfaceSuppressedError(
    sessionId: string,
    opts?: {
      attemptToken?: number;
      deferredOwner?: SuppressedTurnErrorOwner;
      force?: boolean;
    },
  ): boolean {
    if (opts && !this.canReleaseSuppressedError(sessionId, opts)) return false;
    return this.releaseSuppressedError(sessionId, true);
  }

  private canReleaseSuppressedError(
    sessionId: string,
    opts: {
      attemptToken?: number;
      deferredOwner?: SuppressedTurnErrorOwner;
      force?: boolean;
    },
  ): boolean {
    const entry = this.suppressedErrors.get(sessionId);
    if (!entry || opts.force) return Boolean(entry);
    const currentAttemptToken = this.currentAttempts.get(sessionId);
    if (opts.attemptToken !== undefined && entry.attemptToken !== opts.attemptToken) return false;
    if (
      opts.deferredOwner !== undefined &&
      !sameSuppressedTurnErrorOwner(entry.deferredOwner, opts.deferredOwner)
    ) {
      return false;
    }
    if (
      opts.attemptToken === undefined &&
      opts.deferredOwner === undefined &&
      currentAttemptToken !== undefined
    ) {
      return false;
    }
    return true;
  }

  private releaseSuppressedError(sessionId: string, surfaceError: boolean): boolean {
    const entry = this.suppressedErrors.get(sessionId);
    if (!entry) return false;
    const attemptToken = entry.attemptToken;
    this.suppressedErrors.delete(sessionId);
    this.suppressedErrorClients.delete(sessionId);
    this.deps.persistSuppressedError(sessionId, entry.detail);
    if (surfaceError) this.deps.surfaceSuppressedError?.(sessionId, entry.detail);
    if (attemptToken !== null) this.releaseAttemptIfUnowned(sessionId, attemptToken);
    return true;
  }

  private releaseSuppressedErrorForRetry(
    sessionId: string,
    clientId: string,
    disposition: 'flush' | 'surface' | 'discard',
  ): boolean {
    const entry = this.suppressedErrors.get(sessionId);
    if (entry?.retryOwnerClientId !== clientId) return false;
    if (disposition === 'discard') {
      const attemptToken = entry.attemptToken;
      this.suppressedErrors.delete(sessionId);
      this.suppressedErrorClients.delete(sessionId);
      if (attemptToken !== null) this.releaseAttemptIfUnowned(sessionId, attemptToken);
      return true;
    }
    return this.releaseSuppressedError(sessionId, disposition === 'surface');
  }

  /** A claimed retry was explicitly removed before persistence (Stop / clear / policy block). */
  flushSuppressedErrorForRetry(sessionId: string, clientId: string): boolean {
    return this.releaseSuppressedErrorForRetry(sessionId, clientId, 'flush');
  }

  /** A claimed retry persisted but failed to dispatch, so the original failure is final. */
  surfaceSuppressedErrorForRetry(sessionId: string, clientId: string): boolean {
    return this.releaseSuppressedErrorForRetry(sessionId, clientId, 'surface');
  }

  /** A claimed retry crossed the irreversible dispatch boundary. */
  discardSuppressedErrorForRetry(sessionId: string, clientId: string): boolean {
    return this.releaseSuppressedErrorForRetry(sessionId, clientId, 'discard');
  }

  /**
   * A provider running/terminal signal can synchronously arrive before
   * Session.send returns accepted. Combined with replacementDispatching, that
   * signal proves the old transient error was replaced. Dispatching alone is
   * not proof: vendor send can still reject or the Session can close first.
   */
  discardReplacementProvenByProviderEvent(sessionId: string): boolean {
    const entry = this.suppressedErrors.get(sessionId);
    if (entry?.replacementDispatching !== true) return false;
    const attemptToken = entry.attemptToken;
    this.suppressedErrors.delete(sessionId);
    this.suppressedErrorClients.delete(sessionId);
    if (attemptToken !== null) this.releaseAttemptIfUnowned(sessionId, attemptToken);
    return true;
  }

  /** 自愈成功 → 压住的错误就此丢弃（用户看到的是「已重新连接」活动行，不该再有错误卡）。 */
  discardSuppressedError(sessionId: string, attemptToken?: number): boolean {
    const entry = this.suppressedErrors.get(sessionId);
    if (attemptToken !== undefined) {
      if (!this.isCurrentAttempt(sessionId, attemptToken)) return false;
      if (entry && entry.attemptToken !== attemptToken) return false;
    }
    this.suppressedErrors.delete(sessionId);
    this.suppressedErrorClients.delete(sessionId);
    const ownerToken = entry?.attemptToken ?? attemptToken;
    if (ownerToken !== undefined) this.releaseAttemptIfUnowned(sessionId, ownerToken);
    return true;
  }

  /** 是否仍有一条失败轮的终态等待 disposition；供同轮 completion tail 共用这一边界。 */
  hasSuppressedError(sessionId: string): boolean {
    return this.suppressedErrors.has(sessionId);
  }

  /** Before preview, bookkeeping itself must keep the failed turn's completion tail out. */
  shouldSuppressAgentIslandCompletionTail(sessionId: string): boolean {
    const entry = this.suppressedErrors.get(sessionId);
    return entry !== undefined && !entry.islandReplacementPreviewed;
  }

  /** After dispatch begins, an error belongs to the replacement attempt rather than the old one. */
  shouldSuppressAgentIslandError(sessionId: string): boolean {
    const entry = this.suppressedErrors.get(sessionId);
    return entry !== undefined && !entry.replacementDispatching;
  }

  /**
   * A new user action replaces an unclaimed backoff attempt. End the old
   * ownership synchronously so the next turn cannot inherit its Island filters.
   * Claimed entries remain owned by their exact queue-item disposition.
   */
  supersedeUnclaimedErrorForUserIntervention(sessionId: string): boolean {
    const cancelled = this.cancelSchedule(sessionId);
    if (!cancelled) {
      // A tokenized timer removes itself before entering async coordinator/DB work.
      // The current attempt still owns the guard during that window, so release it
      // even though there is no schedule handle left to cancel.
      const attemptToken = this.currentAttempts.get(sessionId);
      if (attemptToken !== undefined) {
        this.deps.rollbackGuardPendingResume(sessionId, attemptToken);
      }
    }
    const entry = this.suppressedErrors.get(sessionId);
    if (!entry || entry.retryOwnerClientId !== null) return false;
    return this.flushSuppressedError(sessionId, { force: true });
  }

  /**
   * 自愈没成 → 补落 error 行 + 结算待确认记录 + 清接管态，并按需把横幅回落出来。
   *
   * `surfaceError=false` 用于「退避窗口内用户自己接手了」：那时再弹错误只是打扰，
   * 但错误行仍要补落。
   */
  finalizeSuppressedError(
    sessionId: string,
    attemptOrOptions: number | { surfaceError?: boolean; surfaceBanner?: boolean },
    maybeOptions?: { surfaceBanner: boolean },
  ): boolean {
    const token = typeof attemptOrOptions === 'number' ? attemptOrOptions : undefined;
    const surfaceError =
      typeof attemptOrOptions === 'number'
        ? maybeOptions?.surfaceBanner === true
        : attemptOrOptions.surfaceError === true || attemptOrOptions.surfaceBanner === true;
    if (token !== undefined && !this.isCurrentAttempt(sessionId, token)) return false;

    if (token !== undefined) this.settleOutcome(sessionId, token, 'failed');
    else this.settleOutcome(sessionId, 'failed');

    const entry = this.suppressedErrors.get(sessionId);
    const ownsEntry = token === undefined || entry?.attemptToken === token;
    const detail = ownsEntry ? entry?.detail : undefined;
    const entryAttemptToken = ownsEntry ? entry?.attemptToken ?? null : null;
    if (ownsEntry) {
      this.suppressedErrors.delete(sessionId);
      this.suppressedErrorClients.delete(sessionId);
      if (detail) {
        this.deps.persistSuppressedError(sessionId, detail);
        if (surfaceError) this.deps.surfaceSuppressedError?.(sessionId, detail);
      }
    }
    this.deps.abandonTakeover(
      sessionId,
      surfaceError ? detail?.message : undefined,
      token,
    );
    this.deps.onAutoResumeFailed?.(sessionId, token);
    if (entryAttemptToken !== null) this.releaseAttemptIfUnowned(sessionId, entryAttemptToken);
    if (token !== undefined) this.releaseAttemptIfUnowned(sessionId, token);
    return true;
  }

  // ── 待确认的重连记录 ───────────────────────────────────────────────────────

  /** 自动续跑消息即将落库 → 登记待确认（产出→succeeded / 再被打断→failed）。 */
  registerPendingOutcome(
    sessionId: string,
    attemptOrClientId: number | string,
    maybeClientId?: string,
  ): void {
    const attemptToken = typeof attemptOrClientId === 'number' ? attemptOrClientId : null;
    const clientId = typeof attemptOrClientId === 'string' ? attemptOrClientId : maybeClientId;
    if (!clientId) return;
    if (attemptToken !== null && !this.isCurrentAttempt(sessionId, attemptToken)) return;
    this.pendingOutcomes.set(sessionId, { clientId, attemptToken });
  }

  /**
   * 那条消息最终没落库（写被拒）→ 撤掉登记。
   *
   * 登记刻意放在写**之前**（不能让「写完到登记之间」到达的事件漏掉结算），所以需要这条
   * 失败回滚：留着会让后续事件去 patch 一条压根不存在的消息。按 clientId 校验，避免撤掉
   * 别人的登记。
   */
  releasePendingOutcome(
    sessionId: string,
    attemptOrClientId: number | string,
    maybeClientId?: string,
  ): void {
    const attemptToken = typeof attemptOrClientId === 'number' ? attemptOrClientId : null;
    const clientId = typeof attemptOrClientId === 'string' ? attemptOrClientId : maybeClientId;
    const pending = this.pendingOutcomes.get(sessionId);
    if (!clientId || pending?.clientId !== clientId) return;
    if (attemptToken !== null && pending.attemptToken !== attemptToken) return;
    this.pendingOutcomes.delete(sessionId);
    if (attemptToken !== null) this.releaseAttemptIfUnowned(sessionId, attemptToken);
  }

  /** 这条 clientId 是不是该会话待确认的那条自动续跑消息。 */
  isPendingOutcomeClientId(sessionId: string, clientId: string): boolean {
    return this.pendingOutcomes.get(sessionId)?.clientId === clientId;
  }

  /** 回填结果并清除待确认（重复调用安全：没有待确认就 no-op）。 */
  settleOutcome(
    sessionId: string,
    attemptOrOutcome: number | AutoResumeOutcome,
    maybeOutcome?: AutoResumeOutcome,
  ): boolean {
    const attemptToken = typeof attemptOrOutcome === 'number' ? attemptOrOutcome : null;
    const outcome = typeof attemptOrOutcome === 'number' ? maybeOutcome : attemptOrOutcome;
    if (!outcome) return false;
    const pending = this.pendingOutcomes.get(sessionId);
    if (!pending) return false;
    if (attemptToken !== null && pending.attemptToken !== attemptToken) return false;
    this.pendingOutcomes.delete(sessionId);
    this.deps.markOutcome(sessionId, pending.clientId, outcome);
    if (attemptToken !== null) this.releaseAttemptIfUnowned(sessionId, attemptToken);
    return true;
  }

  settleOutcomeForClient(
    sessionId: string,
    attemptToken: number,
    clientId: string,
    outcome: AutoResumeOutcome,
  ): boolean {
    const pending = this.pendingOutcomes.get(sessionId);
    if (
      pending?.clientId !== clientId ||
      pending.attemptToken !== attemptToken
    ) {
      return false;
    }
    return this.settleOutcome(sessionId, attemptToken, outcome);
  }

  private releaseAttemptIfUnowned(sessionId: string, attemptToken: number): void {
    if (this.currentAttempts.get(sessionId) !== attemptToken) return;
    const pending = this.pendingOutcomes.get(sessionId);
    if (pending?.attemptToken === attemptToken) return;
    const entry = this.suppressedErrors.get(sessionId);
    if (entry?.attemptToken === attemptToken) return;
    this.currentAttempts.delete(sessionId);
  }

  // ── 退避排期 ───────────────────────────────────────────────────────────────

  /**
   * 排一次退避重试。
   *
   * 装新排期前先撤掉旧排期，**不**回滚守卫额度 —— 此刻的 pendingResume 属于新那次（旧那次
   * 已被 `noteTurnStarted` 清过），回滚会把新的一起抹掉。上一次中断的错误行由
   * `stashSuppressedError` 在覆盖时补落（补落必须发生在覆盖之前，放在这里就太晚了）。
   *
   * 每次排期带令牌，回调只认自己那次：否则旧回调会在它自己更早的到点时刻用新一轮的状态
   * 提前打出重试，还会把新句柄一起删掉，teardown 从此取消不了任何东西（codex P1）。
   */
  schedule(
    sessionId: string,
    attemptOrDelayMs: number,
    delayOrRun: number | ((attempt: AutoResumeScheduleAttempt) => void | Promise<void>),
    maybeRun?: (attempt: AutoResumeScheduleAttempt) => void | Promise<void>,
  ): void {
    const tokenized = typeof delayOrRun === 'number';
    const attemptToken = tokenized ? attemptOrDelayMs : this.currentAttempts.get(sessionId) ?? null;
    const delayMs = tokenized ? delayOrRun : attemptOrDelayMs;
    const run = tokenized ? maybeRun : delayOrRun;
    if (typeof run !== 'function') return;
    this.supersedeSchedule(sessionId);
    const token = ++this.scheduleSeq;
    const timer = setTimeout(() => {
      const scheduled = this.schedules.get(sessionId);
      if (scheduled?.token !== token || scheduled.attemptToken !== attemptToken) {
        this.deps.log?.('interrupted-turn auto-resume callback superseded; ignoring', { sessionId });
        return;
      }
      if (tokenized) {
        // Tokenized callbacks also keep a cancellable lease while async retry
        // classification is in flight. `attemptToken` is the durable owner, while
        // this schedule token lets Manual Retry / clear / teardown invalidate a
        // callback that already fired but is still awaiting DB/coordinator work.
        scheduled.timer = null;
        const attempt: AutoResumeScheduleAttempt = {
          isCurrent: () =>
            this.schedules.get(sessionId)?.token === token &&
            this.currentAttempts.get(sessionId) === attemptToken,
        };
        const complete = () => {
          const stillOwnsSchedule = this.schedules.get(sessionId)?.token === token;
          if (!stillOwnsSchedule) return;
          this.schedules.delete(sessionId);
          if (attemptToken !== null) this.releaseAttemptIfUnowned(sessionId, attemptToken);
        };
        try {
          const result = (run as (attempt: AutoResumeScheduleAttempt) => void | Promise<void>)(
            attempt,
          );
          if (result && typeof (result as Promise<void>).then === 'function') {
            void Promise.resolve(result).then(complete, (error: unknown) => {
              complete();
              this.deps.log?.('interrupted-turn auto-resume callback rejected', {
                sessionId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          } else complete();
        } catch (error) {
          complete();
          this.deps.log?.('interrupted-turn auto-resume callback threw', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      // Keep the lease cancellable while async retry classification is in flight.
      scheduled.timer = null;
      const attempt: AutoResumeScheduleAttempt = {
        isCurrent: () => this.schedules.get(sessionId)?.token === token,
      };
      const complete = () => {
        if (this.schedules.get(sessionId)?.token !== token) return;
        this.schedules.delete(sessionId);
      };
      try {
        const result = run(attempt);
        if (result && typeof result.then === 'function') {
          void Promise.resolve(result).then(complete, (error: unknown) => {
            complete();
            this.deps.log?.('interrupted-turn auto-resume callback rejected', {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        } else {
          complete();
        }
      } catch (error) {
        complete();
        this.deps.log?.('interrupted-turn auto-resume callback threw', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, delayMs);
    this.schedules.set(sessionId, { timer, token, attemptToken });
  }

  /** 新排期顶替旧排期：纯撤销，**不**回滚守卫额度（理由见 `schedule`）。 */
  private supersedeSchedule(sessionId: string): void {
    const scheduled = this.schedules.get(sessionId);
    if (!scheduled) return;
    if (scheduled.timer !== null) clearTimeout(scheduled.timer);
    this.schedules.delete(sessionId);
    this.deps.log?.('interrupted-turn auto-resume schedule superseded by a newer one', { sessionId });
  }

  /** 终止当前 attempt 并回滚守卫的 pendingResume；没有 attempt 时是 no-op。 */
  cancelSchedule(sessionId: string): boolean {
    const scheduled = this.schedules.get(sessionId);
    if (!scheduled) return false;
    if (scheduled.timer !== null) clearTimeout(scheduled.timer);
    this.schedules.delete(sessionId);
    if (scheduled.attemptToken === null) this.deps.rollbackGuardPendingResume(sessionId);
    else this.deps.rollbackGuardPendingResume(sessionId, scheduled.attemptToken);
    if (scheduled.attemptToken !== null) {
      this.releaseAttemptIfUnowned(sessionId, scheduled.attemptToken);
    }
    this.deps.log?.('interrupted-turn auto-resume attempt cancelled', { sessionId });
    return true;
  }

  /** 仅测试与诊断用：该会话此刻有没有待触发或正在判定的 attempt。 */
  hasSchedule(sessionId: string): boolean {
    return this.schedules.has(sessionId);
  }

  /**
   * Whether the exact attempt is still waiting for its timer to fire.
   *
   * `hasSchedule()` intentionally also returns true while the callback is
   * awaiting DB/coordinator work. Session-close handoff must distinguish that
   * execution phase from the pre-fire rebuild window; once the timer has fired,
   * the old Session is no longer safe to preserve.
   */
  hasWaitingSchedule(sessionId: string, attemptToken: number): boolean {
    const scheduled = this.schedules.get(sessionId);
    return (
      scheduled?.attemptToken === attemptToken &&
      scheduled.timer !== null &&
      this.currentAttempts.get(sessionId) === attemptToken
    );
  }

  // ── 会话终止收尾 ───────────────────────────────────────────────────────────

  /**
   * 会话被终止（/clear、abort、「全部停止」、关闭）时的收尾。四件事必须一起做，
   * 顺序也重要：
   *
   *  1. **先补落**仍存在的错误。accepted=true 与实际 provider running/terminal signal
   *     会在各自的权威边界提前删掉旧 owner；仅进入 dispatching 仍可能 reject/close，
   *     不能按毫秒时序把那条历史静默丢掉。`/clear` 的补落由既有清空竞态 cap 兜住。
   *  2. 撤排期（含回滚守卫额度）。
   *  3. 清 coordinator 接管态 —— attempt lease 已能挡住 late completion；这一步继续作为
   *     coordinator 自己在 await 后的复核，并撤掉用户看到的「重新连接中」。
   *  4. 把悬空的待确认记录钉成 failed。
   */
  teardown(sessionId: string): void {
    const attemptToken =
      this.currentAttempts.get(sessionId) ?? this.pendingOutcomes.get(sessionId)?.attemptToken ?? null;
    this.flushSuppressedError(sessionId, { force: true });
    const hadSchedule = this.cancelSchedule(sessionId);
    if (!hadSchedule && attemptToken !== null) {
      this.deps.rollbackGuardPendingResume(sessionId, attemptToken);
    }
    // 不带 message：只清接管态，不弹横幅（会话已经被用户终止，再弹一条只是打扰）。
    this.deps.abandonTakeover(sessionId);
    if (attemptToken !== null) this.settleOutcome(sessionId, attemptToken, 'failed');
    else this.settleOutcome(sessionId, 'failed');
    this.currentAttempts.delete(sessionId);
    this.suppressedErrorClients.delete(sessionId);
    this.deps.onAutoResumeFailed?.(sessionId, attemptToken ?? undefined);
  }
}

function sameSuppressedTurnErrorOwner(
  left: SuppressedTurnErrorOwner | null,
  right: SuppressedTurnErrorOwner,
): boolean {
  return left?.generation === right.generation && left.clientId === right.clientId;
}
