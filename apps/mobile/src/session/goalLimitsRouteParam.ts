/**
 * goalLimitsRouteParam —— 新建页 goal.set 失败接回的 limits 路由参数解析(**纯逻辑,零 react-native**)。
 *
 * 新建页把原 Goal 输入经路由参数带到目标页(codex review P2):objective 原样、
 * limits JSON 序列化。本文件负责把 `goalLimits` 字符串严格解析回
 * `MobileGoalLimitsInput`,供 [sessionId].tsx 预填 Goal 表单。
 *
 * 严格规则(独立审核者 P2):只接受非数组普通对象;字段必须为 `null` 或
 * **有限正整数**(maxTurns / noProgressLimit 为轮数、budgetTokens 为 token 数,
 * host goal.set 拒绝 0 / 负数 / 小数 / 1e999 的 Infinity);任一字段非法 →
 * **忽略整个 limits 返回 undefined**(而不是改写为 null——改写会让
 * limitsTouched=true,重试时显式提交「全部无限」覆盖被控端默认
 * noProgressLimit:3)。
 */
import type { MobileGoalLimitsInput } from '@cindy/maker-shared/device-link-contract';

const isFinitePositiveInteger = (v: unknown): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v > 0;

export function parseGoalLimitsRouteParam(
  raw: string | null | undefined,
): MobileGoalLimitsInput | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  // 空对象 = 没有携带任何限制 → 整体忽略(等价于未传 limits,走被控端默认);
  // 部分字段缺失(undefined)与 null 同义 = 该项走被控端默认;其余必须有限正整数。
  if (!record.maxTurns && !record.budgetTokens && !record.noProgressLimit) return undefined;
  for (const key of ['maxTurns', 'budgetTokens', 'noProgressLimit'] as const) {
    const v = record[key];
    if (v !== undefined && v !== null && !isFinitePositiveInteger(v)) return undefined;
  }
  return {
    maxTurns: (record.maxTurns as number | null | undefined) ?? null,
    budgetTokens: (record.budgetTokens as number | null | undefined) ?? null,
    noProgressLimit: (record.noProgressLimit as number | null | undefined) ?? null,
  };
}
