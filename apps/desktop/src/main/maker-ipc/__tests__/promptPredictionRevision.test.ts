import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<{
    agentKind: string | null;
    status: string | null;
    source: string | null;
    remoteHostId: string | null;
    providerId: string | null;
    workingDir: string | null;
    updatedAt: number;
    activeTurnStartedAt: number | null;
    lastTurnEndedAt: number | null;
  }>,
  dbReads: 0,
  beforeDispatchCalls: 0,
  providers: [{ id: 'provider-1' }],
  resolvedProviderId: 'provider-1',
  afterDispatch: null as null | (() => void),
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../i18n.js', () => ({
  getResolvedMainLocale: () => 'zh-CN',
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              const row = h.rows[Math.min(h.dbReads, h.rows.length - 1)];
              h.dbReads += 1;
              return row ? [row] : [];
            },
          }),
        }),
      }),
    },
  }),
}));

vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({
    listProviders: async () => h.providers,
  }),
}));

vi.mock('@cindy/model-providers', () => ({
  connectedProvidersForAgent: (providers: unknown[]) => providers,
  nativeDefaultSourceId: () => 'provider-1',
}));

vi.mock('../../maker-host/title-one-shot.js', () => ({
  buildTitleTarget: (providerId: string) =>
    providerId === 'provider-1' || providerId === 'xd' ? { providerId } : null,
  generateTitleViaProviderResult: async (
    request: { sessionId: string; agentKind: string },
    deps: {
      beforeDispatch?: (input: {
        sessionId: string;
        agentKind: string;
        providerId: string;
      }) => Promise<boolean>;
    },
  ) => {
    h.beforeDispatchCalls += 1;
    const allowed = await deps.beforeDispatch?.({
      sessionId: request.sessionId,
      agentKind: request.agentKind,
      providerId: h.resolvedProviderId,
    });
    if (allowed) h.afterDispatch?.();
    return allowed ? { status: 'ok', title: '继续补测试' } : { status: 'aborted', title: null };
  },
}));

import { generatePromptPrediction } from '../promptPrediction.js';
import {
  notePromptPredictionSessionStopped,
  resetPromptPredictionStopLedgerForTests,
} from '../promptPredictionStopLedger.js';

const VALID_ROW = {
  agentKind: 'cc',
  status: 'active',
  source: null,
  remoteHostId: null,
  providerId: 'provider-1',
  workingDir: 'E:\\project',
  updatedAt: 10,
  activeTurnStartedAt: 100,
  lastTurnEndedAt: 200,
};

function predict(): Promise<string | null> {
  return generatePromptPrediction({
    sessionId: 'session-1',
    agentKind: 'claude-code',
    messages: [
      { role: 'user', content: '实现这个功能' },
      { role: 'assistant', content: '已经完成实现' },
    ],
    workingDir: 'E:\\project',
    materialDrainUpdatedAt: 10,
    completionRevision: 200,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.dbReads = 0;
  h.beforeDispatchCalls = 0;
  h.providers = [{ id: 'provider-1' }];
  h.resolvedProviderId = 'provider-1';
  h.afterDispatch = null;
  h.rows = [{ ...VALID_ROW }, { ...VALID_ROW }];
  resetPromptPredictionStopLedgerForTests();
});

describe('prompt prediction completion revision guard', () => {
  it('provider 派发紧前两次复核都匹配时允许预测', async () => {
    await expect(predict()).resolves.toBe('继续补测试');
    expect(h.beforeDispatchCalls).toBe(1);
    expect(h.dbReads).toBe(2);
  });

  it('显式 custom provider 没有 title wire 时允许回落官方 xd', async () => {
    h.providers = [{ id: 'custom:deepseek' }, { id: 'xd' }];
    h.resolvedProviderId = 'xd';
    h.rows = [
      { ...VALID_ROW, providerId: 'custom:deepseek' },
      { ...VALID_ROW, providerId: 'custom:deepseek' },
    ];

    await expect(predict()).resolves.toBe('继续补测试');
    expect(h.beforeDispatchCalls).toBe(1);
    expect(h.dbReads).toBe(2);
  });

  it('provider 派发紧前观察到 Main 显式 Stop 时中止', async () => {
    notePromptPredictionSessionStopped('session-1');

    await expect(predict()).resolves.toBeNull();
    expect(h.beforeDispatchCalls).toBe(1);
    expect(h.dbReads).toBe(1);
  });

  it('provider 请求已发出后发生 Stop 时丢弃返回值', async () => {
    h.afterDispatch = () => notePromptPredictionSessionStopped('session-1');

    await expect(predict()).resolves.toBeNull();
    expect(h.beforeDispatchCalls).toBe(1);
    expect(h.dbReads).toBe(2);
  });

  it('首次复核发现 completion revision 已变化时中止付费派发', async () => {
    h.rows = [{ ...VALID_ROW, lastTurnEndedAt: 201 }];

    await expect(predict()).resolves.toBeNull();
    expect(h.beforeDispatchCalls).toBe(1);
    expect(h.dbReads).toBe(1);
  });

  it('异步 provider 检查期间同毫秒启动新 turn 时，终末复核中止派发', async () => {
    h.rows = [{ ...VALID_ROW }, { ...VALID_ROW, activeTurnStartedAt: 200 }];

    await expect(predict()).resolves.toBeNull();
    expect(h.beforeDispatchCalls).toBe(1);
    expect(h.dbReads).toBe(2);
  });
});
