/**
 * 受邀者(供应商分享)在本机运行的 Agent 用量：从 `done` 事件取每一轮的 token。
 *  - Claude 的 modelUsage 是同一个 SDK 进程内的累计值，按任务实例保存基线后求增量；
 *  - Codex、Pi 的 usage 已是本轮增量，模型取当前会话模型。
 * 纯函数，不落盘；落盘与按分享汇总在 device-link/providerShareUsageStore。
 */
import type { AgentEvent } from '@cindy/maker-core';

import { computeModelUsageDeltas, type ModelUsageCumulative } from '../../usage/modelUsageDelta';

export interface GuestUsageSample {
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** Claude SDK 按 API 单价给出的金额(美元)；其它 Agent 没有，查询时按本地单价估算。 */
  sdkCostUsd: number;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function empty(model: string): GuestUsageSample {
  return { model, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0 };
}

/** 一个任务实例一个计量器(Claude 的累计基线跟着 SDK 进程走)。 */
export function createGuestUsageMeter(kind: string) {
  let claudeBaseline: Map<string, ModelUsageCumulative> | undefined;

  return {
    observe(event: AgentEvent, currentModel: string): GuestUsageSample[] {
      if (event.type !== 'done') return [];
      const data = record(event.data);
      const fallbackModel = currentModel || 'unknown';
      if (kind === 'claude-code') {
        const modelUsage = record(data?.modelUsage);
        if (!modelUsage) return [{ ...empty(fallbackModel), turns: 1 }];
        const { next, deltas } = computeModelUsageDeltas(claudeBaseline, modelUsage, undefined, {
          cumulativeStartsAtZero: data?.modelUsageCumulativeStartsAtZero === true,
        });
        claudeBaseline = next;
        const samples = deltas.map((delta) => ({
          model: delta.model,
          turns: 0,
          inputTokens: delta.inputTokensDelta,
          outputTokens: delta.outputTokensDelta,
          cacheReadTokens: delta.cacheReadTokensDelta,
          cacheCreateTokens: delta.cacheCreateTokensDelta,
          sdkCostUsd: delta.costUsdDelta,
        }));
        // 一轮只算一次，记在输出最多的模型上(子 Agent 用的小模型不重复计轮次)。
        const primary = samples.reduce<GuestUsageSample | null>(
          (best, sample) => (!best || sample.outputTokens > best.outputTokens ? sample : best),
          null,
        );
        if (primary) primary.turns = 1;
        else samples.push({ ...empty(fallbackModel), turns: 1 });
        return samples;
      }
      const usage = record(data?.usage);
      const sample = { ...empty(fallbackModel), turns: 1 };
      if (usage) {
        // Codex: promptTokens / completionTokens / cachedTokens；Pi: inputTokens / outputTokens / cacheReadTokens。
        sample.inputTokens = count(usage.promptTokens) || count(usage.inputTokens);
        sample.outputTokens = count(usage.completionTokens) || count(usage.outputTokens);
        sample.cacheReadTokens = count(usage.cachedTokens) || count(usage.cacheReadTokens);
        sample.cacheCreateTokens = count(usage.cacheCreationTokens);
      }
      return [sample];
    },
  };
}
