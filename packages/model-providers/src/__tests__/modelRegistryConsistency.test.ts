import { describe, expect, it } from "vitest";

import modelRegistryJson from "../../catalog/model-registry.json" with { type: "json" };
import type {
  ModelAgent,
  ModelRegistry,
  ModelRegistryEntry,
  ModelRegistryRoute,
  ModelReferencePrice,
} from "@cindy/model-access-protocol";

/**
 * model-registry.json 数据自一致性门禁(#1429 跟进)。
 *
 * 背景:声明窗口与路由真实上限脱节时,SDK 内部与 host 侧两层 auto-compact 的阈值
 * 都建立在错误分母上,会话会一路冲到上游硬顶被 400 拒绝(context_length_exceeded),
 * 然后进入"超限 → 无 usage → 不压缩 → 重试再超限"的自锁。Registry 没有 route 级
 * 窗口字段,真实上限只能靠数据维护纪律保证 —— 本测试把 registry **内部**可判定的
 * 矛盾挡在 CI:窗口上调 / 价档修订(#909、#1189 同类改动)引入的结构性错误在
 * 合入前暴露,而不是等用户撞 400。
 *
 * 判定语义与 modelRegistry.ts 的价档选择一致:band 覆盖 [minInputTokens ?? 0,
 * maxInputTokens) —— max 为排他上界(`inputTokens >= max` 不命中)。
 */

const registry = modelRegistryJson as unknown as ModelRegistry;

function effectiveWindow(
  entry: ModelRegistryEntry,
  agent: ModelAgent,
): number | undefined {
  return entry.perAgent?.[agent]?.contextWindow ?? entry.contextWindow;
}

/** 按 (currency, variant, effectiveFrom) 分组 —— 组内 band 构成一条完整价格轴。 */
function bandGroups(route: ModelRegistryRoute): ModelReferencePrice[][] {
  const groups = new Map<string, ModelReferencePrice[]>();
  for (const price of route.referencePrices ?? []) {
    const key = `${price.currency}|${price.variant}|${price.effectiveFrom}`;
    const group = groups.get(key);
    if (group) group.push(price);
    else groups.set(key, [price]);
  }
  return Array.from(groups.values()).map((group) =>
    group.slice().sort((a, b) => (a.minInputTokens ?? 0) - (b.minInputTokens ?? 0)),
  );
}

describe("model registry data consistency", () => {
  it("window / output declarations are positive and mutually sane", () => {
    for (const entry of registry.models) {
      if (entry.contextWindow !== undefined) {
        expect(entry.contextWindow, `${entry.id} contextWindow`).toBeGreaterThan(0);
      }
      if (entry.maxOutputTokens !== undefined) {
        expect(entry.maxOutputTokens, `${entry.id} maxOutputTokens`).toBeGreaterThan(0);
      }
      if (entry.contextWindow !== undefined && entry.maxOutputTokens !== undefined) {
        expect(
          entry.maxOutputTokens,
          `${entry.id}: maxOutputTokens exceeds contextWindow`,
        ).toBeLessThanOrEqual(entry.contextWindow);
      }
      for (const [agent, override] of Object.entries(entry.perAgent ?? {})) {
        if (override?.contextWindow === undefined) continue;
        expect(
          override.contextWindow,
          `${entry.id} perAgent.${agent}.contextWindow`,
        ).toBeGreaterThan(0);
        if (entry.maxOutputTokens !== undefined) {
          expect(
            entry.maxOutputTokens,
            `${entry.id}: maxOutputTokens exceeds perAgent.${agent}.contextWindow`,
          ).toBeLessThanOrEqual(override.contextWindow);
        }
      }
    }
  });

  it("price bands tile the input axis without gaps or overlaps", () => {
    for (const entry of registry.models) {
      for (const route of entry.routes) {
        for (const group of bandGroups(route)) {
          const label = `${entry.id} @ ${route.providerId}`;
          // 第一条必须从 0 起 —— 否则低输入段无价可循
          expect(group[0]!.minInputTokens ?? 0, `${label}: first band must start at 0`).toBe(0);
          for (let i = 1; i < group.length; i += 1) {
            const prev = group[i - 1]!;
            const cur = group[i]!;
            // 相邻 band 首尾相接(max 排他 = 下一条的 min):留缝 = 区间无价,
            // 重叠 = 命中歧义(排序副作用决定价格)
            expect(
              prev.maxInputTokens,
              `${label}: band boundary gap/overlap at ${cur.minInputTokens}`,
            ).toBe(cur.minInputTokens);
          }
        }
      }
    }
  });

  it("every tier boundary is reachable by at least one agent's declared window", () => {
    // band 起点 ≥ 该路由所有 agent 的声明窗口 = 这条价档永不可达,
    // 说明窗口或价档必有一边写错(#1429 的窗口下调修正会先撞到这里)。
    for (const entry of registry.models) {
      for (const route of entry.routes) {
        for (const group of bandGroups(route)) {
          for (const band of group) {
            const lo = band.minInputTokens ?? 0;
            if (lo === 0) continue;
            const reachable = route.agents.some((agent) => {
              const window = effectiveWindow(entry, agent);
              return window === undefined || window > lo;
            });
            expect(
              reachable,
              `${entry.id} @ ${route.providerId}: band starting at ${lo} is unreachable for every agent window`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("declared windows never extend past the priced input range", () => {
    // 顶档封了上界(maxInputTokens)而某 agent 窗口声明超出 = 超出段没有任何参考价,
    // 要么窗口虚高(#1429 主形态),要么漏了长上下文价档 —— 两者都必须在数据层修。
    for (const entry of registry.models) {
      for (const route of entry.routes) {
        for (const group of bandGroups(route)) {
          const top = group[group.length - 1]!;
          if (top.maxInputTokens === undefined) continue;
          for (const agent of route.agents) {
            const window = effectiveWindow(entry, agent);
            if (window === undefined) continue;
            expect(
              window,
              `${entry.id} @ ${route.providerId} (${agent}): window ${window} exceeds priced range ${top.maxInputTokens}`,
            ).toBeLessThanOrEqual(top.maxInputTokens);
          }
        }
      }
    }
  });
});
