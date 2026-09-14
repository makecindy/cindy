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
  models: [] as string[],
  afterDispatch: null as null | (() => void),
  requestUtilityText: vi.fn(),
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

vi.mock('../../utility-model/auxiliary-model-settings-store.js', () => ({
  readAuxiliaryModelSettings: () => ({ models: h.models }),
}));

vi.mock('../../utility-model/oneShotCandidates.js', () => ({
  requestUtilityText: (...args: unknown[]) => h.requestUtilityText(...args),
}));

vi.mock('../../maker-host/index.js', () => ({
  getMaker: () => ({}),
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
  h.afterDispatch = null;
  h.models = [];
  h.rows = [{ ...VALID_ROW }, { ...VALID_ROW }];
  h.requestUtilityText.mockImplementation(
    async (_maker: unknown, _prompt: string, options: Record<string, unknown>) => {
      h.beforeDispatchCalls += 1;
      const allowed = await (
        options.beforeDispatch as (route?: unknown) => Promise<boolean>
      )({
        providerId: 'xd',
        agentKind: 'codex',
        model: 'gpt-5.4-mini',
      });
      if (allowed) h.afterDispatch?.();
      return allowed
        ? {
            ok: true,
            text: '继续补测试',
            providerId: 'xd',
            model: 'gpt-5.4-mini',
            transport: 'litellm-chat-completions',
          }
        : { ok: false, reason: 'all_candidates_failed', attempts: [] };
    },
  );
  resetPromptPredictionStopLedgerForTests();
});

describe('prompt prediction completion revision guard', () => {
  it('provider 派发紧前两次复核都匹配时允许预测', async () => {
    await expect(predict()).resolves.toBe('继续补测试');
    expect(h.beforeDispatchCalls).toBe(1);
    expect(h.dbReads).toBe(2);
    expect(h.requestUtilityText).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        disableReasoning: true,
        reasoningEffort: 'minimal',
        systemPrompt: expect.stringContaining('terse predictive text engine'),
      }),
    );
  });

  it('会话 custom provider 不挡 utility 预测', async () => {
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
