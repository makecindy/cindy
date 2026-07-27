/**
 * patchMessageAgentMeta.test.ts
 * ---------------------------------------------------------------------------
 * agent_meta 的 read-merge-write 补丁(per-turn 费用挂载用)。命门是 merge 语义:
 * 整列覆盖会丢 uuid / model 等 rewind / fork 锚点字段,这里逐条覆盖:
 *   - 已有 meta 的字段在 patch 后保留,patch 字段合并进去;
 *   - agent_meta 为 null / 损坏 JSON → 以 {} 为底,patch 字段仍写入;
 *   - 行不存在 → 返回 false 且不发 UPDATE(调用方据此跳过广播)。
 *
 * drizzle 链 mock 方式对齐 fork.test.ts(thenable chain + selectQueue)。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mockSend } }],
  },
}));
vi.mock('../../shared/brandRegion', () => ({
  CURRENT_CINDY_REGION: 'cn',
  CURRENT_APP_ID: 'com.xd.cindycn',
}));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../maker-host/codex-local-sessions', () => ({
  importExternalCodexMessagesForSession: vi.fn(),
}));
vi.mock('../maker-host/claude-local-sessions', () => ({
  importExternalClaudeCodeMessagesForSession: vi.fn(),
}));
vi.mock('../embedders/chat-history-embedder', () => ({
  onMessageCreated: vi.fn(async () => undefined),
}));

// fake drizzle:select 链按 selectQueue 顺序吐行;update 链捕获 set 的 payload。
type SelectChain = Record<string, unknown> & {
  then: (resolve: (v: unknown) => unknown) => Promise<unknown>;
};
const selectQueue: unknown[][] = [];
const updateSetCalls: Array<Record<string, unknown>> = [];

function makeSelectChain(rows: unknown[]): SelectChain {
  const chain = {} as SelectChain;
  for (const k of ['from', 'where', 'limit']) chain[k] = vi.fn(() => chain);
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
  return chain;
}

function makeUpdateChain(): SelectChain {
  const chain = {} as SelectChain;
  chain.set = vi.fn((payload: Record<string, unknown>) => {
    updateSetCalls.push(payload);
    return chain;
  });
  chain.where = vi.fn(() => chain);
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
  return chain;
}

const fakeDb = {
  select: vi.fn(() => makeSelectChain(selectQueue.shift() ?? [])),
  update: vi.fn(() => makeUpdateChain()),
};

vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({ drizzle: fakeDb }),
}));

import {
  broadcastMessageAgentMetaUpdate,
  extractEstimatedSessionValueEntries,
  patchMessageAgentMeta,
} from '../localDb/ipc/messages.js';

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  updateSetCalls.length = 0;
});

describe('patchMessageAgentMeta', () => {
  it('merge:保留已有 meta 字段(uuid 等 fork/rewind 锚点),合并 patch 字段', async () => {
    selectQueue.push([{ agentMeta: JSON.stringify({ uuid: 'sdk-u1', model: 'claude-fable-5' }) }]);
    const ok = await patchMessageAgentMeta('s1', 'm1', {
      turnCostUsd: 0.05,
      turnCostIsEstimate: false,
    });
    expect(ok).toBe(true);
    expect(updateSetCalls).toHaveLength(1);
    expect(JSON.parse(updateSetCalls[0].agentMeta as string)).toEqual({
      uuid: 'sdk-u1',
      model: 'claude-fable-5',
      turnCostUsd: 0.05,
      turnCostIsEstimate: false,
    });
  });

  it('agent_meta 为 null → 以 {} 为底写入 patch 字段', async () => {
    selectQueue.push([{ agentMeta: null }]);
    const ok = await patchMessageAgentMeta('s1', 'm1', { turnCostUsd: 0.01 });
    expect(ok).toBe(true);
    expect(JSON.parse(updateSetCalls[0].agentMeta as string)).toEqual({ turnCostUsd: 0.01 });
  });

  it('agent_meta 是损坏 JSON → 不抛错,以 {} 为底重建', async () => {
    selectQueue.push([{ agentMeta: '{broken' }]);
    const ok = await patchMessageAgentMeta('s1', 'm1', { turnCostUsd: 0.02 });
    expect(ok).toBe(true);
    expect(JSON.parse(updateSetCalls[0].agentMeta as string)).toEqual({ turnCostUsd: 0.02 });
  });

  it('行不存在(rewind 已删)→ 返回 false 且不 UPDATE', async () => {
    selectQueue.push([]);
    const ok = await patchMessageAgentMeta('s1', 'gone', { turnCostUsd: 0.03 });
    expect(ok).toBe(false);
    expect(fakeDb.update).not.toHaveBeenCalled();
  });

  it('元数据更新复用 messages:created 广播权威完整行', async () => {
    selectQueue.push([
      {
        id: 'row-1',
        sessionId: 's1',
        clientId: 'm1',
        role: 'assistant',
        content: JSON.stringify('正式总结'),
        toolUseId: null,
        agentMeta: JSON.stringify({ turnCompleted: true }),
        agentKind: 'cc',
        createdAt: 1,
        rewindAt: null,
      },
    ]);

    await expect(broadcastMessageAgentMetaUpdate('s1', 'm1')).resolves.toBe(true);
    expect(mockSend).toHaveBeenCalledWith(
      'local-db:messages:created',
      expect.objectContaining({
        sessionId: 's1',
        message: expect.objectContaining({
          clientId: 'm1',
          agentMeta: expect.objectContaining({ turnCompleted: true }),
        }),
      }),
    );
  });
});

describe('extractEstimatedSessionValueEntries', () => {
  it('只汇总订阅模式估算价值,忽略真实 API cost / 非法 meta', () => {
    const legacyEstimatedEntry = (clientId: string, costUsd: number) => ({
      clientId,
      money: {
        amount: expect.closeTo(costUsd),
        currency: 'USD',
        approximate: true,
        kind: 'value-estimate',
        estimateReasons: ['legacy-usd', 'subscription-value'],
      },
      costUsd: expect.closeTo(costUsd),
    });
    expect(
      extractEstimatedSessionValueEntries([
        {
          clientId: 'estimate-1',
          agentMeta: JSON.stringify({ turnCostUsd: 0.12, turnCostIsEstimate: true }),
        },
        {
          clientId: 'api-cost',
          agentMeta: JSON.stringify({ turnCostUsd: 0.34, turnCostIsEstimate: false }),
        },
        {
          clientId: 'missing-flag',
          agentMeta: JSON.stringify({ turnCostUsd: 0.56 }),
        },
        {
          clientId: 'zero',
          agentMeta: JSON.stringify({ turnCostUsd: 0, turnCostIsEstimate: true }),
        },
        {
          clientId: 'broken',
          agentMeta: '{broken',
        },
        {
          clientId: 'estimate-2',
          agentMeta: JSON.stringify({ uuid: 'u2', turnCostUsd: 0.03, turnCostIsEstimate: true }),
        },
        {
          clientId: 'estimate-recomputed',
          agentMeta: JSON.stringify({
            turnCostUsd: 8.76,
            turnCostIsEstimate: true,
            turnUsageDetails: {
              inputTokens: 213_800,
              outputTokens: 6_400,
              cacheReadTokens: 1_500_000,
              cacheCreateTokens: 0,
              totalTokens: 1_720_200,
              cacheHitRate: 0.875,
              model: 'gpt-5.5',
            },
          }),
        },
        {
          clientId: 'estimate-recomputed-meta-model',
          agentMeta: JSON.stringify({
            model: 'gpt-5.5',
            turnCostUsd: 8.76,
            turnCostIsEstimate: true,
            turnUsageDetails: {
              inputTokens: 213_800,
              outputTokens: 6_400,
              cacheReadTokens: 1_500_000,
              cacheCreateTokens: 0,
              totalTokens: 1_720_200,
              cacheHitRate: 0.875,
            },
          }),
        },
        {
          clientId: 'estimate-legacy-fallback-recomputed',
          agentMeta: JSON.stringify({
            model: 'gpt-5.5',
            turnCostUsd: 3.4788,
            turnCostIsEstimate: true,
            turnUsageDetails: {
              inputTokens: 213_800,
              outputTokens: 6_400,
              cacheReadTokens: 1_500_000,
              cacheCreateTokens: 0,
              totalTokens: 1_720_200,
              cacheHitRate: 0.875,
            },
          }),
        },
        {
          clientId: 'estimate-live-pricing-preserved',
          agentMeta: JSON.stringify({
            model: 'gpt-5.5',
            turnCostUsd: 3.14,
            turnCostIsEstimate: true,
            turnUsageDetails: {
              inputTokens: 213_800,
              outputTokens: 6_400,
              cacheReadTokens: 1_500_000,
              cacheCreateTokens: 0,
              totalTokens: 1_720_200,
              cacheHitRate: 0.875,
            },
          }),
        },
      ]),
    ).toEqual([
      legacyEstimatedEntry('estimate-1', 0.12),
      legacyEstimatedEntry('estimate-2', 0.03),
      legacyEstimatedEntry('estimate-recomputed', 2.011),
      legacyEstimatedEntry('estimate-recomputed-meta-model', 2.011),
      legacyEstimatedEntry('estimate-legacy-fallback-recomputed', 2.011),
      legacyEstimatedEntry('estimate-live-pricing-preserved', 3.14),
    ]);
  });
});
