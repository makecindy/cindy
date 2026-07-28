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
}): {
  threadId: string;
  turnId: string;
  willRetry: boolean;
  error: { message: string };
} {
  return {
    threadId: opts.threadId ?? 't1',
    turnId: opts.turnId ?? 'turn-a',
    willRetry: opts.willRetry,
    error: { message: opts.message },
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

  it('newCodexRuntimeState() 初始 lastAuthErrorKey 为 null', () => {
    const rt = newCodexRuntimeState();
    expect(rt.lastAuthErrorKey).toBeNull();
    expect(rt.networkRetryNotice).toBeNull();
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
