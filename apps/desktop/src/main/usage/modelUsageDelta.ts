/**
 * modelUsageDelta — Claude SDK modelUsage 累计值 → per-turn delta 的纯函数。
 *
 * 背景: Claude SDK done 事件的 `modelUsage: Record<model, ModelUsage>` 与
 * `total_cost_usd` 同语义 — 都是**子进程内累计**, 不是 per-turn。要写入
 * daily_model_usage 表必须 cumulative - lastReported (与 register.ts 的
 * lastReportedCostUsdBySession 同款手法)。
 *
 * 钳制: 子进程重 spawn (resume / 崩溃重启) 后累计值归零, delta 会算出负数 —
 * 一律 Math.max(0, ...) 钳到 0 (接受少记一个 turn 的取舍, 与 total_cost_usd 一致)。
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
    const base = reset || last === undefined
      ? { costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
      : last;

    const entry: ModelUsageDeltaEntry = {
      model,
      costUsdDelta: Math.max(0, cum.costUSD - base.costUSD),
      inputTokensDelta: Math.max(0, cum.inputTokens - base.inputTokens),
      outputTokensDelta: Math.max(0, cum.outputTokens - base.outputTokens),
      cacheReadTokensDelta: Math.max(0, cum.cacheReadInputTokens - base.cacheReadInputTokens),
      cacheCreateTokensDelta: Math.max(0, cum.cacheCreationInputTokens - base.cacheCreationInputTokens),
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
