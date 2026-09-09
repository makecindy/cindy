/**
 * UsageTracker — agent-agnostic 的 token / context / cost 状态机。
 *
 * 设计目标:
 *   - 把"对标 agentManager.ts 的 currentTurn / lastApi / contextWindow / cumulativeCost"
 *     这套 mutable session state 从 translator / vendor runtime 里抽出来,放到
 *     一个独立的可单测、可跨 agent 复用的 class 里。
 *   - translator 不再做累加,只在 SDK 事件触发点调 ingest* / setContextWindow / endTurn,
 *     emit status event 时数值一律走 tracker.snapshot() —— 单一可信源。
 *   - 各 agent (claude-code / codex) 自己决定怎么从 SDK 原始 usage 字段映射到
 *     本类的 ingestApiCallUsage(...) 入参,本类对 SDK 协议无知。
 *
 * 对标 (agentManager.ts):
 *   - currentTurn{Input,Output,CacheRead,CacheCreate}Tokens (每 turn 累计,result 后 reset)
 *   - lastApi{Input,CacheRead,CacheCreate}Tokens            (最后一次 API call,跨 turn 保留)
 *   - resultModelUsage[model].contextWindow                 (每次 result 时 set)
 *   - 累计 cost                                              (覆盖 result.total_cost_usd —— SDK 子进程内累计值)
 *
 * 不在本类范围:
 *   - status text (Generating.../Done/...)  — translator 自己设
 *   - isRunning 标志                         — translator 在 push status 时拼
 *     (它属于 session lifecycle 不属于 usage)
 */

import type { UsageSnapshot } from '../../types/events.js';

/**
 * One provider request (or the narrowest reliable upstream usage boundary).
 *
 * Pricing consumers must price each segment independently before summing a
 * turn. In particular, long-context bands are request-scoped: selecting a
 * band from the turn aggregate overcharges turns made of many smaller calls.
 */
export interface UsageSegment {
  /** Stable only within the owning turn; used to merge split provider frames. */
  id?: string;
  /** Actual model for this request when the provider exposes it. */
  model?: string;
  /** Request price variant. Fast maps to the gateway priority tariff. */
  priceVariant?: 'standard' | 'priority' | 'fast' | 'batch';
  /** 输入 token (不含 cache) */
  inputTokens: number;
  outputTokens: number;
  /** 命中缓存读出的 token (Anthropic cache_read_input_tokens / Codex 类似) */
  cacheReadTokens?: number;
  /** 写入缓存的 token (Anthropic cache_creation_input_tokens) */
  cacheCreateTokens?: number;
  /** Provider diagnostic subset; never add this to outputTokens again. */
  reasoningTokens?: number;
  /** Provider-reported request cost, used only on routes where that value is authoritative. */
  costUsd?: number;
  /** Upstream emitted a terminal request usage frame covering every token bucket. */
  complete?: boolean;
}

export class UsageTracker {
  // ── turn 累计 ────────────────────────────────────────────────────────────
  // 每次 ingestApiCallUsage 累加, endTurn 后由 resetCurrentTurn 清零。
  // 老链路对标: agentManager.ts:2362-2365 currentTurn{Input,Output,CacheRead,CacheCreate}Tokens
  private currentTurn = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

  // Request/segment boundaries for request-scoped pricing. This list follows
  // the same turn lifecycle as currentTurn and is copied before exposure.
  private currentTurnSegments: UsageSegment[] = [];
  private currentTurnSegmentIndex = new Map<string, number>();

  // ── 最后一次 API call 快照 ─────────────────────────────────────────────────
  // 用于 contextTokens (圆环): 反映"自动压缩后真实 context 占用",而非整 turn 累计。
  // 跨 turn 保留 —— 下一 turn 第一次 ingestApiCallUsage 时被覆盖。
  // 老链路对标: agentManager.ts:2358-2360 lastApi{Input,CacheRead,CacheCreate}Tokens
  private lastApi = { input: 0, cacheRead: 0, cacheCreate: 0 };

  // ── 模型上下文窗口 ─────────────────────────────────────────────────────────
  // result.modelUsage[model].contextWindow 写进来; 跨 turn 保留 (同模型不会变,
  // setModel 切换后下个 result 会覆盖)。
  // 老链路对标: agentManager.ts:2600-2616
  private contextWindow = 0;

  // ── 累计 cost ─────────────────────────────────────────────────────────────
  // claude-code: 入参 costUsd 是 SDK 子进程内累计 (从 spawn 起算, 每次 result 给一个新累计值),
  //              直接覆盖而非 +=, 否则会把同一笔钱算 N 次 (turn 越多越离谱)。
  // codex: 不传 costUsd, 字段保持 0 (SDK 不报告 codex cost, UI 也不显示)。
  // session 持久化的 sessions.total_cost_usd 走 register.ts 的 delta 算法, 与本字段独立。
  private cumulativeCostUsd = 0;

  // ── 按模型分桶累计 cost (额外字典, 不参与 snapshot, 仅供调试/未来扩展) ────
  // 同一 session 内切换模型时, SDK msg.modelUsage[model].costUSD 是每个模型
  // 在子进程内的累计值, 这里覆盖语义与 cumulativeCostUsd 一致 (避免重复累加)。
  private cumulativeCostUsdByModel = new Map<string, number>();

  // ── Cache 命中率统计 (诊断专用, 不参与 snapshot / 不影响 UI) ────────────
  // 用途: 排查"是不是第三方 proxy 把 cache_control 透传搞坏了"。
  // 指标:
  //   - turn 级: 每次 ingestApiCallUsage 累加, endTurn 后清零 (跟 currentTurn 同步)
  //   - session 级: 跨 turn 累计, 只在 reset() / 新 session 时清零
  // hitRate 公式: cacheRead / (cacheRead + cacheCreate + uncachedInput)
  //   - 分母用"本次 API call 真正进入模型的 input token 总量"
  //   - input_tokens (Anthropic) / inputTokens-cachedInputTokens (Codex 已减过) = uncached
  //   - 命中 = cacheRead 部分, 未命中 = cacheCreate + uncached
  // 都为 0 时 hitRate=null (避免 0/0)。
  private turnCache = { read: 0, create: 0, uncachedInput: 0, apiCalls: 0 };
  private sessionCache = { read: 0, create: 0, uncachedInput: 0, apiCalls: 0 };

  /**
   * SDK 报告一次 API call 的 usage 时调 (claude-code: message_delta;
   * codex: 在 turn.completed 或类似事件提取后映射)。
   * 同时累加 currentTurn + 覆盖 lastApi。
   */
  ingestApiCallUsage(usage: UsageSegment): void {
    this.appendUsageSegment(usage);
  }

  /**
   * Merge split frames for one provider request. Claude commonly reports the
   * input/cache side at message_start and output at message_delta; some
   * compatible endpoints repeat input/cache on both frames. Field-wise max
   * preserves the final request snapshot without double counting repeats.
   */
  upsertApiCallUsage(segmentId: string, usage: UsageSegment): void {
    if (!segmentId) {
      this.appendUsageSegment(usage);
      return;
    }
    const existingIndex = this.currentTurnSegmentIndex.get(segmentId);
    if (existingIndex === undefined) {
      this.appendUsageSegment({ ...usage, id: segmentId });
      return;
    }
    const existing = this.currentTurnSegments[existingIndex]!;
    const merged: UsageSegment = {
      ...existing,
      ...usage,
      id: segmentId,
      // Request identity is fixed by the first frame. Runtime settings may
      // change before a terminal frame arrives, but that must not re-price an
      // already-dispatched request.
      model: existing.model ?? usage.model,
      priceVariant: existing.priceVariant ?? usage.priceVariant,
      inputTokens: Math.max(existing.inputTokens, usage.inputTokens),
      outputTokens: Math.max(existing.outputTokens, usage.outputTokens),
      cacheReadTokens: Math.max(existing.cacheReadTokens ?? 0, usage.cacheReadTokens ?? 0),
      cacheCreateTokens: Math.max(existing.cacheCreateTokens ?? 0, usage.cacheCreateTokens ?? 0),
      reasoningTokens: Math.max(existing.reasoningTokens ?? 0, usage.reasoningTokens ?? 0),
      costUsd: Math.max(existing.costUsd ?? 0, usage.costUsd ?? 0),
      ...(existing.complete !== undefined || usage.complete !== undefined
        ? { complete: existing.complete === true || usage.complete === true }
        : {}),
    };
    this.currentTurnSegments[existingIndex] = merged;
    this.applyUsageDelta(
      {
        inputTokens: merged.inputTokens - existing.inputTokens,
        outputTokens: merged.outputTokens - existing.outputTokens,
        cacheReadTokens: (merged.cacheReadTokens ?? 0) - (existing.cacheReadTokens ?? 0),
        cacheCreateTokens: (merged.cacheCreateTokens ?? 0) - (existing.cacheCreateTokens ?? 0),
      },
      false,
    );
    if (
      merged.inputTokens > 0 ||
      (merged.cacheReadTokens ?? 0) > 0 ||
      (merged.cacheCreateTokens ?? 0) > 0
    ) {
      this.lastApi = {
        input: merged.inputTokens,
        cacheRead: merged.cacheReadTokens ?? 0,
        cacheCreate: merged.cacheCreateTokens ?? 0,
      };
    }
  }

  private appendUsageSegment(usage: UsageSegment): void {
    const normalized: UsageSegment = {
      ...usage,
      inputTokens: Math.max(0, usage.inputTokens),
      outputTokens: Math.max(0, usage.outputTokens),
      cacheReadTokens: Math.max(0, usage.cacheReadTokens ?? 0),
      cacheCreateTokens: Math.max(0, usage.cacheCreateTokens ?? 0),
      ...(usage.reasoningTokens !== undefined
        ? { reasoningTokens: Math.max(0, usage.reasoningTokens) }
        : {}),
      ...(usage.costUsd !== undefined ? { costUsd: Math.max(0, usage.costUsd) } : {}),
    };
    if (normalized.id)
      this.currentTurnSegmentIndex.set(normalized.id, this.currentTurnSegments.length);
    this.currentTurnSegments.push(normalized);
    this.applyUsageDelta(normalized, true);
  }

  private applyUsageDelta(
    usage: Pick<
      UsageSegment,
      'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreateTokens'
    >,
    isNewApiCall: boolean,
  ): void {
    const cr = usage.cacheReadTokens ?? 0;
    const cc = usage.cacheCreateTokens ?? 0;

    // lastApi: 覆盖, 反映"最后一次 API call" (如果入参全 0 则不覆盖，防止被没有 input_tokens 的 delta 冲掉)
    if (isNewApiCall && (usage.inputTokens > 0 || cr > 0 || cc > 0)) {
      this.lastApi.input = usage.inputTokens;
      this.lastApi.cacheRead = cr;
      this.lastApi.cacheCreate = cc;
    }

    // currentTurn: 累加, 反映"本 turn 已消耗"
    this.currentTurn.input += usage.inputTokens;
    this.currentTurn.output += usage.outputTokens;
    this.currentTurn.cacheRead += cr;
    this.currentTurn.cacheCreate += cc;

    // cache 命中率累加: 同时进 turn / session 两个桶
    // usage.inputTokens 已经是"未命中缓存的输入 token"(claude message_delta 直接是 input_tokens,
    // codex 已经在调用方做过 totalInput - cached 减法), 所以此处直接当 uncached 累加。
    this.turnCache.read += cr;
    this.turnCache.create += cc;
    this.turnCache.uncachedInput += usage.inputTokens;
    if (isNewApiCall) this.turnCache.apiCalls += 1;
    this.sessionCache.read += cr;
    this.sessionCache.create += cc;
    this.sessionCache.uncachedInput += usage.inputTokens;
    if (isNewApiCall) this.sessionCache.apiCalls += 1;
  }

  /**
   * result.usage 是 turn aggregate。部分 provider 只在 result 阶段补报 cache
   * tokens；这时 contextTokens 会在 endTurn() 里修正，但 cache hit-rate 诊断桶也
   * 必须同步补上 aggregate 与当前累计值之间的差额。
   */
  ingestTurnAggregateCacheStats(usage: {
    inputTokens: number;
    cacheReadTokens?: number;
    cacheCreateTokens?: number;
  }): void {
    const aggregateInput = usage.inputTokens;
    const aggregateCacheRead = usage.cacheReadTokens ?? this.currentTurn.cacheRead;
    const aggregateCacheCreate = usage.cacheCreateTokens ?? this.currentTurn.cacheCreate;
    const deltaRead = Math.max(0, aggregateCacheRead - this.currentTurn.cacheRead);
    const deltaCreate = Math.max(0, aggregateCacheCreate - this.currentTurn.cacheCreate);
    const deltaUncached = Math.max(0, aggregateInput - this.currentTurn.input);

    if (deltaRead === 0 && deltaCreate === 0 && deltaUncached === 0) return;

    this.turnCache.read += deltaRead;
    this.turnCache.create += deltaCreate;
    this.turnCache.uncachedInput += deltaUncached;
    this.sessionCache.read += deltaRead;
    this.sessionCache.create += deltaCreate;
    this.sessionCache.uncachedInput += deltaUncached;
    if (this.turnCache.apiCalls === 0) {
      this.turnCache.apiCalls = 1;
      this.sessionCache.apiCalls += 1;
    }
  }

  /**
   * Compact 后用 postTokens 覆盖 lastApi，使后续 snapshot().contextTokens
   * 反映压缩后的真实 context 占用，而非压缩前最后一次 API call 的值。
   */
  setContextTokensAfterCompact(postTokens: number): void {
    if (postTokens > 0) {
      this.lastApi = { input: postTokens, cacheRead: 0, cacheCreate: 0 };
    }
  }

  /**
   * SDK 在 result 阶段报告模型上下文窗口大小时调。
   * 0 视为"未知" —— renderer 端有 model prefix → 200K/1M 的 fallback 兜底。
   */
  setContextWindow(window: number): void {
    if (window > 0) this.contextWindow = window;
  }

  /**
   * 上下文超限错误(400 context_length_exceeded / prompt is too long 等)终态时调。
   *
   * 超限请求被上游整体拒绝, 不返回任何 usage —— lastApi 停在上一次成功值(会话重启后
   * 首轮就失败则是 0), snapshot().contextTokens 会把"已经溢出"显示成低占用甚至 0%,
   * 且 auto-compact 的 ratio 判定永远走不到阈值, 会话进入"超限 → 无 usage → 不压缩 →
   * 重试再超限"的自锁(#1429)。这里把 lastApi 锁到窗口满载, 让圆环如实显示 100%、
   * ratio 达到 1.0, turn end 的 auto-compact 判定得以触发。
   *
   * 窗口未知(0)时 no-op —— 与 setContextWindow / AutoCompactController.onUsageUpdate
   * 一致的"无估算"原则; 已 ≥ 窗口(上一轮真实值本就超了)时也不动, 保留真实读数。
   */
  markContextOverflow(): void {
    if (this.contextWindow <= 0) return;
    const current = this.lastApi.input + this.lastApi.cacheRead + this.lastApi.cacheCreate;
    if (current >= this.contextWindow) return;
    this.lastApi = { input: this.contextWindow, cacheRead: 0, cacheCreate: 0 };
  }

  /**
   * 当前 turn 已累计的真实用量 (copy, 只读)。
   *
   * 与 endTurn 的关系: endTurn(turnUsage) 会用调用方给的 aggregate **覆盖**
   * input/output 再 reset — Codex 链路的调用方只有 contextTokens 可给 (降级值),
   * 所以 done 事件要在 endTurn 之前用本方法取走真实 per-turn 累计
   * (来自每次 tokenUsage/updated 的 ingestApiCallUsage 累加)。
   * 语义: input = 未命中缓存输入, output = provider 的计费 output（reasoning 若为
   * 子集不重复相加）, cacheRead = 命中缓存。
   */
  getTurnUsage(): {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreate: number;
  } {
    return { ...this.currentTurn };
  }

  /** Current turn's provider request boundaries, returned as defensive copies. */
  getTurnUsageSegments(): UsageSegment[] {
    return this.currentTurnSegments.map((segment) => ({ ...segment }));
  }

  /**
   * Turn 结束: 用 result.usage (turn aggregate) 锁定 currentTurn,
   * 覆盖 cost,返回 turn-end snapshot,然后内部 reset currentTurn 为下一轮做准备。
   *
   * 锁定的原因: 老链路 turn end 的 tokenUsage 用 result.usage.input + output,
   * 不是 currentTurn 累加值 (理论上相等,但以 SDK aggregate 为准更稳)。
   *
   * costUsd 覆盖语义: SDK 子进程的 total_cost_usd 本身就是从 spawn 起累计,
   * 不是 per-turn 增量, 直接覆盖即可 (历史 += bug 会让 cost 越积越离谱)。
   *
   * lastApi 不动 —— 跨 turn 保留, 下一轮 message_delta 才覆盖。
   */
  endTurn(turnUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreateTokens?: number;
    costUsd?: number;
    replaceLastApi?: boolean;
  }): UsageSnapshot {
    if (turnUsage) {
      this.currentTurn.input = turnUsage.inputTokens;
      this.currentTurn.output = turnUsage.outputTokens;
      const cacheRead = turnUsage.cacheReadTokens ?? this.currentTurn.cacheRead;
      const cacheCreate = turnUsage.cacheCreateTokens ?? this.currentTurn.cacheCreate;
      this.currentTurn.cacheRead = cacheRead;
      this.currentTurn.cacheCreate = cacheCreate;
      if (typeof turnUsage.costUsd === 'number') {
        this.cumulativeCostUsd = turnUsage.costUsd;
      }
      // 兜底：如果整个 turn 都没拿到 input_tokens，用最终的 turn aggregate 填上 context 消耗。
      // 部分 provider 只在 result.usage 报 cache_read/cache_creation；这些也属于 context 占用。
      // 单 API turn 时调用方可显式要求用 result aggregate 覆盖 lastApi，修正
      // message_start 只有 input_tokens、result 才有 cache tokens 的低估。
      if (
        turnUsage.replaceLastApi ||
        (this.lastApi.input === 0 && this.lastApi.cacheRead === 0 && this.lastApi.cacheCreate === 0)
      ) {
        this.lastApi.input = turnUsage.inputTokens;
        this.lastApi.cacheRead = cacheRead;
        this.lastApi.cacheCreate = cacheCreate;
      }
    }
    const snap = this.snapshot();
    // reset currentTurn for next turn (lastApi / contextWindow / cost 跨 turn 保留)
    this.currentTurn = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    this.currentTurnSegments = [];
    this.currentTurnSegmentIndex.clear();
    // turnCache 同步清零, sessionCache 跨 turn 累计保留
    this.turnCache = { read: 0, create: 0, uncachedInput: 0, apiCalls: 0 };
    return snap;
  }

  /**
   * Turn 开始 (用户 send 时调): 主动清 currentTurn,
   * 防止上一 turn 没正常 endTurn (异常 / abort) 时 currentTurn 残留。
   * 通常 endTurn 已经清过, 这里是兜底; 重复清零无害。
   */
  beginTurn(): void {
    this.currentTurn = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    this.currentTurnSegments = [];
    this.currentTurnSegmentIndex.clear();
    // 兜底清 turnCache, 防止上一 turn 异常 / abort 没走到 endTurn 留下脏数据;
    // 与 currentTurn 同语义。
    this.turnCache = { read: 0, create: 0, uncachedInput: 0, apiCalls: 0 };
  }

  /**
   * 按模型上报 per-model 累计 cost (覆盖语义)。
   * SDK msg.modelUsage[model].costUSD 已经是每个模型在子进程内的累计值, 直接覆盖。
   * 入参里 cost 不是 number 或 ≤ 0 的条目跳过 (避免把空模型项写进字典)。
   */
  ingestModelCosts(modelCosts: Record<string, number | undefined>): void {
    for (const [model, cost] of Object.entries(modelCosts)) {
      if (typeof cost === 'number' && cost > 0) {
        this.cumulativeCostUsdByModel.set(model, cost);
      }
    }
  }

  /**
   * 取 per-model cost 字典快照 (普通对象, 调用方可安全保存)。
   * 当前未接入 UI / snapshot, 仅用于日志输出与未来按模型分桶展示。
   */
  getCostByModel(): Record<string, number> {
    return Object.fromEntries(this.cumulativeCostUsdByModel);
  }

  /**
   * Cache 命中率统计快照。turn / session 两个粒度都给。
   *
   * 主要用途: 排查第三方 proxy / SDK bug 导致的 prompt cache 失效 ——
   * 直连官方端点时 hitRate 一般 ≥ 0.8 (warm), 走未优化的 proxy 经常掉到 0.2 以下。
   *
   * hitRate 公式: read / (read + create + uncachedInput)
   *   - 分母 = 本桶内所有"真正进模型"的 input token
   *   - 分子 = 命中缓存的 input token
   *   - 全为 0 时返 null (避免 0/0; 调用方按"暂无数据"处理)
   *
   * apiCalls = 桶内 ingestApiCallUsage 调用次数, 配合 hitRate 判断"热身"程度
   *   (1-2 次的 hitRate 不能代表 session 长期表现)。
   */
  getCacheStats(): {
    turn: {
      read: number;
      create: number;
      uncachedInput: number;
      apiCalls: number;
      hitRate: number | null;
    };
    session: {
      read: number;
      create: number;
      uncachedInput: number;
      apiCalls: number;
      hitRate: number | null;
    };
  } {
    const calc = (b: { read: number; create: number; uncachedInput: number }): number | null => {
      const denom = b.read + b.create + b.uncachedInput;
      return denom > 0 ? b.read / denom : null;
    };
    return {
      turn: { ...this.turnCache, hitRate: calc(this.turnCache) },
      session: { ...this.sessionCache, hitRate: calc(this.sessionCache) },
    };
  }

  /**
   * 当前 snapshot —— 任何时刻调都返回最新数值。
   * translator 在 push status event 时调它取数。
   */
  snapshot(): UsageSnapshot {
    return {
      tokenUsage: this.currentTurn.input + this.currentTurn.output,
      contextTokens: this.lastApi.input + this.lastApi.cacheRead + this.lastApi.cacheCreate,
      contextWindow: this.contextWindow,
      costUsd: this.cumulativeCostUsd,
    };
  }
}
