/**
 * translator.translateErrorNotification — auth retry-loop dedupe + isAuthMissing 触发。
 *
 * 覆盖 fix(desktop,maker-core): 远端 codex daemon 重启 / auth 状态异常的端到端恢复
 * 这一 commit 里 ❶+❹ 修法的核心 invariant (❶ 后经 issue #677 泛化):
 *   1. willRetry=true + transient (非 auth) → 第 1 次 silent; 同 turn 第 2 次透出
 *      **一条**非终止提示 (#677 起不再限定 networkish pattern), 之后静默
 *   2. willRetry=true + auth 关键字 → push 第一条, 同 thread+turn 后续 dedupe
 *   3. willRetry=true + auth + 不同 turn → key reset, 又能 push
 *   4. willRetry=false → 不论 auth 与否都 push
 */

import { describe, expect, it } from 'vitest';

import {
  extractRolloutUpdatePlanFunctionCallEvent,
  newCodexRuntimeState,
  translateErrorNotification,
  translateAccountRateLimitsUpdated,
  translateItemNotification,
  translatePlanUpdatedNotification,
} from './translator.js';
import type { CodexRuntimeState } from './translator.js';
import type { CodexErrorInfo } from './app-server/protocol.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import type { AsyncQueue } from '../shared/async-queue.js';
import type { AgentEvent } from '../../types/events.js';

function noopLog(): {
  info: () => void;
  warn: () => void;
  error: () => void;
  debug: () => void;
} {
  return { info: (): void => undefined, warn: (): void => undefined, error: (): void => undefined, debug: (): void => undefined };
}

function makeCtx(rt: CodexRuntimeState): {
  rt: CodexRuntimeState;
  log: ReturnType<typeof noopLog>;
} {
  return { rt, log: noopLog() };
}

function makeParams(opts: {
  willRetry: boolean;
  message: string;
  threadId?: string;
  turnId?: string;
  codexErrorInfo?: CodexErrorInfo;
}): {
  threadId: string;
  turnId: string;
  willRetry: boolean;
  error: { message: string; codexErrorInfo?: CodexErrorInfo };
} {
  return {
    threadId: opts.threadId ?? 't1',
    turnId: opts.turnId ?? 'turn-a',
    willRetry: opts.willRetry,
    error: {
      message: opts.message,
      ...(opts.codexErrorInfo !== undefined ? { codexErrorInfo: opts.codexErrorInfo } : {}),
    },
  };
}

async function collect(queue: AsyncQueue<AgentEvent>): Promise<AgentEvent[]> {
  queue.end();
  const out: AgentEvent[] = [];
  for await (const ev of queue) out.push(ev);
  return out;
}

describe('translateAccountRateLimitsUpdated', () => {
  it('normalizes Codex 0.144 windowDurationMins before emitting account usage', async () => {
    const q = createAsyncQueue<AgentEvent>();
    translateAccountRateLimitsUpdated({
      rateLimits: {
        primary: { usedPercent: 100, windowDurationMins: 300 },
        secondary: { usedPercent: 25, windowMinutes: 10080, windowDurationMins: 60 },
      },
    }, q, makeCtx(newCodexRuntimeState()));

    const events = await collect(q);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'account_usage',
      source: 'codex',
      data: {
        primary: { usedPercent: 100, windowMinutes: 300, windowDurationMins: 300 },
        secondary: { usedPercent: 25, windowMinutes: 10080, windowDurationMins: 60 },
      },
    });
  });
});

describe('translateErrorNotification', () => {
  it('redacts producer logs and preserves non-secret error signals', async () => {
    const rt = newCodexRuntimeState();
    const warnings: Record<string, unknown>[] = [];
    const ctx = {
      rt,
      log: {
        ...noopLog(),
        warn: (_message: string, data?: Record<string, unknown>) => {
          if (data) warnings.push(data);
        },
      },
    };
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({
        willRetry: false,
        message: 'Authorization: Bearer secret-token, quota exhausted, status=429',
      }),
      q,
      ctx,
    );

    const events = await collect(q);
    expect(events[0]!.data).toMatchObject({
      message: 'Authorization: [REDACTED]',
      errorStatus: 429,
      usageLimit: true,
    });
    expect(JSON.stringify(warnings)).not.toContain('secret-token');
    expect(warnings[0]).toMatchObject({ message: 'Authorization: [REDACTED]' });
  });
  it('willRetry=true transient → silent (no event pushed)', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({ willRetry: true, message: 'transient 502 from upstream' }),
      q,
      makeCtx(rt),
    );
    const events = await collect(q);
    expect(events).toHaveLength(0);
  });

  it('willRetry=true + 401 → push first event', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({
        willRetry: true,
        message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
      }),
      q,
      makeCtx(rt),
    );
    const events = await collect(q);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].data).toMatchObject({ isTerminal: false, willRetry: true });
  });

  it('willRetry=true + Unauthorized + Missing bearer 都命中 isAuthMissing', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({ willRetry: true, message: 'auth: Missing bearer or basic authentication' }),
      q,
      makeCtx(rt),
    );
    const events = await collect(q);
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ isTerminal: false, willRetry: true });
  });

  it('preserves Missing bearer classification when Authorization redaction consumes the phrase', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({
        willRetry: true,
        message: 'Authorization: Bearer secret-token, Missing bearer',
      }),
      q,
      makeCtx(rt),
    );

    const events = await collect(q);
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({
      message: 'Authorization: [REDACTED]',
      errorStatus: 401,
      isTerminal: false,
      willRetry: true,
    });
    expect(JSON.stringify(events)).not.toContain('secret-token');
  });

  it.each(['authentication_error', 'invalid api key'])(
    'preserves %s classification when Authorization redaction consumes the marker',
    async (authMarker) => {
      const rt = newCodexRuntimeState();
      const q = createAsyncQueue<AgentEvent>();
      translateErrorNotification(
        makeParams({
          willRetry: true,
          message: `Authorization: Bearer secret-token, ${authMarker}`,
        }),
        q,
        makeCtx(rt),
      );

      const events = await collect(q);
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({
        message: 'Authorization: [REDACTED]',
        errorStatus: 401,
        isTerminal: false,
        willRetry: true,
      });
      expect(JSON.stringify(events)).not.toContain('secret-token');
    },
  );

  it('willRetry=true + 401 同 thread+turn 再次触发 → dedupe (no push)', async () => {
    const rt = newCodexRuntimeState();
    const ctx = makeCtx(rt);
    const q = createAsyncQueue<AgentEvent>();
    // 第一条: emit
    translateErrorNotification(
      makeParams({ willRetry: true, message: '401 Unauthorized cf-ray:a1' }),
      q,
      ctx,
    );
    // 第二条: 同 thread+turn, cf-ray 不同但 isAuthMissing 命中 → dedupe
    translateErrorNotification(
      makeParams({ willRetry: true, message: '401 Unauthorized cf-ray:b2 different request-id' }),
      q,
      ctx,
    );
    // 第三条: 同上
    translateErrorNotification(
      makeParams({ willRetry: true, message: '401 Unauthorized cf-ray:c3' }),
      q,
      ctx,
    );
    const events = await collect(q);
    expect(events).toHaveLength(1);
  });

  it('willRetry=true + 401 不同 turn → key reset, 各 emit 一次', async () => {
    const rt = newCodexRuntimeState();
    const ctx = makeCtx(rt);
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({ willRetry: true, message: '401 cf-ray:a', turnId: 'turn-A' }),
      q,
      ctx,
    );
    // 模拟新 turn 开始: codex/index.ts turnStarted handler 会 reset 这个 key。
    rt.lastAuthErrorKey = null;
    translateErrorNotification(
      makeParams({ willRetry: true, message: '401 cf-ray:b', turnId: 'turn-B' }),
      q,
      ctx,
    );
    const events = await collect(q);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.data)).toEqual([
      expect.objectContaining({ isTerminal: false, willRetry: true }),
      expect.objectContaining({ isTerminal: false, willRetry: true }),
    ]);
  });

  it('willRetry=false 真错误 → 一律 push, 不受 dedupe key 影响', async () => {
    const rt = newCodexRuntimeState();
    // 预置一个 dedupe key (假装上轮 retry 已经触发过)
    rt.lastAuthErrorKey = 't1|turn-a';
    const ctx = makeCtx(rt);
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({ willRetry: false, message: '401 final upgrade after 10 retries' }),
      q,
      ctx,
    );
    const events = await collect(q);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].data).toMatchObject({ isTerminal: true, willRetry: false });
  });

  it('willRetry=false 非 auth 错误 → push', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({ willRetry: false, message: 'rate limit reached' }),
      q,
      makeCtx(rt),
    );
    const events = await collect(q);
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ isTerminal: true, willRetry: false });
  });

  it('willRetry=false 模型容量不足 + agent 层接管 → 非终止 + 带重投进度', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const calls: number[] = [];
    translateErrorNotification(
      makeParams({
        willRetry: false,
        message: 'Selected model is at capacity. Please try a different model.',
      }),
      q,
      {
        ...makeCtx(rt),
        tryTakeOverOverload: () => {
          calls.push(1);
          return { attempt: 2, maxAttempts: 4 };
        },
      },
    );
    const events = await collect(q);
    expect(calls).toHaveLength(1);
    expect(events).toHaveLength(1);
    // 必须是非终止：终止会让 UI 先收口成失败，用户看到假失败闪烁。
    expect(events[0].data).toMatchObject({ isTerminal: false, willRetry: true });
    // 原始错误原文保留（renderer 折叠可查），进度以后缀编码。
    expect((events[0].data as { message: string }).message).toBe(
      'Selected model is at capacity. Please try a different model. (auto-retry 2/4)',
    );
  });

  it('过载错误带稳定 reason key，供 renderer 隔 IPC 判定（非终止与终止两条路径）', async () => {
    // renderer 拿不到 codexErrorInfo(跨 IPC 投影只留 message 字符串), 靠这个 key 渲染
    // 本地化重试进度与过载引导。两条路径都必须带, 否则退避窗口内或耗尽后有一边退回
    // 英文原文 —— 也就是本次改动要消除的依赖在 UI 侧原样残留。
    const rt = newCodexRuntimeState();
    const q1 = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({
        willRetry: false,
        message: 'The upstream declined this request.',
        codexErrorInfo: 'serverOverloaded',
      }),
      q1,
      { ...makeCtx(rt), tryTakeOverOverload: () => ({ attempt: 1, maxAttempts: 4 }) },
    );
    const nonTerminal = await collect(q1);
    expect(nonTerminal[0]!.data).toMatchObject({
      reason: 'upstream-overload',
      isTerminal: false,
    });

    // 接管不成立(预算耗尽 / 本 turn 已有产出) → 终止路径, reason 同样要带。
    const q2 = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({
        willRetry: false,
        message: 'The upstream declined this request.',
        codexErrorInfo: 'serverOverloaded',
      }),
      q2,
      { ...makeCtx(rt), tryTakeOverOverload: () => null },
    );
    const terminal = await collect(q2);
    expect(terminal[0]!.data).toMatchObject({
      reason: 'upstream-overload',
      isTerminal: true,
    });
  });

  it('非过载错误不得带过载 reason key', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({ willRetry: false, message: 'tool failed: file not found' }),
      q,
      makeCtx(rt),
    );
    const events = await collect(q);
    expect(events[0]!.data).not.toHaveProperty('reason');
  });

  it('上下文超限终止错误带 context-overflow reason(#1429): 原样重试必败, renderer 靠它换恢复动作', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({
        willRetry: false,
        message:
          '400 Bad Request: {"error": {"message": "Your input exceeds the context window of this model.", "code": "context_length_exceeded"}}',
      }),
      q,
      makeCtx(rt),
    );
    const events = await collect(q);
    expect(events[0]!.data).toMatchObject({
      reason: 'context-overflow',
      isTerminal: true,
    });
  });

  it('Codex 结构化 contextWindowExceeded tag 不依赖错误文案措辞', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({
        willRetry: false,
        message: 'The request cannot be processed.',
        codexErrorInfo: 'contextWindowExceeded',
      }),
      q,
      makeCtx(rt),
    );
    const events = await collect(q);
    expect(events[0]!.data).toMatchObject({
      codexErrorInfo: 'contextWindowExceeded',
      reason: 'context-overflow',
      isTerminal: true,
    });
  });

  it('serverOverloaded tag 优先于文案里的上下文超限信号', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({
        willRetry: false,
        message: 'Your input exceeds the context window of this model.',
        codexErrorInfo: 'serverOverloaded',
      }),
      q,
      { ...makeCtx(rt), tryTakeOverOverload: () => null },
    );
    const events = await collect(q);
    expect(events[0]!.data).toMatchObject({
      codexErrorInfo: 'serverOverloaded',
      reason: 'upstream-overload',
      isTerminal: true,
    });
  });

  it('终态 429 被 agent 接管时透成非终止限流进度且不冒充过载', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({
        willRetry: false,
        message: 'exceeded retry limit, last status: 429 Too Many Requests',
      }),
      q,
      {
        ...makeCtx(rt),
        tryTakeOverTerminalRateLimit: () => ({ attempt: 1, maxAttempts: 2 }),
      },
    );
    const events = await collect(q);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      errorStatus: 429,
      isTerminal: false,
      willRetry: true,
      reason: 'terminal-rate-limit-retry',
    });
    expect((events[0]!.data as { message: string }).message).toContain(
      'rate-limit-retry 1/2',
    );
    expect((events[0]!.data as { message: string }).message).not.toContain('auto-retry');
  });

  it('容量拒绝改了文案措辞时，结构化 tag 仍触发接管重投', async () => {
    // 本用例锁的是这次改动的核心目标: 重投不再依赖 codex 的英文文案。
    // message 故意完全不含 "at capacity" —— 模拟 codex 升级改了措辞。若判定回退到
    // 文案匹配, tryTakeOverOverload 不会被调用, 这里立刻失败。
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const calls: number[] = [];
    translateErrorNotification(
      makeParams({
        willRetry: false,
        message: 'The upstream declined this request.',
        codexErrorInfo: 'serverOverloaded',
      }),
      q,
      {
        ...makeCtx(rt),
        tryTakeOverOverload: () => {
          calls.push(1);
          return { attempt: 1, maxAttempts: 4 };
        },
      },
    );
    const events = await collect(q);
    expect(calls).toHaveLength(1);
    expect(events[0].data).toMatchObject({ isTerminal: false, willRetry: true });
    expect((events[0].data as { message: string }).message).toBe(
      'The upstream declined this request. (auto-retry 1/4)',
    );
  });

  it('结构化 tag 透出到 error data，且不干扰既有 errorStatus 推断', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({
        willRetry: false,
        message: 'Selected model is at capacity.',
        codexErrorInfo: 'serverOverloaded',
      }),
      q,
      { ...makeCtx(rt), tryTakeOverOverload: () => null },
    );
    const events = await collect(q);
    expect(events[0].data).toMatchObject({ codexErrorInfo: 'serverOverloaded' });
    // 容量文案里没有 401/429 信号, 既有推断必须保持不变(不得被新字段带偏)。
    expect(events[0].data).not.toHaveProperty('errorStatus');
    expect(events[0].data).not.toHaveProperty('usageLimit');
  });

  it('对象形态的 codexErrorInfo 取单键作为 tag，且不误判成过载', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const calls: number[] = [];
    translateErrorNotification(
      makeParams({
        willRetry: false,
        message: 'stream disconnected before completion',
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
      }),
      q,
      {
        ...makeCtx(rt),
        tryTakeOverOverload: () => {
          calls.push(1);
          return { attempt: 1, maxAttempts: 4 };
        },
      },
    );
    const events = await collect(q);
    // 流断开不是容量拒绝: 不得接管重投(它有自己的重连路径)。
    expect(calls).toHaveLength(0);
    expect(events[0].data).toMatchObject({
      codexErrorInfo: 'responseStreamDisconnected',
      isTerminal: true,
    });
  });

  it('老 daemon 不发 codexErrorInfo 时按文案兜底，行为不变', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const calls: number[] = [];
    translateErrorNotification(
      makeParams({ willRetry: false, message: 'Selected model is at capacity.' }),
      q,
      {
        ...makeCtx(rt),
        tryTakeOverOverload: () => {
          calls.push(1);
          return { attempt: 1, maxAttempts: 4 };
        },
      },
    );
    const events = await collect(q);
    expect(calls).toHaveLength(1);
    expect(events[0].data).not.toHaveProperty('codexErrorInfo');
  });

  it('willRetry=false 模型容量不足 + agent 层不接管 → 落回终止错误', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({ willRetry: false, message: 'Selected model is at capacity.' }),
      q,
      // 预算耗尽 / 本 turn 已有产出 / 会话已关时 agent 层返回 null。
      { ...makeCtx(rt), tryTakeOverOverload: () => null },
    );
    const events = await collect(q);
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ isTerminal: true, willRetry: false });
    // 没接管就不能挂进度后缀，否则 renderer 会把已放弃的错误显示成"正在重试"。
    expect((events[0].data as { message: string }).message).not.toContain('auto-retry');
  });

  it('没有注入接管钩子时容量错误按原终止路径报', async () => {
    // 非 codex/index.ts 的调用方（既有测试、其它宿主）不受本分支影响。
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({ willRetry: false, message: 'Selected model is at capacity.' }),
      q,
      makeCtx(rt),
    );
    const events = await collect(q);
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ isTerminal: true, willRetry: false });
  });

  it('willRetry=true 的容量错误不走接管（server 自己还在重试）', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    let takeOverCalled = false;
    translateErrorNotification(
      makeParams({ willRetry: true, message: 'Selected model is at capacity.' }),
      q,
      {
        ...makeCtx(rt),
        tryTakeOverOverload: () => {
          takeOverCalled = true;
          return { attempt: 1, maxAttempts: 4 };
        },
      },
    );
    const events = await collect(q);
    // 双层重试是反模式：server 说自己会重试时我们绝不插手。
    expect(takeOverCalled).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('非容量类的终止错误不触发接管', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    let takeOverCalled = false;
    translateErrorNotification(
      makeParams({ willRetry: false, message: 'context window exceeded' }),
      q,
      {
        ...makeCtx(rt),
        tryTakeOverOverload: () => {
          takeOverCalled = true;
          return { attempt: 1, maxAttempts: 4 };
        },
      },
    );
    const events = await collect(q);
    expect(takeOverCalled).toBe(false);
    expect(events[0].data).toMatchObject({ isTerminal: true });
  });

  it('newCodexRuntimeState() 初始 lastAuthErrorKey 为 null', () => {
    const rt = newCodexRuntimeState();
    expect(rt.lastAuthErrorKey).toBeNull();
    expect(rt.networkRetryNotice).toBeNull();
  });

  it('willRetry=true Codex 重连进度 → 每一档都透出为非终止状态', async () => {
    const rt = newCodexRuntimeState();
    const ctx = makeCtx(rt);
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({ willRetry: true, message: 'Reconnecting... 1/5' }),
      q,
      ctx,
    );
    translateErrorNotification(
      makeParams({
        willRetry: true,
        message: 'Reconnecting... 2/5 (stream disconnected before completion)',
      }),
      q,
      ctx,
    );
    const events = await collect(q);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.data)).toEqual([
      expect.objectContaining({
        message: 'Reconnecting... 1/5',
        isTerminal: false,
        willRetry: true,
      }),
      expect.objectContaining({
        message: 'Reconnecting... 2/5 (stream disconnected before completion)',
        isTerminal: false,
        willRetry: true,
      }),
    ]);
  });

  it('仅按脱敏后的可见文案识别重连进度', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({
        willRetry: true,
        message: 'Authorization: Bearer secret-token Reconnecting... 1/5',
      }),
      q,
      makeCtx(rt),
    );

    const events = await collect(q);
    expect(events).toHaveLength(0);
  });

  it('willRetry=true 网络类错误同 turn 第 2 次 → 透出一条非终止提示,之后不再发', async () => {
    const rt = newCodexRuntimeState();
    const ctx = makeCtx(rt);
    const q = createAsyncQueue<AgentEvent>();
    const message =
      'unexpected status 502 Bad Gateway: upstream unreachable: AggregateError, url: http://127.0.0.1:56928/responses';
    // 第 1 次:单次抖动,不透出。
    translateErrorNotification(makeParams({ willRetry: true, message }), q, ctx);
    // 第 2 次:daemon 卡 retry-loop 的信号,透出一条(isTerminal:false,不结束 turn)。
    translateErrorNotification(makeParams({ willRetry: true, message }), q, ctx);
    // 第 3、4 次:同 turn 已透出过,防风暴不再发。
    translateErrorNotification(makeParams({ willRetry: true, message }), q, ctx);
    translateErrorNotification(makeParams({ willRetry: true, message }), q, ctx);
    const events = await collect(q);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].data).toMatchObject({ isTerminal: false, willRetry: true, message });
  });

  it('willRetry=true 网络类错误跨 turn:turnStarted 重置后可再透出', async () => {
    const rt = newCodexRuntimeState();
    const ctx = makeCtx(rt);
    const q = createAsyncQueue<AgentEvent>();
    translateErrorNotification(
      makeParams({ willRetry: true, message: 'ECONNREFUSED 127.0.0.1:56928', turnId: 'turn-A' }),
      q,
      ctx,
    );
    translateErrorNotification(
      makeParams({ willRetry: true, message: 'ECONNREFUSED 127.0.0.1:56928', turnId: 'turn-A' }),
      q,
      ctx,
    );
    // 模拟新 turn 开始: codex/index.ts turnStarted handler 重置透出状态。
    rt.networkRetryNotice = null;
    translateErrorNotification(
      makeParams({ willRetry: true, message: 'ECONNREFUSED 127.0.0.1:56928', turnId: 'turn-B' }),
      q,
      ctx,
    );
    translateErrorNotification(
      makeParams({ willRetry: true, message: 'ECONNREFUSED 127.0.0.1:56928', turnId: 'turn-B' }),
      q,
      ctx,
    );
    const events = await collect(q);
    expect(events).toHaveLength(2);
  });

  it('willRetry=true 非网络非 auth 错误 → 第 2 次同样透出一条(issue #677 泛化),之后静默', async () => {
    // #677 之前只透 networkish pattern; 但 "rate limit backing off" / 403 /
    // websocket unreachable 这类持续性重试同样是「daemon 空转」信号, 用户必须
    // 能看到一条非终止提示。终局收口由 TurnRetryTracker 升级负责 (不在这里)。
    const rt = newCodexRuntimeState();
    const ctx = makeCtx(rt);
    const q = createAsyncQueue<AgentEvent>();
    for (let i = 0; i < 3; i += 1) {
      translateErrorNotification(
        makeParams({ willRetry: true, message: 'rate limit reached, backing off' }),
        q,
        ctx,
      );
    }
    const events = await collect(q);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].data).toMatchObject({ isTerminal: false, willRetry: true });
  });

  it('willRetry=true 远端后端不可达文案 (403 / websocket unreachable) → 第 2 次透出提示', async () => {
    // issue #677 的原始断链面: 这两类文案不匹配旧的 networkish pattern,
    // 远端 daemon retry-loop 时 UI 一条事件都收不到。
    const rt = newCodexRuntimeState();
    const ctx = makeCtx(rt);
    const q = createAsyncQueue<AgentEvent>();
    const messages = [
      'unexpected status 403 Forbidden, url: https://chatgpt.com/backend-api/codex/responses',
      'failed to connect to websocket: Network unreachable',
    ];
    for (let round = 0; round < 2; round += 1) {
      for (const message of messages) {
        translateErrorNotification(makeParams({ willRetry: true, message }), q, ctx);
      }
    }
    const events = await collect(q);
    // 同 thread+turn 只透一条 (第 2 次触发时), 与其余重试风暴隔离。
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ isTerminal: false, willRetry: true });
  });
});

describe('translateItemNotification contextCompaction', () => {
  it('preserves the Codex item id as the compact boundary identity', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();

    translateItemNotification(
      'completed',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'contextCompaction',
          id: 'compact-item-1',
        },
      },
      q,
      makeCtx(rt),
    );

    const events = await collect(q);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'compact_boundary',
        data: expect.objectContaining({ boundaryId: 'compact-item-1' }),
      }),
    ]);
  });
});

describe('translateItemNotification commandExecution output normalization', () => {
  it('keeps the raw PowerShell wrapper command and emits a display command for tool_use display', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const ctx = makeCtx(rt);
    const rawCommand =
      '"C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.3.0_x64__8wekyb3d8bbwe\\pwsh.exe" -Command \'pnpm --filter @cindy/maker-core build\'';

    translateItemNotification(
      'started',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-wrapper',
          command: rawCommand,
          cwd: 'E:\\xdt-maker',
          status: 'inProgress',
        },
      },
      q,
      ctx,
    );

    const events = await collect(q);
    expect(events[0]).toMatchObject({
      type: 'tool_use',
      data: {
        toolUseId: 'cmd-wrapper',
        toolName: 'exec',
        input: {
          command: rawCommand,
          cwd: 'E:\\xdt-maker',
          displayCommand: 'pnpm --filter @cindy/maker-core build',
        },
      },
    });
  });

  it('keeps escaped quotes inside quoted PowerShell wrapper command arguments', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const ctx = makeCtx(rt);
    const rawCommand = '"C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.3.0_x64__8wekyb3d8bbwe\\pwsh.exe" -Command "Write-Output \\"hello world\\""';

    translateItemNotification(
      'started',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-wrapper-escaped-quotes',
          command: rawCommand,
          cwd: 'E:\\xdt-maker',
          status: 'inProgress',
        },
      },
      q,
      ctx,
    );

    const events = await collect(q);
    expect(events[0]).toMatchObject({
      type: 'tool_use',
      data: {
        input: {
          command: rawCommand,
          displayCommand: 'Write-Output "hello world"',
        },
      },
    });
  });

  it('keeps PowerShell backtick-escaped quotes inside quoted wrapper command arguments', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const ctx = makeCtx(rt);
    const rawCommand = '"C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.3.0_x64__8wekyb3d8bbwe\\pwsh.exe" -Command "Write-Output `"hello world`""';

    translateItemNotification(
      'started',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-wrapper-backtick-quotes',
          command: rawCommand,
          cwd: 'E:\\xdt-maker',
          status: 'inProgress',
        },
      },
      q,
      ctx,
    );

    const events = await collect(q);
    expect(events[0]).toMatchObject({
      type: 'tool_use',
      data: {
        input: {
          command: rawCommand,
          displayCommand: 'Write-Output "hello world"',
        },
      },
    });
  });

  it('passes commandActions through into the tool_use input verbatim', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const ctx = makeCtx(rt);
    const commandActions = [
      { type: 'search', command: 'rg foo src', query: 'foo', path: 'src' },
      { type: 'unknown', command: 'head -5' },
    ];

    translateItemNotification(
      'started',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-actions',
          command: 'rg foo src | head -5',
          cwd: '/repo',
          status: 'inProgress',
          commandActions,
        },
      },
      q,
      ctx,
    );

    const events = await collect(q);
    expect(events[0]).toMatchObject({
      type: 'tool_use',
      data: {
        toolUseId: 'cmd-actions',
        toolName: 'exec',
        input: {
          command: 'rg foo src | head -5',
          cwd: '/repo',
          commandActions,
        },
      },
    });
  });

  it('omits commandActions from the tool_use input when absent or empty', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const ctx = makeCtx(rt);

    translateItemNotification(
      'started',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-no-actions',
          command: 'git status',
          cwd: '/repo',
          status: 'inProgress',
          commandActions: [],
        },
      },
      q,
      ctx,
    );

    const events = await collect(q);
    const input = (events[0] as { data: { input: Record<string, unknown> } }).data.input;
    expect(input).not.toHaveProperty('commandActions');
  });

  it('does not emit a display command when the quoted wrapper command has unsafe trailing text', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const ctx = makeCtx(rt);
    const rawCommand = '"C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.3.0_x64__8wekyb3d8bbwe\\pwsh.exe" -Command "Write-Output "hello world""';

    translateItemNotification(
      'started',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-wrapper-unsafe-quotes',
          command: rawCommand,
          cwd: 'E:\\xdt-maker',
          status: 'inProgress',
        },
      },
      q,
      ctx,
    );

    const events = await collect(q);
    expect((events[0]?.data as { input?: Record<string, unknown> }).input).toMatchObject({
      command: rawCommand,
      cwd: 'E:\\xdt-maker',
    });
    expect((events[0]?.data as { input?: Record<string, unknown> }).input).not.toHaveProperty('displayCommand');
  });

  it('does not rewrite an explicit bare pwsh command', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const ctx = makeCtx(rt);

    translateItemNotification(
      'started',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-pwsh',
          command: "pwsh -Command 'echo hi'",
          cwd: '/tmp/project',
          status: 'inProgress',
        },
      },
      q,
      ctx,
    );

    const events = await collect(q);
    expect(events[0]).toMatchObject({
      type: 'tool_use',
      data: {
        toolUseId: 'cmd-pwsh',
        toolName: 'exec',
        input: {
          command: "pwsh -Command 'echo hi'",
          cwd: '/tmp/project',
        },
      },
    });
    expect((events[0]?.data as { input?: Record<string, unknown> }).input).not.toHaveProperty('displayCommand');
  });

  it('strips terminal control sequences before emitting tool_result_full', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const ctx = makeCtx(rt);

    translateItemNotification(
      'completed',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-ansi',
          command: 'Select-String -Pattern codegraph',
          cwd: 'E:\\xdt-maker',
          status: 'completed',
          aggregatedOutput: '\u001B[7mcodegraph\u001B[0m\n\u001B]8;;https://example.com\u0007link\u001B]8;;\u0007',
          exitCode: 0,
        },
      },
      q,
      ctx,
    );

    const events = await collect(q);
    const full = events.find((event) => event.type === 'tool_result_full');
    expect(full?.data).toMatchObject({
      toolUseId: 'cmd-ansi',
      fullText: 'codegraph\nlink',
      isError: false,
    });
  });
});

describe('translateItemNotification collabAgentToolCall', () => {
  it('emits provider-neutral task updates alongside existing tool events', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const ctx = makeCtx(rt);
    const started = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'collabAgentToolCall',
        id: 'collab-1',
        tool: 'spawnAgent',
        status: 'inProgress',
        senderThreadId: 'thread-1',
        receiverThreadIds: ['thread-2'],
        prompt: 'Review the auth flow',
        model: 'gpt-5.4',
        reasoningEffort: 'high',
        agentsStates: {},
      },
    };
    const completed = {
      ...started,
      item: {
        ...started.item,
        status: 'completed',
        agentsStates: { 'thread-2': { status: 'done' } },
      },
    };

    translateItemNotification('started', started, q, ctx);
    translateItemNotification('completed', completed, q, ctx);

    const events = await collect(q);
    expect(events.map((event) => event.type)).toEqual([
      'tool_use',
      'agent_task_update',
      'tool_result_full',
      'tool_result',
      'agent_task_update',
    ]);
    expect(events[1].data).toMatchObject({
      provider: 'codex',
      taskId: 'collab-1',
      parentToolUseId: 'collab-1',
      status: 'running',
      title: 'spawnAgent',
      description: 'Review the auth flow',
      receiverThreadIds: ['thread-2'],
    });
    expect(events[2].data).toMatchObject({
      toolUseId: 'collab-1',
      fullText: 'thread-2: done',
    });
    expect(events[4].data).toMatchObject({
      provider: 'codex',
      status: 'completed',
      summary: 'thread-2: done',
    });
  });
});

describe('translateItemNotification subAgentActivity', () => {
  function activityParams(kind: string, id = 'spawn-1') {
    return {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'subAgentActivity',
        id,
        kind,
        agentThreadId: 'thread-2',
        agentPath: '/root/survey_startup',
      },
    };
  }

  it('renders a running spawn card for kind=started (0.145 v2 emits no collab item)', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const ctx = makeCtx(rt);

    translateItemNotification('started', activityParams('started'), q, ctx);

    const events = await collect(q);
    expect(events.map((event) => event.type)).toEqual([
      'tool_use',
      'tool_result_full',
      'tool_result',
      'agent_task_update',
    ]);
    expect(events[0].data).toMatchObject({
      toolUseId: 'spawn-1',
      toolName: 'collab:spawn',
      input: { name: '/root/survey_startup', agentThreadId: 'thread-2' },
    });
    // fullText 是纯数据(agentPath 原文),本地化句子由 renderer 组装,不持久化英文。
    expect(events[1].data).toMatchObject({
      toolUseId: 'spawn-1',
      fullText: '/root/survey_startup',
      isError: false,
    });
    // tool_result 就地收口(不留悬空工具调用),卡片状态由 update 主导 → 仍显示运行中,
    // 后续 tokens / 工具数 / 终态由子线程通知按同一 taskId 增量刷新。
    expect(events[3].data).toMatchObject({
      provider: 'codex',
      taskId: 'spawn-1',
      parentToolUseId: 'spawn-1',
      status: 'running',
      title: '/root/survey_startup',
    });
  });

  it('dedupes the started/completed phase pair and releases the dedupe entry', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const ctx = makeCtx(rt);

    translateItemNotification('started', activityParams('started'), q, ctx);
    translateItemNotification('completed', activityParams('started'), q, ctx);

    const events = await collect(q);
    expect(events.filter((event) => event.type === 'tool_use')).toHaveLength(1);
    // completed 清理去重登记,长会话大量 spawn 不留内存增长(review r3698551514)。
    expect(rt.emittedToolUse.has('spawn-1')).toBe(false);
  });

  it('stays silent for interacted/interrupted kinds', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const ctx = makeCtx(rt);

    translateItemNotification('completed', activityParams('interacted', 'act-1'), q, ctx);
    translateItemNotification('completed', activityParams('interrupted', 'act-2'), q, ctx);

    const events = await collect(q);
    expect(events).toEqual([]);
  });
});

describe('translateItemNotification plan', () => {
  it('emits update_plan on started and completed, with result only on completed', async () => {
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const ctx = makeCtx(rt);
    const params = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'plan',
        id: 'plan-1',
        text: '1. Read code\n2. Patch UI\n3. Run tests',
      },
    };

    translateItemNotification('started', params, q, ctx);
    translateItemNotification('completed', params, q, ctx);

    const events = await collect(q);
    expect(events.map((event) => event.type)).toEqual([
      'tool_use',
      'tool_use',
      'tool_result_full',
      'tool_result',
    ]);
    expect(events[0].data).toMatchObject({
      toolUseId: 'plan-1',
      toolName: 'update_plan',
      input: { text: '1. Read code\n2. Patch UI\n3. Run tests' },
    });
    expect(events[1].data).toMatchObject({
      toolUseId: 'plan-1',
      toolName: 'update_plan',
      input: { text: '1. Read code\n2. Patch UI\n3. Run tests' },
    });
    expect(events[2].data).toMatchObject({
      toolUseId: 'plan-1',
      fullText: '1. Read code\n2. Patch UI\n3. Run tests',
      isError: false,
    });
    expect(events[3].data).toMatchObject({
      summary: 'plan updated',
      toolUseIds: ['plan-1'],
    });
  });
});

describe('translatePlanUpdatedNotification', () => {
  it('emits stable update_plan tool_use events for Codex native plan updates', async () => {
    const q = createAsyncQueue<AgentEvent>();

    translatePlanUpdatedNotification(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        explanation: 'Working through the implementation.',
        plan: [
          { step: 'Read logs', status: 'completed' },
          { step: 'Patch translator', status: 'in_progress' },
          { step: 'Run tests', status: 'pending' },
        ],
      },
      q,
    );
    translatePlanUpdatedNotification(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        plan: [
          { step: 'Read logs', status: 'completed' },
          { step: 'Patch translator', status: 'completed' },
          { step: 'Run tests', status: 'in_progress' },
        ],
      },
      q,
    );

    const events = await collect(q);
    expect(events).toHaveLength(2);
    expect(events[0].data).toMatchObject({
      toolUseId: 'plan:turn-1',
      toolName: 'update_plan',
      input: {
        explanation: 'Working through the implementation.',
        plan: [
          { step: 'Read logs', status: 'completed' },
          { step: 'Patch translator', status: 'in_progress' },
          { step: 'Run tests', status: 'pending' },
        ],
      },
    });
    expect(events[1].data).toMatchObject({
      toolUseId: 'plan:turn-1',
      toolName: 'update_plan',
      input: {
        plan: [
          { step: 'Read logs', status: 'completed' },
          { step: 'Patch translator', status: 'completed' },
          { step: 'Run tests', status: 'in_progress' },
        ],
      },
    });
  });
});

describe('extractRolloutUpdatePlanFunctionCallEvent', () => {
  it('extracts Codex rollout response_item function_call update_plan entries', () => {
    const parsed = extractRolloutUpdatePlanFunctionCallEvent(
      {
        timestamp: '2026-06-24T02:44:14.833Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'update_plan',
          arguments: JSON.stringify({
            plan: [
              { step: 'Read logs', status: 'completed' },
              { step: 'Patch fallback', status: 'in_progress' },
            ],
          }),
          call_id: 'call_1',
          internal_chat_message_metadata_passthrough: {
            turn_id: 'turn-1',
          },
        },
      },
      undefined,
      { requireTurnId: true },
    );

    expect(parsed?.callId).toBe('call_1');
    expect(parsed?.turnId).toBe('turn-1');
    expect(parsed?.event).toMatchObject({
      type: 'tool_use',
      source: 'codex',
      data: {
        toolUseId: 'plan:turn-1',
        toolName: 'update_plan',
        input: {
          plan: [
            { step: 'Read logs', status: 'completed' },
            { step: 'Patch fallback', status: 'in_progress' },
          ],
        },
      },
    });
  });

  it('requires turn id when requested so old rollout entries without metadata are ignored', () => {
    const parsed = extractRolloutUpdatePlanFunctionCallEvent(
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'update_plan',
          arguments: JSON.stringify({ plan: [{ step: 'Old plan', status: 'pending' }] }),
          call_id: 'call_old',
        },
      },
      undefined,
      { requireTurnId: true },
    );

    expect(parsed).toBeNull();
  });
});

describe('codex internal citation 归一化 (#785)', () => {
  it('normalizeCodexFileCitations 把标记换成行内代码路径,畸形标记整个剥掉', async () => {
    const { normalizeCodexFileCitations } = await import('./translator.js');
    expect(
      normalizeCodexFileCitations(
        '文档已生成::codex-file-citation{path="/tmp/报告.docx" purpose="output"},请查收。',
      ),
    ).toBe('文档已生成:`/tmp/报告.docx`,请查收。');
    expect(normalizeCodexFileCitations('bad :codex-file-citation{purpose="output"} end')).toBe(
      'bad  end',
    );
    expect(normalizeCodexFileCitations('no marker here')).toBe('no marker here');
    // 路径含花括号(引号串内):标记仍完整匹配,不把内部语法漏给用户。
    expect(
      normalizeCodexFileCitations(':codex-file-citation{path="/tmp/a{b}.md" purpose="output"}'),
    ).toBe('`/tmp/a{b}.md`');
    // 路径含反引号:围栏升级为双反引号,code span 不被撑破。
    expect(
      normalizeCodexFileCitations(':codex-file-citation{path="/tmp/a`b.md" purpose="output"}'),
    ).toBe('``/tmp/a`b.md``');
    // 路径以反引号结尾:按 CommonMark 两侧补空格。
    expect(
      normalizeCodexFileCitations(':codex-file-citation{path="/tmp/ab`" purpose="output"}'),
    ).toBe('`` /tmp/ab` ``');
    // 路径含转义引号(\"):解出真实文件名(review 反馈)。
    expect(
      normalizeCodexFileCitations(':codex-file-citation{path="/tmp/a\\"b.md" purpose="output"}'),
    ).toBe('`/tmp/a"b.md`');
    // Windows 原生路径:反斜杠不是转义前缀,原样保留(review 反馈——全量 \(.) 反
    // 转义会把 C:\Users\Ada\out.docx 毁成 C:UsersAdaout.docx)。
    expect(
      normalizeCodexFileCitations(
        ':codex-file-citation{path="C:\\Users\\Ada\\out.docx" purpose="output"}',
      ),
    ).toBe('`C:\\Users\\Ada\\out.docx`');
    // 显式转义的 \\ 仍解为单个反斜杠。
    expect(
      normalizeCodexFileCitations(':codex-file-citation{path="C:\\\\tmp\\\\a.md" purpose="output"}'),
    ).toBe('`C:\\tmp\\a.md`');
    // UNC 原生路径:开头的 \\ 是路径本体(网络共享前缀),不当作转义对(review 反馈)。
    expect(
      normalizeCodexFileCitations(
        ':codex-file-citation{path="\\\\server\\share\\out.docx" purpose="output"}',
      ),
    ).toBe('`\\\\server\\share\\out.docx`');
    // 转义形态的 UNC(\\\\server\\share):按转义对解码,解出恰好两个分隔符(review 反馈)。
    expect(
      normalizeCodexFileCitations(
        ':codex-file-citation{path="\\\\\\\\server\\\\share\\\\out.docx" purpose="output"}',
      ),
    ).toBe('`\\\\server\\share\\out.docx`');
    // 属性名完整边界:display_path 不是 path,畸形标记(无真 path)整个剥掉;
    // 有真 path 时不被前面的 *_path 别名遮蔽(review 反馈)。
    expect(
      normalizeCodexFileCitations(
        'bad :codex-file-citation{display_path="/tmp/preview.docx"} end',
      ),
    ).toBe('bad  end');
    expect(
      normalizeCodexFileCitations(
        ':codex-file-citation{display_path="/tmp/preview.docx" path="/tmp/real.docx"}',
      ),
    ).toBe('`/tmp/real.docx`');
    // 文件名首尾空白保留,不 trim(悄悄改写会指向另一个文件)。
    expect(
      normalizeCodexFileCitations(':codex-file-citation{path="/tmp/ab.md " purpose="output"}'),
    ).toBe('`/tmp/ab.md `');
    // 首尾都是空格:CommonMark 渲染器会对这种 code span 各剥一个空格,补空格垫让
    // 展示串回到真实路径(review 反馈);单侧空格渲染器不剥,不垫。
    expect(
      normalizeCodexFileCitations(':codex-file-citation{path=" ab.md " purpose="output"}'),
    ).toBe('`  ab.md  `');
    // 全空格路径:CommonMark 规定剥空格仅当「首尾是空格且**非全空格**」——全空格
    // code span 原样保留,因此**不垫**才是无损的;垫了反而多出两个永远不被剥的空格。
    expect(normalizeCodexFileCitations(':codex-file-citation{path="   " purpose="output"}')).toBe(
      '`   `',
    );
  });

  it('finalizeCodexCitationText:剥截断残尾 + 归一化,幂等(#785 导入口径)', async () => {
    const { finalizeCodexCitationText } = await import('./translator.js');
    // 截断残尾剥除,与流式 completed 同口径。
    expect(finalizeCodexCitationText('文件在 :codex-file-citation{path="/tmp/x')).toBe('文件在 ');
    // 完整标记归一化。
    expect(
      finalizeCodexCitationText('done :codex-file-citation{path="/a/b.md" purpose="output"}'),
    ).toBe('done `/a/b.md`');
    // 对已归一化文本幂等。
    expect(finalizeCodexCitationText('done `/a/b.md`')).toBe('done `/a/b.md`');
  });

  it('stableCitationBoundary 按住未写完的标记尾巴', async () => {
    const { stableCitationBoundary } = await import('./translator.js');
    expect(stableCitationBoundary('plain text')).toBe('plain text'.length);
    const partialOpen = 'abc :codex-file-citation{path="/x';
    expect(stableCitationBoundary(partialOpen)).toBe(4);
    const partialPrefix = 'abc :codex-fi';
    expect(stableCitationBoundary(partialPrefix)).toBe(4);
    const complete = 'abc :codex-file-citation{path="/x"}';
    expect(stableCitationBoundary(complete)).toBe(complete.length);
    // 引号串内的 } 不是闭合边界:标记未写完仍要按住(review 反馈的花括号路径场景)。
    const braceInQuote = 'abc :codex-file-citation{path="/tmp/a{b}';
    expect(stableCitationBoundary(braceInQuote)).toBe(4);
    const braceComplete = 'abc :codex-file-citation{path="/tmp/a{b}.md"}';
    expect(stableCitationBoundary(braceComplete)).toBe(braceComplete.length);
  });

  it('Web Search 引用标记被剥离,普通 cite 文本与相邻标点不变', async () => {
    const { finalizeCodexCitationText } = await import('./translator.js');
    const one = '\uE200cite\uE202turn17search1\uE201';
    const many = '\uE200cite\uE202turn17search1\uE202turn17search2\uE201';
    expect(finalizeCodexCitationText(`结论。${one}`)).toBe('结论。');
    expect(finalizeCodexCitationText(`A ${one}；B ${many}。`)).toBe('A ；B 。');
    expect(finalizeCodexCitationText('Please cite the source.')).toBe('Please cite the source.');
  });

  it('Web Search 引用跨 update 到达时不进入 delta,completed 截断残尾也不泄漏', async () => {
    const { newCodexRuntimeState } = await import('./translator.js');
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const push = (phase: 'started' | 'updated' | 'completed', text: string): void => {
      translateItemNotification(
        phase,
        {
          threadId: 'thread-web-citation',
          turnId: 'turn-web-citation',
          item: { type: 'agentMessage', id: 'msg-web-citation', text },
        },
        q,
        makeCtx(rt),
      );
    };

    push('started', '结论。');
    push('updated', '结论。 \uE200ci');
    push('updated', '结论。 \uE200cite\uE202turn17search1');
    push('updated', '结论。 \uE200cite\uE202turn17search1\uE201 后续');
    push('completed', '结论。 \uE200cite\uE202turn17search1\uE201 后续。\uE200cite\uE202turn18sea');

    const events = await collect(q);
    const deltas = events
      .filter((event) => event.type === 'text' && !(event.data as { isFinal: boolean }).isFinal)
      .map((event) => (event.data as { text: string }).text);
    expect(deltas.join('')).toBe('结论。  后续');
    expect(deltas.join('')).not.toContain('\uE200');
    const final = events.find(
      (event) => event.type === 'text' && (event.data as { isFinal: boolean }).isFinal,
    );
    expect((final?.data as { text: string }).text).toBe('结论。  后续。');
  });

  it('路径本身含标记开头字面量:完整标记结构化消费,不被误认成新的未闭合开头', async () => {
    const { normalizeCodexFileCitations, stableCitationBoundary } = await import('./translator.js');
    // macOS/POSIX 文件名允许 `:` 与 `{`——路径里可以出现完整的 OPEN 字面量。
    // 按「最后一个裸字面量」定位会从路径中间起扫、引号状态错位,把完整标记判成
    // 未完成(review 反馈);结构化扫描把完整标记整体跳过。
    const marker =
      ':codex-file-citation{path="/tmp/a:codex-file-citation{b.md" purpose="output"}';
    expect(stableCitationBoundary(`abc ${marker}`)).toBe(`abc ${marker}`.length);
    expect(normalizeCodexFileCitations(`abc ${marker}`)).toBe(
      'abc `/tmp/a:codex-file-citation{b.md`',
    );
    // 完整标记之后的真实截断尾巴仍要按住,且按住点在外层标记的真实开头。
    const tail = ' 然后 :codex-file-citation{path="/x';
    expect(stableCitationBoundary(`abc ${marker}${tail}`)).toBe(`abc ${marker} 然后 `.length);
  });

  it('completed:路径含 OPEN 字面量的完整标记不再被误剥,只剥真实截断尾巴', async () => {
    const { newCodexRuntimeState } = await import('./translator.js');
    const marker =
      ':codex-file-citation{path="/tmp/a:codex-file-citation{b.md" purpose="output"}';
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    translateItemNotification(
      'completed',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'msg-embed',
          text: `保存到 ${marker} 之后 :codex-file-citation{path="/x`,
        },
      },
      q,
      makeCtx(rt),
    );
    const events = await collect(q);
    expect((events[0].data as { text: string }).text).toBe(
      '保存到 `/tmp/a:codex-file-citation{b.md` 之后 ',
    );
  });

  it('裸 { 的畸形标记原样透出:不按住流式边界,也不吞它后面的正文', async () => {
    const { stableCitationBoundary } = await import('./translator.js');
    // 属性区出现裸 { 后正则永不匹配,追加文本也救不回来——不是「尚未写完」,按住
    // 或剥除都会误吞后续正文,原样透出交给用户可见性兜底。
    const poisoned = 'abc :codex-file-citation{oops{ 后面是正文';
    expect(stableCitationBoundary(poisoned)).toBe(poisoned.length);
  });

  it('agentMessage 流式:标记跨 update 分段到达,delta 流与 final 全文一致且无内部语法', async () => {
    const { newCodexRuntimeState } = await import('./translator.js');
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    const push = (phase: 'started' | 'updated' | 'completed', text: string): void => {
      translateItemNotification(
        phase,
        {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'agentMessage', id: 'msg-1', text },
        },
        q,
        makeCtx(rt),
      );
    };
    push('started', '文件已保存:');
    push('updated', '文件已保存::codex-file-cit');
    push('updated', '文件已保存::codex-file-citation{path="/tmp/out');
    push('updated', '文件已保存::codex-file-citation{path="/tmp/out.docx" purpose="output"} 完成');
    push('completed', '文件已保存::codex-file-citation{path="/tmp/out.docx" purpose="output"} 完成。');

    const events = await collect(q);
    const finalText = '文件已保存:`/tmp/out.docx` 完成。';
    const deltas = events
      .filter((e) => e.type === 'text' && (e.data as { isFinal: boolean }).isFinal === false)
      .map((e) => (e.data as { text: string }).text);
    // 既有契约:completed 只出 final、不补 delta——completed 才首次出现的「。」不进
    // delta 流,由 final 全文兜底。delta 累积必须是 final 的前缀且不含内部语法。
    expect(deltas.join('')).toBe('文件已保存:`/tmp/out.docx` 完成');
    expect(finalText.startsWith(deltas.join(''))).toBe(true);
    const finals = events.filter(
      (e) => e.type === 'text' && (e.data as { isFinal: boolean }).isFinal === true,
    );
    expect(finals).toHaveLength(1);
    expect((finals[0].data as { text: string }).text).toBe(finalText);
    for (const d of deltas) expect(d).not.toContain(':codex-file-citation{');
  });

  it('completed 文本截断在标记中间:确定的未完成标记从 final 剥掉,疑似前缀保留', async () => {
    const { newCodexRuntimeState } = await import('./translator.js');
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    translateItemNotification(
      'completed',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'msg-cut',
          text: '文件在 :codex-file-citation{path="/tmp/x',
        },
      },
      q,
      makeCtx(rt),
    );
    const rt2 = newCodexRuntimeState();
    const q2 = createAsyncQueue<AgentEvent>();
    translateItemNotification(
      'completed',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'msg-prefix', text: '正文以 :codex 结尾' },
      },
      q2,
      makeCtx(rt2),
    );
    const events = await collect(q);
    expect((events[0].data as { text: string }).text).toBe('文件在 ');
    const events2 = await collect(q2);
    expect((events2[0].data as { text: string }).text).toBe('正文以 :codex 结尾');
  });

  it('agentMessage 非流式(直接 completed):final 文本已归一化', async () => {
    const { newCodexRuntimeState } = await import('./translator.js');
    const rt = newCodexRuntimeState();
    const q = createAsyncQueue<AgentEvent>();
    translateItemNotification(
      'completed',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'msg-2',
          text: 'done :codex-file-citation{path="/a/b.md" purpose="output"}',
        },
      },
      q,
      makeCtx(rt),
    );
    const events = await collect(q);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'text',
        data: { text: 'done `/a/b.md`', isFinal: true },
      }),
    ]);
  });
});
