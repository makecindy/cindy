/**
 * TurnUsageDetails — per-turn token/cache detail attached to the final assistant
 * message. Stored in messages.agent_meta so old DB schema stays unchanged.
 */

import {
  addCompatibleRegionalMoney,
  legacyUsdMoney,
  normalizeRegionalMoney,
  type RegionalMoney,
} from './regionalMoney.js';

export interface TurnUsageDetails {
  /** 新输入 token：未命中缓存、按输入价计费的部分。 */
  inputTokens: number;
  /** 输出 token：Codex 路径沿用现有口径，包含 reasoning 合并量。 */
  outputTokens: number;
  /** 从 prompt cache 读取的输入 token。 */
  cacheReadTokens: number;
  /** 写入 prompt cache 的输入 token。 */
  cacheCreateTokens: number;
  /** 展示用总 token：input + output + cacheRead + cacheCreate。 */
  totalTokens: number;
  /** 可证明的纯模型生成耗时；不含工具执行/用户等待，用于计算输出速率。 */
  durationMs?: number;
  /** 整轮 wall-clock 耗时，仅供诊断展示；绝不用于计算输出速率。 */
  turnDurationMs?: number;
  /** cacheRead / (input + cacheRead + cacheCreate)，无输入分母时为 null。 */
  cacheHitRate: number | null;
  /** 本轮主要模型；能确定时填写。 */
  model?: string;
  /** 本轮涉及多个模型时的分桶列表。 */
  models?: string[];
  /**
   * 本轮按模型拆分的费用 (model 已归一化为裸 id)。仅 claude-code 主路径有
   * (来自 resolveClaudeTurnCostSinks 的 perModel)，含 subagent (如 Task 工具
   * 跑的 Haiku) —— tooltip 据此展示「按模型成本明细」。老消息无此字段。
   */
  perModelCost?: Array<{ model: string; money: RegionalMoney }>;
}

export interface BuildTurnUsageDetailsInput {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  model?: string | null;
  models?: Array<string | null | undefined> | readonly (string | null | undefined)[];
  perModelCost?: ReadonlyArray<
    | {
        model?: string | null;
        money?: RegionalMoney | null;
        /** 旧消息兼容：历史事实始终是 USD。 */
        costUsd?: number | null;
      }
    | null
    | undefined
  >;
  durationMs?: number;
  turnDurationMs?: number;
}

function sanitizeToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function sanitizeDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function sanitizeModel(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function uniqueModels(models: BuildTurnUsageDetailsInput['models']): string[] | undefined {
  if (!models) return undefined;
  const out: string[] = [];
  for (const model of models) {
    const normalized = sanitizeModel(model);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 清洗按模型费用列表：丢弃空 model / 非正 / 非有限 cost；同模型出现多次时累加。
 * 全部无效返回 undefined（与其它字段「缺省即不挂」一致）。
 */
function sanitizePerModelCost(
  list: BuildTurnUsageDetailsInput['perModelCost'],
): Array<{ model: string; money: RegionalMoney }> | undefined {
  if (!list || !Array.isArray(list)) return undefined;
  const byModel = new Map<string, RegionalMoney>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const model = sanitizeModel(item.model);
    const structured = normalizeRegionalMoney(item.money);
    const legacy =
      typeof item.costUsd === 'number' && Number.isFinite(item.costUsd) && item.costUsd > 0
        ? legacyUsdMoney(item.costUsd)
        : undefined;
    const money = structured ?? legacy;
    if (!model || !money || money.amount <= 0) continue;
    const current = byModel.get(model);
    byModel.set(
      model,
      current
        ? (addCompatibleRegionalMoney([current, money]) ?? money)
        : money,
    );
  }
  return byModel.size > 0
    ? [...byModel.entries()].map(([model, money]) => ({
        model,
        money,
      }))
    : undefined;
}

/**
 * 合并同一用户轮里多个 SDK segment 的用量明细。
 *
 * Claude Code 的一次可见回答可能跨多个 SDK segment（例如并行 Task/
 * subagent 先后结束）。金额账本按 segment 保存，但 tooltip 需要把 token、模型
 * 和按模型成本投影成同一轮，避免只展示最后一个 segment 而藏掉子 agent。
 */
export function aggregateTurnUsageDetails(
  detailsList: readonly (TurnUsageDetails | null | undefined)[],
): TurnUsageDetails | null {
  const details = detailsList.filter(
    (item): item is TurnUsageDetails =>
      Boolean(item && (item.totalTokens > 0 || item.turnDurationMs !== undefined)),
  );
  if (details.length === 0) return null;

  const modelNames: string[] = [];
  const addModel = (model: string | undefined) => {
    if (model && !modelNames.includes(model)) modelNames.push(model);
  };
  const perModel = new Map<string, RegionalMoney>();
  for (const detail of details) {
    addModel(detail.model);
    for (const model of detail.models ?? []) addModel(model);
    for (const item of detail.perModelCost ?? []) {
      const current = perModel.get(item.model);
      perModel.set(
        item.model,
        current
          ? (addCompatibleRegionalMoney([current, item.money]) ?? item.money)
          : item.money,
      );
    }
  }

  // TPS is only meaningful when every segment that contributes output tokens
  // also contributes a compatible generation duration. Dividing all output by
  // a partial duration silently inflates the displayed rate.
  const hasCompleteOutputTiming = details.every(
    (detail) => detail.outputTokens <= 0 || detail.durationMs !== undefined,
  );
  const durationMs = hasCompleteOutputTiming
    ? details.reduce(
        (sum, item) => sum + (item.outputTokens > 0 ? (item.durationMs ?? 0) : 0),
        0,
      ) || undefined
    : undefined;
  // Intermediate Claude continuation segments can carry their own SDK duration,
  // while the final segment carries the full outer product-turn wall clock.
  // Taking the maximum preserves that complete value without double-counting.
  const turnDurationMs =
    details.reduce((max, item) => Math.max(max, item.turnDurationMs ?? 0), 0) || undefined;

  return buildTurnUsageDetails({
    inputTokens: details.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: details.reduce((sum, item) => sum + item.outputTokens, 0),
    cacheReadTokens: details.reduce((sum, item) => sum + item.cacheReadTokens, 0),
    cacheCreateTokens: details.reduce((sum, item) => sum + item.cacheCreateTokens, 0),
    durationMs,
    turnDurationMs,
    model: modelNames.length === 1 ? modelNames[0] : undefined,
    models: modelNames,
    perModelCost: [...perModel.entries()].map(([model, money]) => ({ model, money })),
  });
}

/**
 * Preserve a later complete product-turn wall clock without replacing the
 * token facts already attached to the same assistant message. Full usage
 * snapshots remain replacement/idempotent rather than being summed twice.
 */
export function mergeTurnUsageDetailsForMessage(
  existing: TurnUsageDetails | null | undefined,
  incoming: TurnUsageDetails,
): TurnUsageDetails {
  if (!existing) return incoming;
  // A continuation can finish without assistant output while still charging
  // input/cache tokens. That segment reuses the prior assistant message, so it
  // must extend the existing user-turn aggregate rather than replace the
  // output tokens and generation duration already attached to that message.
  if (incoming.outputTokens <= 0 && existing.outputTokens > 0) {
    return aggregateTurnUsageDetails([existing, incoming]) ?? incoming;
  }
  const turnDurationMs = Math.max(existing.turnDurationMs ?? 0, incoming.turnDurationMs ?? 0);
  const base = incoming.totalTokens > 0 ? incoming : existing.totalTokens > 0 ? existing : incoming;
  return {
    ...base,
    ...(turnDurationMs > 0 ? { turnDurationMs } : {}),
  };
}

/**
 * Build a normalized usage detail object. A positive product-turn duration is
 * retained even when the terminal SDK segment contributes no tokens.
 */
export function buildTurnUsageDetails(input: BuildTurnUsageDetailsInput): TurnUsageDetails | null {
  const inputTokens = sanitizeToken(input.inputTokens);
  const outputTokens = sanitizeToken(input.outputTokens);
  const cacheReadTokens = sanitizeToken(input.cacheReadTokens);
  const cacheCreateTokens = sanitizeToken(input.cacheCreateTokens);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens;
  const durationMs = sanitizeDuration(input.durationMs);
  const turnDurationMs = sanitizeDuration(input.turnDurationMs);
  if (totalTokens <= 0 && turnDurationMs === undefined) return null;

  const cacheDenominator = inputTokens + cacheReadTokens + cacheCreateTokens;
  const cacheHitRate = cacheDenominator > 0 ? cacheReadTokens / cacheDenominator : null;
  const model = sanitizeModel(input.model);
  const models = uniqueModels(input.models);
  const perModelCost = sanitizePerModelCost(input.perModelCost);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    totalTokens,
    cacheHitRate,
    ...(durationMs ? { durationMs } : {}),
    ...(turnDurationMs ? { turnDurationMs } : {}),
    ...(model ? { model } : {}),
    ...(models ? { models } : {}),
    ...(perModelCost ? { perModelCost } : {}),
  };
}

/** Parse persisted / IPC data defensively before exposing it to renderer state. */
export function normalizeTurnUsageDetails(value: unknown): TurnUsageDetails | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return (
    buildTurnUsageDetails({
      inputTokens: typeof raw.inputTokens === 'number' ? raw.inputTokens : undefined,
      outputTokens: typeof raw.outputTokens === 'number' ? raw.outputTokens : undefined,
      cacheReadTokens: typeof raw.cacheReadTokens === 'number' ? raw.cacheReadTokens : undefined,
      cacheCreateTokens:
        typeof raw.cacheCreateTokens === 'number' ? raw.cacheCreateTokens : undefined,
      model: typeof raw.model === 'string' ? raw.model : undefined,
      models: Array.isArray(raw.models)
        ? raw.models.filter((m): m is string => typeof m === 'string')
        : undefined,
      durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : undefined,
      turnDurationMs: typeof raw.turnDurationMs === 'number' ? raw.turnDurationMs : undefined,
      perModelCost: Array.isArray(raw.perModelCost)
        ? raw.perModelCost.map((e) =>
            e && typeof e === 'object'
              ? {
                  model: (e as Record<string, unknown>).model as string | null | undefined,
                  money: (e as Record<string, unknown>).money as RegionalMoney | null | undefined,
                  costUsd: (e as Record<string, unknown>).costUsd as number | null | undefined,
                }
              : null,
          )
        : undefined,
    }) ?? undefined
  );
}
