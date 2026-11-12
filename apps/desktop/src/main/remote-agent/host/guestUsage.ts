/**
 * 受邀者(供应商分享)在本机运行的 Agent 用量：优先读取请求级累计回执，旧运行时从 `done` 事件取每轮 token。
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
  let receiptEpoch: string | null = null;
  let receipts = new Map<string, GuestUsageSample>();
  let claudeBaseline: Map<string, ModelUsageCumulative> | undefined;
  const claudePending = new Map<string, GuestUsageSample>();

  return {
    observe(event: AgentEvent, currentModel: string): GuestUsageSample[] {
      if (event.type !== 'done' && event.type !== 'status') return [];
      const data = record(event.data);
      const fallbackModel = currentModel || 'unknown';
      const cumulative = record(data?.requestUsage);
      const liveSamples: GuestUsageSample[] = [];
      if (typeof cumulative?.epoch === 'string' && Array.isArray(cumulative.models)) {
        if (cumulative.epoch !== receiptEpoch) {
          receiptEpoch = cumulative.epoch;
          receipts = new Map();
          claudeBaseline = undefined;
          claudePending.clear();
        }
        const samples: GuestUsageSample[] = [];
        for (const raw of cumulative.models.slice(0, 4096)) {
          const row = record(raw);
          if (!row) continue;
          // Missing model identity is not relabelled as the current model after a switch.
          const model = typeof row.model === 'string' && row.model ? row.model : 'unknown';
          const previous = receipts.get(model) ?? empty(model);
          const next = { ...empty(model), inputTokens: count(row.inputTokens), outputTokens: count(row.outputTokens),
            cacheReadTokens: count(row.cacheReadTokens), cacheCreateTokens: count(row.cacheCreateTokens) };
          const delta = { ...empty(model) };
          for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreateTokens'] as const) {
            delta[key] = Math.max(0, next[key] - previous[key]);
            next[key] = Math.max(next[key], previous[key]);
          }
          receipts.set(model, next);
          if (delta.inputTokens || delta.outputTokens || delta.cacheReadTokens || delta.cacheCreateTokens) {
            samples.push(delta);
            if (kind === 'claude-code') {
              const pending = claudePending.get(model) ?? empty(model);
              for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreateTokens'] as const) pending[key] += delta[key];
              claudePending.set(model, pending);
            }
          }
        }
        if (kind !== 'claude-code' || event.type !== 'done') {
          if (event.type === 'done') samples.push({ ...empty(fallbackModel), turns: 1 });
          return samples;
        }
        liveSamples.push(...samples);
      }
      if (event.type !== 'done') return [];
      // New runtimes report receipts before terminal/cancellation events. Don't bill them twice.
      if ((kind === 'codex' || kind === 'pi') && receiptEpoch) return [{ ...empty(fallbackModel), turns: 1 }];
      if (kind === 'claude-code') {
        const modelUsage = record(data?.modelUsage);
        if (!modelUsage) return [...liveSamples, { ...empty(fallbackModel), turns: 1 }];
        // A first/resumed cumulative snapshot also settles already-emitted live
        // receipts, even when its historical tokens are deliberately not billed.
        const settlement = computeModelUsageDeltas(claudeBaseline, modelUsage, undefined, {
          cumulativeStartsAtZero: true,
        }).deltas;
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
        // Native Claude streams can precede the process-cumulative SDK receipt.
        // Settle only the unreported remainder, including child models absent from the stream.
        for (const settled of settlement) {
          const pending = claudePending.get(settled.model);
          if (!pending) continue;
          const sample = samples.find(item => item.model === settled.model);
          const coverage = { inputTokens: settled.inputTokensDelta, outputTokens: settled.outputTokensDelta,
            cacheReadTokens: settled.cacheReadTokensDelta, cacheCreateTokens: settled.cacheCreateTokensDelta };
          for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreateTokens'] as const) {
            const covered = Math.min(coverage[key], pending[key]);
            if (sample) sample[key] = Math.max(0, sample[key] - covered);
            pending[key] -= covered;
          }
          if (!(pending.inputTokens || pending.outputTokens || pending.cacheReadTokens || pending.cacheCreateTokens)) claudePending.delete(settled.model);
        }
        // 一轮只算一次，记在输出最多的模型上(子 Agent 用的小模型不重复计轮次)。
        const primary = samples.reduce<GuestUsageSample | null>(
          (best, sample) => (!best || sample.outputTokens > best.outputTokens ? sample : best),
          null,
        );
        if (primary) primary.turns = 1;
        else samples.push({ ...empty(fallbackModel), turns: 1 });
        return [...liveSamples, ...samples];
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
