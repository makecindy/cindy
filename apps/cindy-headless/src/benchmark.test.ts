import { describe, expect, it } from 'vitest';
import { createEvaluationReport, expandPairedPlan, expandPlan, freezeHard30, schedulePlan, shouldRetry, shouldStop, summarizePairedResults, validateManifest, validateOracleGate, validatePairedManifest } from './benchmark.js';

const manifest = { schemaVersion: 1, board: 'same-model-harness', dataset: { name: 'terminal-bench/terminal-bench-2-1', revision: '6', taskIds: ['e', 'd', 'c', 'b', 'a'] }, modelIds: ['model-1'], repetitions: 2, variants: [{ id: 'raw', supportedModelIds: ['model-1'] }, { id: 'cindy', supportedModelIds: ['model-1'] }], seed: 127 } as const;

describe('benchmark plan', () => {
  it('expands the full variant x model x task x repetition matrix', () => expect(expandPlan(validateManifest(manifest)).cells).toHaveLength(20));
  it('rejects unsupported same-model cells', () => expect(() => validateManifest({ ...manifest, variants: [{ id: 'raw', supportedModelIds: [] }] })).toThrow(/unsupported/));
  it('requires all sorted first-five Oracle rewards to pass', () => {
    const results = ['a', 'b', 'c', 'd', 'e'].map((taskId) => ({ taskId, reward: 1 }));
    expect(validateOracleGate([...manifest.dataset.taskIds], results).ok).toBe(true);
    expect(() => validateOracleGate([...manifest.dataset.taskIds], results.slice(1))).toThrow(/a/);
  });
  it('expands paired cells with a stable pair id and two arms', () => {
    const plan = expandPairedPlan(validatePairedManifest(validateManifest(manifest)));
    expect(plan.cells).toHaveLength(20);
    expect(new Set(plan.cells.map((cell) => cell.pairId)).size).toBe(10);
    expect(plan.cells.filter((cell) => cell.pairId === JSON.stringify(['a', 'model-1', 1]))).toHaveLength(2);
    expect(plan.cells[0].cellId).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.cells[0].cellId).toBe(expandPairedPlan(validatePairedManifest(validateManifest(manifest))).cells[0].cellId);
  });
  it('summarizes complete, incomplete and asymmetric pairs plus usage', () => {
    const summary = summarizePairedResults([
      { variantId: 'raw', armIndex: 0, modelId: 'model-1', taskId: 'a', repetition: 1, reward: 1, costUsd: 0.1, inputTokens: 10, cacheTokens: 2, outputTokens: 5 },
      { variantId: 'cindy', armIndex: 1, modelId: 'model-1', taskId: 'a', repetition: 1, reward: 1, costUsd: 0.2, inputTokens: 11, cacheTokens: 3, outputTokens: 6 },
      { variantId: 'raw', armIndex: 0, modelId: 'model-1', taskId: 'b', repetition: 1, reward: 1 },
      { variantId: 'cindy', armIndex: 1, modelId: 'model-1', taskId: 'b', repetition: 1, reward: 0 },
      { variantId: 'raw', armIndex: 0, modelId: 'model-1', taskId: 'c', repetition: 1, reward: 0, resultClass: 'FAILED_AGENT', benchmark: 'terminal-bench', durationMs: 12, upstreamProvider: 'anthropic' },
    ]);
    expect(summary).toMatchObject({ pairCount: 3, completePairCount: 2, incompletePairCount: 1, bothPass: 1, bothFail: 0, firstArmOnlyPass: 1, secondArmOnlyPass: 0, totalInputTokens: 21, totalCacheTokens: 5, totalOutputTokens: 11 });
    expect(summary.totalCostUsd).toBeNull();
    expect(summary.knownCostUsd).toBeCloseTo(0.3);
    expect(summary.costKnownCount).toBe(2);
    expect(summary.costMissingCount).toBe(3);
    expect(summary.byAgent.raw.trials).toBe(3);
    expect(summary.resultClasses.FAILED_AGENT).toBe(1);
    expect(summary.upstreamProviders.anthropic).toBe(1);
    expect(summary.totalDurationMs).toBe(12);
    expect(summary.usageCompleteness).toEqual({ exact: 0, 'lower-bound': 0, incomplete: 5 });
  });
  it('rejects manifests that do not define exactly two paired arms', () => expect(() => validatePairedManifest(validateManifest({ ...manifest, variants: [{ id: 'only', supportedModelIds: ['model-1'] }] }))).toThrow(/exactly two/));
  it('creates a reproducible interleaved schedule and enforces retry/stop policy', () => {
    const configured = validateManifest({ ...manifest, retry: { agent: 0, infra: 1 }, budget: { maxCostUsd: 1, stopAfterFailures: 2 } });
    const cells = expandPlan(configured).cells;
    expect(schedulePlan(cells, configured).map((cell) => cell.cellId)).toEqual(schedulePlan(cells, configured).map((cell) => cell.cellId));
    expect(shouldRetry('ERRORED_INFRA', 1, configured).retry).toBe(true);
    expect(shouldRetry('FAILED_AGENT', 1, configured).retry).toBe(false);
    expect(shouldStop([{ ...results('a'), resultClass: 'FAILED_AGENT' }, { ...results('b'), resultClass: 'ERRORED_INFRA' }], configured).stop).toBe(true);
    expect(shouldStop([{ ...results('a') }], configured)).toMatchObject({ stop: true, reason: 'cost-unknown' });
    expect(shouldStop([{ ...results('a'), costUsd: 1 }], configured)).toMatchObject({ stop: true, reason: 'cost-limit' });
  });
  it('creates an auditable report and freezes hard-30 only from independent history', () => {
    const report = createEvaluationReport(validateManifest(manifest), [{ ...results('a'), reward: 1, resultClass: 'PASSED', benchmark: 'tb' }]);
    expect(report.trialCount).toBe(1);
    expect(report.schemaVersion).toBe(2);
    expect(report.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(report.totals).toMatchObject({ costUsd: null, knownCostUsd: 0, costKnownCount: 0, costMissingCount: 1 });
    expect(() => freezeHard30([{ taskId: 'only', solveRate: 0.1 }])).toThrow(/independent/);
    const frozen = freezeHard30(Array.from({ length: 30 }, (_, i) => ({ taskId: `task-${i}`, solveRate: i / 30 })));
    expect(frozen.taskIds).toHaveLength(30);
    expect(frozen.taskListDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});

function results(taskId: string) { return { variantId: 'raw', modelId: 'model-1', taskId, repetition: 1, reward: 0 }; }


describe('benchmark report input validation', () => {
  it.each([
    { taskId: 'outside' }, { modelId: 'outside' }, { variantId: 'outside' },
    { repetition: 0 }, { repetition: 3 }, { repetition: 1.5 },
    { armIndex: 1 }, { armIndex: -1 }, { reward: -0.1 }, { reward: 1.1 },
    { reward: Number.NaN }, { reward: Number.POSITIVE_INFINITY }, { costUsd: -1 },
    { inputTokens: Number.NaN }, { durationMs: -1 },
  ])('rejects a malformed or foreign result cell: %j', (change) => {
    expect(() => createEvaluationReport(validateManifest(manifest), [{ ...results('a'), ...change }])).toThrow();
  });
  it('rejects duplicate trials and conflicting arm ownership before aggregation', () => {
    expect(() => createEvaluationReport(validateManifest(manifest), [results('a'), results('a')])).toThrow(/duplicate result cell/);
    expect(() => summarizePairedResults([{ ...results('a'), armIndex: 0 }, { ...results('a'), variantId: 'cindy', armIndex: 0 }])).toThrow(/conflicting result arms/);
    expect(() => summarizePairedResults([{ ...results('a'), armIndex: 0 }, { ...results('b'), armIndex: 1 }])).toThrow(/conflicting result arms/);
  });
  it('assigns omitted arms from manifest order without mutating input', () => {
    const input = [{ ...results('a'), variantId: 'cindy', reward: 0 }, { ...results('a'), reward: 1 }];
    const report = createEvaluationReport(validateManifest(manifest), input);
    expect(report.paired).toMatchObject({ completePairCount: 1, firstArmOnlyPass: 1, secondArmOnlyPass: 0 });
    expect(input[0]).not.toHaveProperty('armIndex');
  });
  it('rejects unsupported product-board cells and does not invent pairs across three variants', () => {
    const product = validateManifest({ ...manifest, board: 'default-model-product', variants: [{ id: 'raw', supportedModelIds: [] }] });
    expect(() => createEvaluationReport(product, [results('a')])).toThrow(/supported manifest cell/);
    const multi = validateManifest({ ...manifest, variants: [...manifest.variants, { id: 'third', supportedModelIds: ['model-1'] }] });
    const report = createEvaluationReport(multi, multi.variants.map((v) => ({ ...results('a'), variantId: v.id })));
    expect(report.trialCount).toBe(3);
    expect(report.paired).toMatchObject({ pairCount: 0, completePairCount: 0 });
  });
  it('keeps colon-containing pair keys distinct', () => {
    const rows = [{ ...results('a:b'), modelId: 'c' }, { ...results('a'), modelId: 'b:c' }];
    expect(summarizePairedResults(rows).pairCount).toBe(2);
  });
  it('supports reserved property names without corrupting counters', () => {
    const m = validateManifest({ ...manifest, variants: [{ id: '__proto__', supportedModelIds: ['model-1'] }] });
    const report = createEvaluationReport(m, [{ ...results('a'), variantId: '__proto__', benchmark: '__proto__' }]);
    expect(report.byAgent['__proto__'].trials).toBe(1);
    expect(report.byBenchmark['__proto__'].trials).toBe(1);
    expect(Object.prototype).not.toHaveProperty('trials');
  });
});
