import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  owner: 'owner-a:1',
  boundaryPending: false,
  afterDispatch: null as null | (() => void),
  requestUtilityText: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.owner,
  isAppSessionBoundaryPending: () => h.boundaryPending,
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
  notePromptPredictionSessionCancelled,
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
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.dbReads = 0;
  h.beforeDispatchCalls = 0;
  h.afterDispatch = null;
  h.models = [];
  h.owner = 'owner-a:1';
  h.boundaryPending = false;
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

afterEach(() => vi.useRealTimers());

describe('prompt prediction completion revision guard', () => {
  const timeout = {
    ok: false,
    reason: 'timeout',
    attempts: [{ status: 'failed', reason: 'timeout' }],
  };

  it('临时超时后在同一请求中补试一次并返回推荐', async () => {
    h.requestUtilityText.mockResolvedValueOnce(timeout);
    const pending = predict();
    await vi.advanceTimersByTimeAsync(1_499);
    expect(h.requestUtilityText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('继续补测试');
    expect(h.requestUtilityText).toHaveBeenCalledTimes(2);
  });

  it('连续临时失败最多补试一次，不无限重试', async () => {
    h.requestUtilityText.mockResolvedValue(timeout);
    const pending = predict();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeNull();
    expect(h.requestUtilityText).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 422])('HTTP %i 与超时混合失败时不重跑整条链', async (httpStatus) => {
    for (const permanentFirst of [true, false]) {
      h.requestUtilityText.mockClear();
      const permanent = { status: 'failed', reason: 'http_error', httpStatus };
      const transient = timeout.attempts[0];
      h.requestUtilityText.mockResolvedValueOnce({
        ok: false,
        reason: 'all_candidates_failed',
        attempts: permanentFirst ? [permanent, transient] : [transient, permanent],
      });
      const pending = predict();
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBeNull();
      expect(h.requestUtilityText).toHaveBeenCalledTimes(1);
    }
  });

  it('全部实际失败均为临时错误时仍可补试，跳过的候选不算执行失败', async () => {
    h.requestUtilityText.mockResolvedValueOnce({
      ok: false,
      reason: 'all_candidates_failed',
      attempts: [
        { status: 'skipped', reason: 'api_key_missing' },
        timeout.attempts[0],
        { status: 'failed', reason: 'http_error', httpStatus: 429 },
        { status: 'failed', reason: 'http_error', httpStatus: 503 },
      ],
    });
    const pending = predict();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe('继续补测试');
    expect(h.requestUtilityText).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ok: false, reason: 'no_candidate', attempts: [] },
    { ok: false, reason: 'all_candidates_failed', attempts: [{ status: 'failed', reason: 'http_error', httpStatus: 401 }] },
    { ok: true, text: 'invalid\nmultiline' },
  ])('不可用配置或不合格输出不触发重复付费: %j', async (result) => {
    h.requestUtilityText.mockResolvedValueOnce(result);
    await expect(predict()).resolves.toBeNull();
    expect(h.requestUtilityText).toHaveBeenCalledTimes(1);
  });

  it.each(['stop', 'new-turn', 'owner', 'boundary', 'models', 'disabled'])(
    '重试等待期间发生 %s 时不会派发旧请求', async (change) => {
      h.requestUtilityText.mockResolvedValueOnce(timeout);
      const paidDispatch = vi.fn();
      h.afterDispatch = paidDispatch;
      const pending = predict();
      await vi.advanceTimersByTimeAsync(1);
      if (change === 'stop') notePromptPredictionSessionStopped('session-1');
      if (change === 'new-turn') h.rows = [{ ...VALID_ROW, activeTurnStartedAt: 300 }];
      if (change === 'owner') h.owner = 'owner-b:2';
      if (change === 'boundary') h.boundaryPending = true;
      if (change === 'models') h.models = ['changed-model'];
      if (change === 'disabled') notePromptPredictionSessionCancelled('session-1', 200, h.owner);
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBeNull();
      expect(paidDispatch).not.toHaveBeenCalled();
      if (change === 'disabled') expect(h.requestUtilityText).toHaveBeenCalledTimes(1);
    },
  );

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

  it('请求准备期间关闭推荐时拦截首次付费派发', async () => {
    const paidDispatch = vi.fn();
    h.afterDispatch = paidDispatch;
    notePromptPredictionSessionCancelled('session-1', 200, h.owner);
    await expect(predict()).resolves.toBeNull();
    expect(paidDispatch).not.toHaveBeenCalled();
  });

  it('请求发出后关闭推荐时丢弃迟到结果', async () => {
    h.afterDispatch = () => notePromptPredictionSessionCancelled('session-1', 200, h.owner);
    await expect(predict()).resolves.toBeNull();
  });

  it('旧完成轮和旧账号的取消不影响当前推荐', async () => {
    notePromptPredictionSessionCancelled('session-1', 199, h.owner);
    await expect(predict()).resolves.toBe('继续补测试');
    notePromptPredictionSessionCancelled('session-1', 200, 'owner-other');
    await expect(predict()).resolves.toBe('继续补测试');
  });

  it('provider 请求已发出后切换 owner 时丢弃返回值', async () => {
    h.afterDispatch = () => { h.owner = 'owner-b:2'; };
    await expect(predict()).resolves.toBeNull();
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
