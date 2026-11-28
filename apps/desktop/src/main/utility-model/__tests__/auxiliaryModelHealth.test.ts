/**
 * Auxiliary-model health: when the user is told that no auxiliary model can run.
 *
 * 测试价值
 * - 生产入口与可观察结果：createAuxiliaryModelHealthTracker 的 get / reportChainOutcome /
 *   reportPluginFallback 返回的状态与 notify 次数（= 设置页卡片与一次性提示）；
 *   evaluateAuxiliaryChainAvailability 对每个候选给出的原因。
 * - Bug／规则依据：docs/product-rules/auxiliary-model-health.md。2026-11-18 起 Cindy AI 被停用，
 *   自动推荐链全部失效却只记日志，字幕翻译悄悄退回 xhigh 默认模型。
 * - 现有覆盖缺口：此前没有任何「全部候选不可用」的用户可见状态。
 * - 最小失败输入：xd 供应商在停用名单里 + 一次 no_candidate 请求。
 * - tier：unit（纯函数与注入依赖，无 Electron、无 I/O）。
 */

import { describe, expect, it } from 'vitest';
import type { Catalog, CatalogModel, Provider } from '@cindy/model-providers';

import { AUTO_AUXILIARY_MODEL_CHAIN } from '../../../shared/auxiliaryModelChain';
import { evaluateAuxiliaryChainAvailability, type AuxiliaryChainCandidateStatus } from '../auxiliaryChainAvailability';
import { AUXILIARY_RUNTIME_FAILURE_THRESHOLD, createAuxiliaryModelHealthTracker } from '../auxiliaryModelHealth';

function harness(initial: AuxiliaryChainCandidateStatus[]) {
  let statuses = initial;
  let owner = 'owner-a';
  let notified = 0;
  const tracker = createAuxiliaryModelHealthTracker({
    evaluate: () => statuses,
    notify: () => { notified += 1; },
    now: () => 1_000,
    ownerKey: () => owner,
  });
  return {
    tracker,
    setStatuses: (next: AuxiliaryChainCandidateStatus[]) => { statuses = next; },
    setOwner: (next: string) => { owner = next; },
    notified: () => notified,
  };
}

const broken: AuxiliaryChainCandidateStatus[] = [
  { ref: 'a', label: 'A · Cindy AI', issue: 'provider_disabled' },
  { ref: 'b', label: 'B · Cindy AI', issue: 'provider_disabled' },
];
const fixed: AuxiliaryChainCandidateStatus[] = [
  { ref: 'a', label: 'A · Cindy AI', issue: null },
  { ref: 'b', label: 'B · Cindy AI', issue: null },
];

describe('auxiliary model health tracker', () => {
  it('reports a configuration problem at the first request that finds no candidate, and only once', () => {
    const h = harness(broken);
    h.tracker.reportChainOutcome('no_candidate');
    expect(h.tracker.get()).toEqual({
      status: 'unavailable',
      kind: 'config',
      candidates: [
        { ref: 'a', label: 'A · Cindy AI', issue: 'provider_disabled' },
        { ref: 'b', label: 'B · Cindy AI', issue: 'provider_disabled' },
      ],
      since: 1_000,
    });
    h.tracker.reportChainOutcome('no_candidate');
    expect(h.notified()).toBe(1);
  });

  it('never raises a problem from a read alone (the catalog may still be loading at startup)', () => {
    const h = harness(broken);
    expect(h.tracker.get()).toEqual({ status: 'ok' });
    expect(h.notified()).toBe(0);
  });

  it('clears a configuration problem on the next read once the settings are fixed', () => {
    const h = harness(broken);
    h.tracker.reportChainOutcome('no_candidate');
    h.setStatuses(fixed);
    expect(h.tracker.get()).toEqual({ status: 'ok' });
    expect(h.notified()).toBe(2);
  });

  it('stays silent for a few failed requests and reports from the threshold on, until a success', () => {
    const h = harness(fixed);
    for (let i = 1; i < AUXILIARY_RUNTIME_FAILURE_THRESHOLD; i += 1) h.tracker.reportChainOutcome('failed');
    expect(h.tracker.get()).toEqual({ status: 'ok' });
    h.tracker.reportChainOutcome('failed');
    h.tracker.reportChainOutcome('failed');
    expect(h.tracker.get()).toEqual({ status: 'unavailable', kind: 'runtime', since: 1_000 });
    expect(h.notified()).toBe(1);
    h.tracker.reportChainOutcome('success');
    expect(h.tracker.get()).toEqual({ status: 'ok' });
    // After a success the count starts over.
    h.tracker.reportChainOutcome('failed');
    expect(h.tracker.get()).toEqual({ status: 'ok' });
  });

  it('names the model plugin tasks fell back to, and starts over for another account', () => {
    const h = harness(broken);
    h.tracker.reportPluginFallback('GPT-6.2 Astra · OpenAI');
    expect(h.tracker.get()).toMatchObject({ status: 'unavailable', kind: 'config', fallbackModel: 'GPT-6.2 Astra · OpenAI' });
    h.setOwner('owner-b');
    expect(h.tracker.get()).toEqual({ status: 'ok' });
  });
});

function chat(id: string): CatalogModel {
  return { id, name: id, contextWindow: 200_000 } as CatalogModel;
}

const xd = {
  id: 'xd',
  name: 'xd',
  source: 'builtin',
  agents: ['codex', 'claude-code'],
  auth: { method: 'api-key' },
  routing: {
    codex: { upstream: 'https://up.example.com', authStrategy: 'api-key-header' },
    'claude-code': { upstream: 'https://up.example.com', authStrategy: 'api-key-header' },
  },
  models: {
    codex: [chat('deepseek/deepseek-v4-flash'), chat('tencent/hy3'), chat('qwen/qwen3.8-flash')],
    'claude-code': [],
  },
} as unknown as Provider;

describe('evaluateAuxiliaryChainAvailability', () => {
  const base = {
    refs: [...AUTO_AUXILIARY_MODEL_CHAIN],
    catalog: { providers: [xd] } as unknown as Catalog,
    hasCredential: () => true,
    isCindyAiPaymentRequired: () => false,
    cindyAiName: 'Cindy AI',
  };

  // Table: each user-fixable cause maps to the reason shown next to the candidate.
  it.each([
    ['usable', { overrides: undefined }, null],
    ['Cindy AI turned off (the 2026-11-18 incident)', { overrides: { disabledModels: {}, disabledProviders: { xd: true } } }, 'provider_disabled'],
    ['signed out of Cindy', { overrides: undefined, catalog: { providers: [] } as unknown as Catalog }, 'signed_out'],
    ['no credential', { overrides: undefined, hasCredential: () => false }, 'signed_out'],
    ['not covered by the plan', { overrides: undefined, isCindyAiPaymentRequired: () => true }, 'payment_required'],
  ] as const)('%s', (_name, patch, issue) => {
    const statuses = evaluateAuxiliaryChainAvailability({ ...base, ...patch });
    expect(statuses.map((status) => status.issue)).toEqual([issue, issue, issue]);
    expect(statuses[0]?.label).toBe('deepseek/deepseek-v4-flash · Cindy AI');
  });
});
