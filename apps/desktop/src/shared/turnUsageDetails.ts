/**
 * TurnUsageDetails — per-turn token/cache detail attached to the final assistant
 * message. Stored in messages.agent_meta so old DB schema stays unchanged.
 */

import { CURRENT_CINDY_REGION } from './brandRegion.js';
import {
  addCompatibleRegionalMoney,
  normalizeRegionalMoney,
  regionalCurrencyForRegion,
  regionalizeLegacyUsd,
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
}

function sanitizeToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
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
        ? regionalizeLegacyUsd(item.costUsd, CURRENT_CINDY_REGION)
        : undefined;
    const money = structured ?? legacy;
    if (!model || !money || money.amount <= 0) continue;
    const current = byModel.get(model);
    byModel.set(
      model,
      current
        ? (addCompatibleRegionalMoney(
            [current, money],
            regionalCurrencyForRegion(CURRENT_CINDY_REGION),
          ) ?? money)
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

/** Build a normalized usage detail object. Returns null when all token counts are 0. */
export function buildTurnUsageDetails(input: BuildTurnUsageDetailsInput): TurnUsageDetails | null {
  const inputTokens = sanitizeToken(input.inputTokens);
  const outputTokens = sanitizeToken(input.outputTokens);
  const cacheReadTokens = sanitizeToken(input.cacheReadTokens);
  const cacheCreateTokens = sanitizeToken(input.cacheCreateTokens);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens;
  if (totalTokens <= 0) return null;

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
