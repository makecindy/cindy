/**
 * modelUsageDelta — Claude SDK modelUsage 累计值 → per-turn delta 的纯函数。
 *
 * 背景: Claude SDK done 事件的 `modelUsage: Record<model, ModelUsage>` 与
 * `total_cost_usd` 同语义 — 都是**子进程内累计**, 不是 per-turn。要写入
 * daily_model_usage 表必须 cumulative - lastReported (与 register.ts 的
 * lastReportedCostUsdBySession 同款手法)。
 *
 * 基线: 首次快照或子进程重 spawn 后的回退快照不能直接当成本轮增量。
 * 先把累计值设为新基线；若独立观察到的完整 request segments 与该快照逐桶一致，
 * 才保留这轮 token/cost。其余情况宁可只保留可证明的 segment token，也不吞入历史累计。
 *
 * ## 已知上游行为: output 归属可能滞后一轮
 *
 * 部分路由(实测 Vertex, requestId 前缀 msg_vrtx_)在 done 事件时点报出的 modelUsage
 * 尚未结算本轮的输出 token: 一条几千 token 的长回复只报个位数 output, 差额在下一轮的
 * delta 里补上。result.usage 与 modelUsage 两个源同时滞后, 所以客户端在 done 时刻拿
 * 不到正确值 —— 总量不丢, 但**归属会错位一轮**, 表现为某条消息的费用明显偏低、下一条
 * 明显偏高。
 *
 * 这里不做纠正: 把 output 挪到别处需要知道"本轮真实输出是多少", 而两个可用数据源都
 * 还没结算; 猜一个值会把"归属错位"升级成"金额算错"。detectOutputLag 只把可疑轮次标出
 * 来供日志定位与 TPS 可靠性门禁，不参与任何计费或 token 纠正。
 *
 * 纯函数、零 Electron 依赖 — 可直接单测。
 */

/** SDK modelUsage 单模型条目里我们关心的字段 (其余忽略)。 */
export interface ModelUsageCumulative {
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** 单模型 per-turn 增量。 */
export interface ModelUsageDeltaEntry {
  model: string;
  costUsdDelta: number;
  inputTokensDelta: number;
  outputTokensDelta: number;
  cacheReadTokensDelta: number;
  cacheCreateTokensDelta: number;
}

export interface ObservedModelTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** 把 SDK 原始条目清洗成全数字快照 (缺字段 / 脏值归 0)。 */
function sanitize(raw: unknown): ModelUsageCumulative {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    costUSD: num(r.costUSD),
    inputTokens: num(r.inputTokens),
    outputTokens: num(r.outputTokens),
    cacheReadInputTokens: num(r.cacheReadInputTokens),
    cacheCreationInputTokens: num(r.cacheCreationInputTokens),
  };
}

/**
 * 计算本次 done 事件相对上次的 per-model delta。
 *
 * @param prev    该 session 上次记录的累计快照 (首个 turn 传 undefined)
 * @param current SDK done 事件的 modelUsage (原始, 未清洗)
 * @returns next  = 本次累计快照 (调用方存回 map, 供下个 turn 用)
 *          deltas = 有增量的模型列表 (全 0 的模型不出现)
 */
export function computeModelUsageDeltas(
  prev: Map<string, ModelUsageCumulative> | undefined,
  current: Record<string, unknown>,
  observedTurnUsage?: ReadonlyMap<string, ObservedModelTurnUsage>,
  options: { cumulativeStartsAtZero?: boolean } = {},
): { next: Map<string, ModelUsageCumulative>; deltas: ModelUsageDeltaEntry[] } {
  const next = new Map<string, ModelUsageCumulative>();
  const deltas: ModelUsageDeltaEntry[] = [];

  for (const [model, raw] of Object.entries(current)) {
    if (!model) continue;
    const cum = sanitize(raw);
    const last = prev?.get(model);
    // 重 spawn 归零检测: 任一累计字段比上次小 → 把上次基线当 0 (从头累计)。
    // 逐字段 max(0, ...) 也能兜住, 但整体归零更贴近"子进程重启"的真实语义,
    // 避免归零后部分字段仍按旧基线钳成 0、部分按新值全额计入的混合口径。
    const reset =
      last !== undefined &&
      (cum.costUSD < last.costUSD ||
        cum.inputTokens < last.inputTokens ||
        cum.outputTokens < last.outputTokens ||
        cum.cacheReadInputTokens < last.cacheReadInputTokens ||
        cum.cacheCreationInputTokens < last.cacheCreationInputTokens);
    const unbaselined = reset || last === undefined;
    const cumulativeStartsAtZero = options.cumulativeStartsAtZero === true;
    const observed =
      observedTurnUsage?.get(model) ?? observedTurnUsage?.get(model.replace(/\[[^\]]*\]\s*$/, ''));
    const observedMatchesCumulative =
      observed !== undefined &&
      cum.inputTokens === observed.inputTokens &&
      cum.outputTokens === observed.outputTokens &&
      cum.cacheReadInputTokens === observed.cacheReadTokens &&
      cum.cacheCreationInputTokens === observed.cacheCreateTokens;
    const base = unbaselined
      ? cumulativeStartsAtZero
        ? {
            costUSD: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          }
        : cum
      : last;

    const entry: ModelUsageDeltaEntry = {
      model,
      // A first snapshot after desktop restart/reattach may contain the whole
      // provider session. Only treat its cumulative cost as this turn when the
      // independently observed request segments prove the token totals match.
      costUsdDelta: unbaselined
        ? cumulativeStartsAtZero || observedMatchesCumulative
          ? cum.costUSD
          : 0
        : Math.max(0, cum.costUSD - base.costUSD),
      inputTokensDelta:
        observed && unbaselined && !cumulativeStartsAtZero
          ? observed.inputTokens
          : Math.max(0, cum.inputTokens - base.inputTokens),
      outputTokensDelta:
        observed && unbaselined && !cumulativeStartsAtZero
          ? observed.outputTokens
          : Math.max(0, cum.outputTokens - base.outputTokens),
      cacheReadTokensDelta:
        observed && unbaselined && !cumulativeStartsAtZero
          ? observed.cacheReadTokens
          : Math.max(0, cum.cacheReadInputTokens - base.cacheReadInputTokens),
      cacheCreateTokensDelta:
        observed && unbaselined && !cumulativeStartsAtZero
          ? observed.cacheCreateTokens
          : Math.max(0, cum.cacheCreationInputTokens - base.cacheCreationInputTokens),
    };
    next.set(model, cum);
    if (
      entry.costUsdDelta > 0 ||
      entry.inputTokensDelta > 0 ||
      entry.outputTokensDelta > 0 ||
      entry.cacheReadTokensDelta > 0 ||
      entry.cacheCreateTokensDelta > 0
    ) {
      deltas.push(entry);
    }
  }

  // prev 里有但 current 没有的模型: 保留旧快照 (SDK 不保证每次 done 都带全部模型)。
  if (prev) {
    for (const [model, snap] of prev) {
      if (!next.has(model)) next.set(model, snap);
    }
  }

  return { next, deltas };
}

/**
 * 本轮 output 归属是否可疑（见文件头「已知上游行为」）。
 *
 * 判据：这一轮明明送进去了实质性的输入（input + cache 合计过万 token，说明不是空转），
 * 报回来的 output 却只有个位到几十 —— 真实回复不可能这么短。阈值取得很松，只求把
 * "长回复被记成 7 个 token" 这种量级的异常捞出来，不追求精确。
 *
 * 只判异常：调用方可据此打日志或隐藏不可靠 TPS，但不得改计费、token 或金额。
 */
export function detectOutputLag(
  deltas: readonly ModelUsageDeltaEntry[],
  requestId?: string,
): boolean {
  // A concise high-context reply is legitimate. Only the known Vertex request
  // family is evidence that this shape means deferred output settlement.
  if (!requestId?.startsWith('msg_vrtx_')) return false;
  const OUTPUT_FLOOR = 64;
  const INPUT_SIGNIFICANT = 10_000;
  return deltas.some((delta) => {
    const inputSide =
      delta.inputTokensDelta + delta.cacheReadTokensDelta + delta.cacheCreateTokensDelta;
    return inputSide >= INPUT_SIGNIFICANT && delta.outputTokensDelta < OUTPUT_FLOOR;
  });
}

/**
 * Suppresses generation timing for both the turn where output settlement is
 * visibly late and the following turn where the missing output is expected to
 * be backfilled. Token/cost accounting remains untouched.
 */
export class ClaudeOutputLagTimingGuard {
  private readonly suppressCurrentTurnBySession = new Set<string>();
  private readonly detectedInCurrentTurnBySession = new Set<string>();

  evaluate(
    sessionId: string,
    deltas: readonly ModelUsageDeltaEntry[],
    isProductTurnFinal: boolean,
    requestId?: string,
    allowDetection = true,
  ): { detected: boolean; suppressTiming: boolean } {
    const detected = allowDetection && detectOutputLag(deltas, requestId);
    if (detected) this.detectedInCurrentTurnBySession.add(sessionId);
    const suppressTiming =
      this.suppressCurrentTurnBySession.has(sessionId) ||
      this.detectedInCurrentTurnBySession.has(sessionId);
    if (isProductTurnFinal) {
      if (this.detectedInCurrentTurnBySession.has(sessionId)) {
        this.suppressCurrentTurnBySession.add(sessionId);
      } else {
        this.suppressCurrentTurnBySession.delete(sessionId);
      }
      this.detectedInCurrentTurnBySession.delete(sessionId);
    }
    return {
      detected,
      suppressTiming,
    };
  }

  clear(sessionId: string): void {
    this.suppressCurrentTurnBySession.delete(sessionId);
    this.detectedInCurrentTurnBySession.delete(sessionId);
  }
}
