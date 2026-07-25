/**
 * sessionToCamel 的 legacy totalCostUsd 兼容投影:
 * 与 totalMoney 同一 combine 语义 —— 结构化累计仍是 USD 时并入标量投影,
 * 否则(CNY 无法表达进 USD 字段)保持冻结历史值。守住 device-link v1 /
 * 手机端等只消费 totalCostUsd 的读方在全量 reseed 后不丢新增 USD 花费。
 */

import { describe, expect, it } from 'vitest';

import { sessionToCamel, type SessionRowWithCount } from '../mapper';

function sessionRow(
  overrides: Partial<SessionRowWithCount>,
): SessionRowWithCount {
  const base = {
    id: 's-1',
    title: 'New Maker',
    workingDir: null,
    workspaceKind: 'project',
    model: 'claude-sonnet-5',
    effort: 'high',
    permissionMode: 'ask',
    providerId: null,
    status: 'active',
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    totalCostAmount: 0,
    totalCostCurrency: null,
    totalCostIsApproximate: false,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: false,
    planModeEnabled: false,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: null,
    agentKind: 'claude-code',
    source: null,
    orcaRole: null,
    parentSessionId: null,
    forkedAtMessageId: null,
    worktreePath: null,
    usedProjectContext: false,
    extraDirs: null,
    remoteHostId: null,
    activeTurnStartedAt: null,
    lastTurnEndedAt: null,
    summary: null,
    createdAt: 1_753_300_000_000,
    updatedAt: 1_753_300_000_000,
    messageCount: 0,
    latestMessageContent: null,
    latestMessageRole: null,
  };
  return { ...base, ...overrides } as SessionRowWithCount;
}

describe('sessionToCamel legacy totalCostUsd projection', () => {
  it('merges USD structured spend into the legacy scalar', () => {
    const session = sessionToCamel(
      sessionRow({
        totalCostUsd: 1.5,
        totalCostAmount: 0.5,
        totalCostCurrency: 'USD',
      }),
    );
    expect(session.totalCostUsd).toBeCloseTo(2.0, 10);
  });

  it('keeps the frozen legacy value when structured spend is CNY', () => {
    const session = sessionToCamel(
      sessionRow({
        totalCostUsd: 1.5,
        totalCostAmount: 3.35,
        totalCostCurrency: 'CNY',
      }),
    );
    expect(session.totalCostUsd).toBe(1.5);
  });

  it('passes the legacy value through when no structured spend exists', () => {
    const session = sessionToCamel(sessionRow({ totalCostUsd: 1.5 }));
    expect(session.totalCostUsd).toBe(1.5);
  });
});
