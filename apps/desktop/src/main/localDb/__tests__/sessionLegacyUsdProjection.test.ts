/**
 * sessionToCamel 的 legacy totalCostUsd 兼容投影:
 * 与 totalMoney 同一 combine 语义 —— 结构化累计仍是 USD 时并入标量投影,
 * 否则(CNY 无法表达进 USD 字段)保持冻结历史值。守住 device-link v1 /
 * 手机端等只消费 totalCostUsd 的读方在全量 reseed 后不丢新增 USD 花费。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { sessionToCamel, setSessionRuntimeProjector, type SessionRowWithCount } from '../mapper';

afterEach(() => {
  setSessionRuntimeProjector(null);
});

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

describe('sessionToCamel runtime projection', () => {
  it('adds the effective runtime route to shared desktop and device-link snapshots', () => {
    setSessionRuntimeProjector((session) => ({
      model: 'gpt-runtime',
      providerId: 'openai',
      effort: 'xhigh',
      fastMode: true,
      runtimeGeneration: 4,
      runtimeBaseline: {
        agentKind: 'codex',
        model: session.model,
        providerId: session.providerId ?? null,
        effort: session.effort,
        fastMode: session.fastMode,
      },
      runtimeEffective: {
        agentKind: 'codex',
        model: 'gpt-runtime',
        providerId: 'openai',
        effort: 'xhigh',
        fastMode: true,
      },
      runtimePending: null,
    }));

    const session = sessionToCamel(
      sessionRow({
        agentKind: 'codex',
        model: 'gpt-baseline',
        providerId: 'xd',
        effort: 'high',
        fastMode: false,
      }),
    );

    expect(session).toMatchObject({
      model: 'gpt-runtime',
      providerId: 'openai',
      effort: 'xhigh',
      fastMode: true,
      runtimeGeneration: 4,
      runtimeBaseline: {
        model: 'gpt-baseline',
        providerId: 'xd',
        effort: 'high',
        fastMode: false,
      },
      runtimeEffective: {
        model: 'gpt-runtime',
        providerId: 'openai',
        effort: 'xhigh',
        fastMode: true,
      },
      runtimePending: null,
    });
  });

  it('clears the baseline effort when the effective runtime model has fixed strength', () => {
    setSessionRuntimeProjector((session) => ({
      model: 'fixed-strength-model',
      providerId: 'openai',
      effort: '',
      fastMode: false,
      runtimeGeneration: 5,
      runtimeBaseline: {
        agentKind: 'codex',
        model: session.model,
        providerId: session.providerId ?? null,
        effort: session.effort,
        fastMode: session.fastMode,
      },
      runtimeEffective: {
        agentKind: 'codex',
        model: 'fixed-strength-model',
        providerId: 'openai',
        effort: null,
        fastMode: false,
      },
      runtimePending: null,
    }));

    const session = sessionToCamel(
      sessionRow({ model: 'gpt-baseline', effort: 'high', providerId: 'xd' }),
    );

    expect(session.model).toBe('fixed-strength-model');
    expect(session.effort).toBe('');
    expect(session.runtimeEffective?.effort).toBeNull();
  });

  it('removes the injected runtime projection when the composition root is reset', () => {
    setSessionRuntimeProjector(() => ({ model: 'temporary-model' }));
    setSessionRuntimeProjector(null);

    expect(sessionToCamel(sessionRow({ model: 'persisted-model' })).model).toBe('persisted-model');
  });
});
