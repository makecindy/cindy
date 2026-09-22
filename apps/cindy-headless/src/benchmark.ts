import { readFile, writeFile } from 'node:fs/promises';
import { sha256 } from './profile.js';

export interface BenchmarkManifest {
  schemaVersion: 1;
  board: 'same-model-harness' | 'default-model-product';
  dataset: { name: string; revision: string; taskIds: string[] };
  modelIds: string[];
  repetitions: number;
  variants: Array<{ id: string; supportedModelIds: string[] }>;
  seed: number;
  concurrency?: number;
  agentOrder?: string[];
  runtime?: { timeoutMs?: number; cpu?: number; memoryMb?: number; network?: string; permissions?: string };
  retry?: { agent: 0; infra: 0 | 1 };
  budget?: { maxCostUsd?: number; stopAfterFailures?: number };
  throughputCap?: { outputTokensPerSecond: number; enabled: boolean };
}

export interface BenchmarkCell {
  cellId: string;
  variantId: string;
  modelId: string;
  taskId: string;
  repetition: number;
}

export interface PairedBenchmarkCell extends BenchmarkCell {
  pairId: string;
  armIndex: number;
}

export interface PairedRunResult {
  variantId: string;
  armIndex?: number;
  modelId: string;
  taskId: string;
  repetition: number;
  reward: number;
  status?: string;
  costUsd?: number;
  inputTokens?: number;
  cacheTokens?: number;
  outputTokens?: number;
  benchmark?: string;
  resultClass?: 'PASSED' | 'FAILED_AGENT' | 'ERRORED_INFRA' | 'INVALID_TASK';
  durationMs?: number;
  upstreamProvider?: string;
  usageStatus?: 'COMPLETE' | 'PARTIAL' | 'MISSING';
  usageCompleteness?: 'exact' | 'lower-bound' | 'incomplete';
}

export interface EvaluationReport {
  schemaVersion: 2;
  manifestDigest: string;
  trialCount: number;
  byBenchmark: PairedSummary['byBenchmark'];
  byAgent: PairedSummary['byAgent'];
  resultClasses: PairedSummary['resultClasses'];
  confidenceIntervals: PairedSummary['confidenceIntervals'];
  paired: Pick<PairedSummary, 'pairCount' | 'completePairCount' | 'incompletePairCount' | 'bothPass' | 'bothFail' | 'firstArmOnlyPass' | 'secondArmOnlyPass'>;
  unsupported: Array<{ variantId: string; modelId: string; reason: string }>;
  totals: { costUsd: number | null; knownCostUsd: number; costKnownCount: number; costMissingCount: number; inputTokens: number; cacheTokens: number; outputTokens: number; durationMs: number };
  upstreamProviders: Record<string, number>;
  usageCompleteness: Record<'exact' | 'lower-bound' | 'incomplete', number>;
}

export interface PairedSummary {
  pairCount: number;
  completePairCount: number;
  incompletePairCount: number;
  bothPass: number;
  bothFail: number;
  firstArmOnlyPass: number;
  secondArmOnlyPass: number;
  totalCostUsd: number | null;
  knownCostUsd: number;
  costKnownCount: number;
  costMissingCount: number;
  totalInputTokens: number;
  totalCacheTokens: number;
  totalOutputTokens: number;
  byBenchmark: Record<string, { trials: number; passed: number; passRate: number }>;
  byAgent: Record<string, { trials: number; passed: number; passRate: number }>;
  resultClasses: Record<'PASSED' | 'FAILED_AGENT' | 'ERRORED_INFRA' | 'INVALID_TASK', number>;
  totalDurationMs: number;
  upstreamProviders: Record<string, number>;
  usageCompleteness: Record<'exact' | 'lower-bound' | 'incomplete', number>;
  confidenceIntervals: Record<string, { successes: number; trials: number; lower95: number; upper95: number }>;
}

export interface RetryDecision { retry: boolean; reason: 'agent-failure' | 'infra-error' | 'invalid-task' | 'passed' | 'retry-exhausted'; nextAttempt: number; }

export function shouldRetry(resultClass: PairedRunResult['resultClass'], attemptNumber: number, manifest: BenchmarkManifest): RetryDecision {
  if (resultClass === 'ERRORED_INFRA' && attemptNumber <= (manifest.retry?.infra ?? 1)) return { retry: true, reason: 'infra-error', nextAttempt: attemptNumber + 1 };
  if (resultClass === 'ERRORED_INFRA') return { retry: false, reason: 'retry-exhausted', nextAttempt: attemptNumber };
  if (resultClass === 'FAILED_AGENT') return { retry: false, reason: 'agent-failure', nextAttempt: attemptNumber };
  if (resultClass === 'INVALID_TASK') return { retry: false, reason: 'invalid-task', nextAttempt: attemptNumber };
  return { retry: false, reason: 'passed', nextAttempt: attemptNumber };
}

export function shouldStop(results: PairedRunResult[], manifest: BenchmarkManifest): { stop: boolean; reason: 'cost-limit' | 'cost-unknown' | 'failure-limit' | null } {
  const knownCosts = results.filter((result): result is PairedRunResult & { costUsd: number } => Number.isFinite(result.costUsd));
  const cost = knownCosts.reduce((sum, result) => sum + result.costUsd, 0);
  if (manifest.budget?.maxCostUsd !== undefined && cost >= manifest.budget.maxCostUsd) return { stop: true, reason: 'cost-limit' };
  if (manifest.budget?.maxCostUsd !== undefined && knownCosts.length !== results.length) return { stop: true, reason: 'cost-unknown' };
  const failures = results.filter((result) => result.resultClass === 'FAILED_AGENT' || result.resultClass === 'ERRORED_INFRA').length;
  if (manifest.budget?.stopAfterFailures !== undefined && failures >= manifest.budget.stopAfterFailures) return { stop: true, reason: 'failure-limit' };
  return { stop: false, reason: null };
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  const output = [...items]; let state = seed >>> 0;
  for (let i = output.length - 1; i > 0; i -= 1) { state = (1664525 * state + 1013904223) >>> 0; const j = state % (i + 1); [output[i], output[j]] = [output[j], output[i]]; }
  return output;
}

export function schedulePlan(cells: BenchmarkCell[], manifest: BenchmarkManifest): BenchmarkCell[] {
  const ordered = manifest.agentOrder?.length ? [...manifest.agentOrder, ...manifest.variants.map((v) => v.id).filter((id) => !manifest.agentOrder?.includes(id))] : manifest.variants.map((v) => v.id);
  const rank = new Map(ordered.map((id, index) => [id, index]));
  const grouped = new Map<string, BenchmarkCell[]>();
  for (const cell of cells) { const key = pairKey(cell); grouped.set(key, [...(grouped.get(key) ?? []), cell]); }
  const pairs = seededShuffle([...grouped.values()], manifest.seed);
  return pairs.flatMap((pair) => [...pair].sort((a, b) => (rank.get(a.variantId) ?? 999) - (rank.get(b.variantId) ?? 999)));
}

function wilson(successes: number, trials: number): { lower95: number; upper95: number } {
  if (!trials) return { lower95: 0, upper95: 0 };
  const p = successes / trials; const z = 1.96; const denominator = 1 + z * z / trials;
  const centre = p + z * z / (2 * trials); const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * trials)) / trials);
  return { lower95: Math.max(0, (centre - spread) / denominator), upper95: Math.min(1, (centre + spread) / denominator) };
}

export function validateManifest(value: unknown): BenchmarkManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest must be an object');
  const manifest = value as Partial<BenchmarkManifest>;
  if (manifest.schemaVersion !== 1) throw new Error('manifest.schemaVersion must be 1');
  if (!['same-model-harness', 'default-model-product'].includes(manifest.board ?? '')) throw new Error('manifest.board is invalid');
  if (!manifest.dataset?.name || !manifest.dataset.revision || !Array.isArray(manifest.dataset.taskIds) || manifest.dataset.taskIds.length === 0) throw new Error('dataset name, revision and taskIds are required');
  if (new Set(manifest.dataset.taskIds).size !== manifest.dataset.taskIds.length) throw new Error('dataset.taskIds contains duplicates');
  if (!Number.isInteger(manifest.repetitions) || (manifest.repetitions ?? 0) < 1) throw new Error('repetitions must be a positive integer');
  if (manifest.concurrency !== undefined && (!Number.isInteger(manifest.concurrency) || manifest.concurrency < 1)) throw new Error('concurrency must be a positive integer');
  if (manifest.agentOrder !== undefined && (!Array.isArray(manifest.agentOrder) || new Set(manifest.agentOrder).size !== manifest.agentOrder.length)) throw new Error('agentOrder must be a duplicate-free array');
  if (manifest.retry && (manifest.retry.agent !== 0 || ![0, 1].includes(manifest.retry.infra))) throw new Error('retry must be agent=0 and infra=0|1');
  if (manifest.budget?.maxCostUsd !== undefined && (!Number.isFinite(manifest.budget.maxCostUsd) || manifest.budget.maxCostUsd <= 0)) throw new Error('budget.maxCostUsd must be positive');
  if (manifest.budget?.stopAfterFailures !== undefined && (!Number.isInteger(manifest.budget.stopAfterFailures) || manifest.budget.stopAfterFailures < 1)) throw new Error('budget.stopAfterFailures must be positive');
  if (manifest.throughputCap && (!Number.isFinite(manifest.throughputCap.outputTokensPerSecond) || manifest.throughputCap.outputTokensPerSecond <= 0)) throw new Error('throughputCap rate must be positive');
  if (!Array.isArray(manifest.modelIds) || manifest.modelIds.length === 0 || !Array.isArray(manifest.variants) || manifest.variants.length < 1) throw new Error('modelIds and variants must be non-empty');
  if (manifest.modelIds.some((id) => typeof id !== 'string' || !id.trim()) || new Set(manifest.modelIds).size !== manifest.modelIds.length) throw new Error('modelIds must contain unique non-empty strings');
  if (manifest.dataset.taskIds.some((id) => typeof id !== 'string' || !id.trim())) throw new Error('taskIds must contain non-empty strings');
  if (manifest.variants.some((variant) => !variant || !Array.isArray(variant.supportedModelIds))) throw new Error('variant supportedModelIds must be an array');
  const variantIds = manifest.variants.map((variant) => variant.id);
  if (variantIds.some((id) => typeof id !== 'string' || id.trim() === '')) throw new Error('variant IDs must be non-empty');
  if (new Set(variantIds).size !== variantIds.length) throw new Error('variants contains duplicate IDs');
  if (manifest.board === 'same-model-harness') {
    for (const modelId of manifest.modelIds) {
      const unsupported = manifest.variants.filter((variant) => !variant.supportedModelIds.includes(modelId)).map((variant) => variant.id);
      if (unsupported.length) throw new Error(`same-model cell unsupported for ${modelId}: ${unsupported.join(', ')}`);
    }
  }
  return manifest as BenchmarkManifest;
}

export function validatePairedManifest(manifest: BenchmarkManifest): BenchmarkManifest {
  if (manifest.variants.length !== 2) throw new Error('paired runs require exactly two variants');
  if (manifest.board !== 'same-model-harness') throw new Error('paired runs require the same-model-harness board');
  return manifest;
}

export function expandPairedPlan(manifest: BenchmarkManifest): { schemaVersion: 1; manifestDigest: string; cells: PairedBenchmarkCell[] } {
  validatePairedManifest(manifest);
  const cells: PairedBenchmarkCell[] = [];
  for (const taskId of manifest.dataset.taskIds) for (const modelId of manifest.modelIds) for (let repetition = 1; repetition <= manifest.repetitions; repetition += 1) {
    manifest.variants.forEach((variant, armIndex) => {
      if (variant.supportedModelIds.includes(modelId)) {
        const cellId = sha256(JSON.stringify({ dataset: manifest.dataset, taskId, variant: variant.id, modelId, repetition }));
        cells.push({ cellId, pairId: pairKey({ taskId, modelId, repetition }), armIndex, variantId: variant.id, modelId, taskId, repetition });
      }
    });
  }
  return { schemaVersion: 1, manifestDigest: sha256(JSON.stringify(manifest)), cells };
}

function passed(result: PairedRunResult | undefined): boolean {
  return result?.reward === 1;
}

function pairKey(result: Pick<PairedRunResult, 'taskId' | 'modelId' | 'repetition'>): string {
  return JSON.stringify([result.taskId, result.modelId, result.repetition]);
}

function validateResultRows(results: PairedRunResult[]): void {
  if (!Array.isArray(results)) throw new Error('results must be an array');
  const seen = new Set<string>();
  const variantArms = new Map<string, number>();
  const armVariants = new Map<number, string>();
  for (const result of results) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('result must be an object');
    if ([result.variantId, result.modelId, result.taskId].some((id) => typeof id !== 'string' || !id.trim())) throw new Error('result IDs must be non-empty strings');
    if (!Number.isSafeInteger(result.repetition) || result.repetition < 1) throw new Error('invalid result repetition');
    if (!Number.isFinite(result.reward) || result.reward < 0 || result.reward > 1) throw new Error(`invalid reward for ${result.taskId}`);
    for (const field of ['costUsd', 'durationMs', 'inputTokens', 'cacheTokens', 'outputTokens'] as const) {
      const value = result[field];
      if (value != null && (!Number.isFinite(value) || value < 0)) throw new Error(`invalid result ${field}`);
    }
    for (const field of ['benchmark', 'upstreamProvider'] as const) {
      if (result[field] != null && typeof result[field] !== 'string') throw new Error(`invalid result ${field}`);
    }
    if (result.resultClass !== undefined && !['PASSED', 'FAILED_AGENT', 'ERRORED_INFRA', 'INVALID_TASK'].includes(result.resultClass)) throw new Error('invalid result class');
    if (result.usageStatus !== undefined && !['COMPLETE', 'PARTIAL', 'MISSING'].includes(result.usageStatus)) throw new Error('invalid usage status');
    if (result.usageCompleteness !== undefined && !['exact', 'lower-bound', 'incomplete'].includes(result.usageCompleteness)) throw new Error('invalid usage completeness');
    const key = JSON.stringify([result.variantId, result.taskId, result.modelId, result.repetition]);
    if (seen.has(key)) throw new Error('duplicate result cell');
    seen.add(key);
    if (result.armIndex !== undefined) {
      if (!Number.isSafeInteger(result.armIndex) || result.armIndex < 0) throw new Error('invalid arm index');
      if ((variantArms.has(result.variantId) && variantArms.get(result.variantId) !== result.armIndex)
        || (armVariants.has(result.armIndex) && armVariants.get(result.armIndex) !== result.variantId)) throw new Error('conflicting result arms');
      variantArms.set(result.variantId, result.armIndex);
      armVariants.set(result.armIndex, result.variantId);
    }
  }
}

function validateReportResults(manifest: BenchmarkManifest, results: PairedRunResult[]): PairedRunResult[] {
  validateResultRows(results);
  const tasks = new Set(manifest.dataset.taskIds);
  const models = new Set(manifest.modelIds);
  return results.map((result) => {
    const armIndex = manifest.variants.findIndex((variant) => variant.id === result.variantId);
    if (!tasks.has(result.taskId) || !models.has(result.modelId) || result.repetition > manifest.repetitions || armIndex < 0
      || !manifest.variants[armIndex].supportedModelIds.includes(result.modelId)) throw new Error('result does not belong to a supported manifest cell');
    if (result.armIndex !== undefined && result.armIndex !== armIndex) throw new Error('result arm does not match manifest variant');
    return { ...result, armIndex };
  });
}

export function summarizePairedResults(results: PairedRunResult[], paired = true): PairedSummary {
  validateResultRows(results);
  if (paired && (new Set(results.map((result) => result.variantId)).size > 2 || results.some((result) => (result.armIndex ?? 0) > 1))) throw new Error('paired results require at most two distinct arms');
  const pairs = new Map<string, PairedRunResult[]>();
  let knownCostUsd = 0;
  let costKnownCount = 0;
  let costMissingCount = 0;
  let totalInputTokens = 0;
  let totalCacheTokens = 0;
  let totalOutputTokens = 0;
  let totalDurationMs = 0;
  const byBenchmark: PairedSummary['byBenchmark'] = Object.create(null);
  const byAgent: PairedSummary['byAgent'] = Object.create(null);
  const resultClasses: PairedSummary['resultClasses'] = { PASSED: 0, FAILED_AGENT: 0, ERRORED_INFRA: 0, INVALID_TASK: 0 };
  const upstreamProviders: Record<string, number> = Object.create(null);
  const confidenceIntervals: PairedSummary['confidenceIntervals'] = Object.create(null);
  const usageCompleteness: PairedSummary['usageCompleteness'] = { exact: 0, 'lower-bound': 0, incomplete: 0 };
  for (const result of results) {
    if (!Number.isFinite(result.reward)) throw new Error(`invalid reward for ${result.taskId}`);
    const key = pairKey(result);
    const pair = pairs.get(key) ?? [];
    pair.push(result);
    pairs.set(key, pair);
    if (Number.isFinite(result.costUsd)) {
      knownCostUsd += result.costUsd as number;
      costKnownCount += 1;
    } else {
      costMissingCount += 1;
    }
    totalInputTokens += result.inputTokens ?? 0;
    totalCacheTokens += result.cacheTokens ?? 0;
    totalOutputTokens += result.outputTokens ?? 0;
    totalDurationMs += result.durationMs ?? 0;
    const benchmark = result.benchmark ?? 'unknown';
    const agent = result.variantId;
    const b = byBenchmark[benchmark] ?? { trials: 0, passed: 0, passRate: 0 };
    b.trials += 1; b.passed += passed(result) ? 1 : 0; b.passRate = b.passed / b.trials; byBenchmark[benchmark] = b;
    const a = byAgent[agent] ?? { trials: 0, passed: 0, passRate: 0 };
    a.trials += 1; a.passed += passed(result) ? 1 : 0; a.passRate = a.passed / a.trials; byAgent[agent] = a;
    if (result.resultClass) resultClasses[result.resultClass] += 1;
    if (result.upstreamProvider) upstreamProviders[result.upstreamProvider] = (upstreamProviders[result.upstreamProvider] ?? 0) + 1;
    const completeness = result.usageCompleteness ?? (result.usageStatus === 'COMPLETE' ? 'exact' : result.usageStatus === 'PARTIAL' ? 'lower-bound' : 'incomplete');
    usageCompleteness[completeness] += 1;
  }
  let completePairCount = 0;
  let bothPass = 0;
  let bothFail = 0;
  let firstArmOnlyPass = 0;
  let secondArmOnlyPass = 0;
  for (const pair of paired ? pairs.values() : []) {
    const ordered = [...pair].sort((a, b) => (a.armIndex ?? Number.MAX_SAFE_INTEGER) - (b.armIndex ?? Number.MAX_SAFE_INTEGER) || a.variantId.localeCompare(b.variantId));
    if (ordered.length !== 2) continue;
    completePairCount += 1;
    const first = passed(ordered[0]);
    const second = passed(ordered[1]);
    if (first && second) bothPass += 1;
    else if (!first && !second) bothFail += 1;
    else if (first) firstArmOnlyPass += 1;
    else secondArmOnlyPass += 1;
  }
  for (const [agent, stats] of Object.entries(byAgent)) confidenceIntervals[agent] = { successes: stats.passed, trials: stats.trials, ...wilson(stats.passed, stats.trials) };
  const totalCostUsd = costMissingCount === 0 ? knownCostUsd : null;
  return { pairCount: paired ? pairs.size : 0, completePairCount, incompletePairCount: paired ? pairs.size - completePairCount : 0, bothPass, bothFail, firstArmOnlyPass, secondArmOnlyPass, totalCostUsd, knownCostUsd, costKnownCount, costMissingCount, totalInputTokens, totalCacheTokens, totalOutputTokens, byBenchmark, byAgent, resultClasses, totalDurationMs, upstreamProviders, usageCompleteness, confidenceIntervals };
}

export function expandPlan(manifest: BenchmarkManifest): { schemaVersion: 1; manifestDigest: string; cells: BenchmarkCell[] } {
  const cells: BenchmarkCell[] = [];
  for (const taskId of manifest.dataset.taskIds) for (const modelId of manifest.modelIds) for (let repetition = 1; repetition <= manifest.repetitions; repetition += 1) for (const variant of manifest.variants) {
    if (variant.supportedModelIds.includes(modelId)) cells.push({ cellId: sha256(JSON.stringify({ dataset: manifest.dataset, taskId, variant: variant.id, modelId, repetition })), variantId: variant.id, modelId, taskId, repetition });
  }
  return { schemaVersion: 1, manifestDigest: sha256(JSON.stringify(manifest)), cells };
}

export function expandScheduledPlan(manifest: BenchmarkManifest): { schemaVersion: 1; manifestDigest: string; cells: BenchmarkCell[] } {
  const plan = expandPlan(manifest);
  return { ...plan, cells: schedulePlan(plan.cells, manifest) };
}

export function createEvaluationReport(manifest: BenchmarkManifest, results: PairedRunResult[]): EvaluationReport {
  validateManifest(manifest);
  const validatedResults = validateReportResults(manifest, results);
  const summary = summarizePairedResults(validatedResults, manifest.variants.length === 2);
  const supported = new Set(manifest.variants.flatMap((variant) => manifest.modelIds.filter((model) => variant.supportedModelIds.includes(model)).map((model) => `${variant.id}:${model}`)));
  const unsupported = manifest.variants.flatMap((variant) => manifest.modelIds.filter((model) => !supported.has(`${variant.id}:${model}`)).map((model) => ({ variantId: variant.id, modelId: model, reason: 'variant does not declare support for exact model' })));
  return {
    schemaVersion: 2,
    manifestDigest: sha256(JSON.stringify(manifest)),
    trialCount: results.length,
    byBenchmark: summary.byBenchmark,
    byAgent: summary.byAgent,
    resultClasses: summary.resultClasses,
    confidenceIntervals: summary.confidenceIntervals,
    paired: { pairCount: summary.pairCount, completePairCount: summary.completePairCount, incompletePairCount: summary.incompletePairCount, bothPass: summary.bothPass, bothFail: summary.bothFail, firstArmOnlyPass: summary.firstArmOnlyPass, secondArmOnlyPass: summary.secondArmOnlyPass },
    unsupported,
    totals: { costUsd: summary.totalCostUsd, knownCostUsd: summary.knownCostUsd, costKnownCount: summary.costKnownCount, costMissingCount: summary.costMissingCount, inputTokens: summary.totalInputTokens, cacheTokens: summary.totalCacheTokens, outputTokens: summary.totalOutputTokens, durationMs: summary.totalDurationMs },
    upstreamProviders: summary.upstreamProviders,
    usageCompleteness: summary.usageCompleteness,
  };
}

export function freezeHard30(historical: Array<{ taskId: string; solveRate: number }>, taskCount = 30): { schemaVersion: 1; source: 'independent-historical-data'; taskIds: string[]; taskListDigest: string } {
  if (historical.length < taskCount) throw new Error(`hard-30 requires at least ${taskCount} independent historical tasks`);
  const sorted = [...historical].sort((a, b) => a.solveRate - b.solveRate || a.taskId.localeCompare(b.taskId));
  const taskIds = sorted.slice(0, taskCount).map((item) => item.taskId);
  return { schemaVersion: 1, source: 'independent-historical-data', taskIds, taskListDigest: sha256(JSON.stringify(taskIds)) };
}

export async function writePlan(manifestPath: string, outputPath: string): Promise<void> {
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  await writeFile(outputPath, JSON.stringify(expandPlan(manifest), null, 2) + '\n', 'utf8');
}

export function validateOracleGate(taskIds: string[], results: Array<{ taskId: string; reward: number }>): { ok: true; taskIds: string[] } {
  const expected = [...taskIds].sort().slice(0, 5);
  if (expected.length !== 5) throw new Error('Oracle gate requires at least five frozen task IDs');
  const resultMap = new Map(results.map((result) => [result.taskId, result.reward]));
  const failed = expected.filter((taskId) => resultMap.get(taskId) !== 1);
  if (failed.length) throw new Error(`Oracle gate failed or missing: ${failed.join(', ')}`);
  return { ok: true, taskIds: expected };
}
