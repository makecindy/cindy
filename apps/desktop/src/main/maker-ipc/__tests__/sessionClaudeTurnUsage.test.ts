import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSourceFile, isFunctionDeclaration, ScriptKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { calibratedResponseDuration } from '@cindy/maker-shared/usage-format';
import type { AgentEvent, Session } from '@cindy/maker-core';
import type { RecordSessionClaudeTurnUsageDeps } from '../sessionClaudeTurnUsage.js';
import { buildClaudeTurnUsageDetails, normalizeTurnUsageSegments } from '../../usage/turnCostCalculator.js';
import { ClaudeOutputLagTimingGuard, computeModelUsageDeltas } from '../../usage/modelUsageDelta.js';

// Execute the production sink with database/network effects isolated, retaining
// real usage normalization, timing validation and message-detail construction.
const source = readFileSync(resolve(__dirname, '../sessionClaudeTurnUsage.ts'), 'utf8').replace(/\r\n?/g, '\n');
const ast = createSourceFile('sessionClaudeTurnUsage.ts', source, ScriptTarget.Latest, true, ScriptKind.TS);
const declaration = ast.statements.find(node => isFunctionDeclaration(node) && node.name?.text === 'recordSessionClaudeTurnUsage');
if (!declaration) throw new Error('recordSessionClaudeTurnUsage not found');
const compiled = transpileModule(declaration.getText(ast), {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText.replace('export function ', 'function ');

function harness() {
  const record = vi.fn<(value: { turnUsageDetails: unknown }) => Promise<void>>().mockResolvedValue(undefined);
  const guard = new ClaudeOutputLagTimingGuard();
  const recordSpend = vi.fn();
  const runtime = {
    calibratedResponseDuration, normalizeTurnUsageSegments, buildClaudeTurnUsageDetails, computeModelUsageDeltas,
    captureTurnUsageContext: () => ({ providerId: null }),
    recordTurnUsageOnMessage: record,
    triggerClaudeAccountUsageRefresh: vi.fn(), triggerClaudeSubscriptionUsageRefresh: vi.fn(),
    getSessionProvider: () => undefined,
    CHATGPT_MODEL_PREFIX: 'chatgpt/', isExclusiveXaiModelId: () => false,
    detectClaudeModelMismatch: () => null,
    billingRouteForExplicitProvider: () => null, readClaudeSessionRoute: () => 'subscription',
    readClaudeApiKey: () => undefined, getReferenceModelPricing: () => null,
    CURRENT_CINDY_REGION: 'global',
    resolveClaudeTurnCostSinks: () => ({ turnMoney: null, estimatedTurnMoney: null, perModel: [] }),
    recordTurnSpend: recordSpend,
  };
  const wire = new Function('runtime', `const {${Object.keys(runtime).join(',')}} = runtime; ${compiled}; return recordSessionClaudeTurnUsage;`)(runtime) as
    typeof import('../sessionClaudeTurnUsage.js').recordSessionClaudeTurnUsage;
  const deps: RecordSessionClaudeTurnUsageDeps = {
    turnUsageContextBySession: new Map(), turnModelPromiseBySession: new Map(),
    readSessionModelForUsage: async () => 'claude-sonnet-4.5',
    lastReportedModelUsageBySession: new Map(), claudeOutputLagTimingGuard: guard,
    lastReportedCostUsdBySession: new Map(), log: { warn: vi.fn() },
    unpricedSubscriptionValueMarker: () => ({ amount: 0, currency: 'USD', kind: 'value-estimate', approximate: true }),
  };
  const send = (data: unknown) => wire(deps, { id: 'task' } as Session,
    { type: 'done', source: 'claude-code', data } as AgentEvent, 'assistant', 9_000, false);
  return { send, record, guard, deps, recordSpend };
}

function done(output = 60, cumulative = 160, durationMs = 3_000) {
  return {
    total_cost_usd: 0, usage: { input_tokens: 500, output_tokens: cumulative, cache_read_input_tokens: 200 },
    turnUsage: { input_tokens: 15, output_tokens: output, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
    responseSpeed: { phase: 'complete', waitOrigin: 'stream', firstResponseMs: 1000, waitingMs: 0,
      durationMs, outputTokens: output, estimated: false, averageRate: output * 1000 / durationMs,
      recentRate: output * 1000 / durationMs, samples: [], sampledAt: 10_000 },
  };
}

describe('Claude completed usage without modelUsage', () => {
  it('persists current-turn TPS across cumulative results without charging or copying aggregate tokens', async () => {
    const h = harness();
    h.send(done(100, 100, 2_000));
    await vi.waitFor(() => expect(h.record).toHaveBeenCalledTimes(1));
    h.send(done());
    await vi.waitFor(() => expect(h.record).toHaveBeenCalledTimes(2));
    const first = h.record.mock.calls[0][0].turnUsageDetails;
    const second = h.record.mock.calls[1][0].turnUsageDetails;
    expect(first).toMatchObject({ outputTokens: 100, durationMs: 2_000 });
    expect(second).toMatchObject({ inputTokens: 15, outputTokens: 60, cacheReadTokens: 5,
      cacheCreateTokens: 2, durationMs: 3_000, turnDurationMs: 9_000 });
    expect(h.deps.lastReportedCostUsdBySession.get('task')).toBe(0);
    expect(h.recordSpend).not.toHaveBeenCalled();
  });

  it('uses the normalized delta when partial request metadata has no priced model rows', async () => {
    const h = harness();
    h.send({ ...done(), usageSegments: [{ model: 'claude-sonnet-4.5', inputTokens: 5, outputTokens: 10 }],
      usageSegmentsComplete: false });
    await vi.waitFor(() => expect(h.record).toHaveBeenCalledTimes(1));
    expect(h.record.mock.calls[0][0].turnUsageDetails).toMatchObject({ inputTokens: 15,
      outputTokens: 60, cacheReadTokens: 5, cacheCreateTokens: 2, durationMs: 3_000 });
    expect(h.recordSpend).not.toHaveBeenCalled();
  });

  it.each([undefined, { output_tokens: 160 }, { output_tokens: Number.NaN }, { output_tokens: -1 }])(
    'omits timing when the normalized provider count is unavailable or mismatched (%j)', async (turnUsage) => {
      const h = harness(); h.send({ ...done(), turnUsage });
      await vi.waitFor(() => expect(h.record).toHaveBeenCalledTimes(1));
      expect(h.record.mock.calls[0][0].turnUsageDetails).toMatchObject({ outputTokens: 0 });
      expect(h.record.mock.calls[0][0].turnUsageDetails).not.toHaveProperty('durationMs');
    },
  );

  it('keeps a real zero and respects output-lag suppression', async () => {
    const h = harness(); h.send(done(0, 160));
    await vi.waitFor(() => expect(h.record).toHaveBeenCalledTimes(1));
    expect(h.record.mock.calls[0][0].turnUsageDetails).toMatchObject({ outputTokens: 0, durationMs: 3_000 });
    vi.spyOn(h.guard, 'evaluate').mockReturnValue({ detected: false, suppressTiming: true });
    h.send(done());
    await vi.waitFor(() => expect(h.record).toHaveBeenCalledTimes(2));
    expect(h.record.mock.calls[1][0].turnUsageDetails).not.toHaveProperty('durationMs');
  });
});
