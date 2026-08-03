/**
 * Auto-review 接线集成测试:官方 Claude OAuth 保留原生 Auto classifier；第三方路由
 * 映射到 SDK default，让 canUseTool 走 Cindy 当前模型轻量 fallback。
 *
 * 覆盖(靶心是接线,而非策略本身 —— 策略逐规则由 auto-review-policy.test.ts 覆盖):
 *   - auto + 安全内置(只读 / 区内写 / 只读 shell)→ 静默 allow,不惊动 resolver
 *   - auto + 灰区 → lightweight reviewer 的 allow/block 静默处理，只有 ask 才弹窗
 *   - auto + 确定危险命令 → 弹窗且 suggestion 被剥(不可持久化授权)
 *   - default 档 → 内置工具不走 auto-review 策略(照旧弹窗),证明只作用于 auto
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import type { PermissionMode } from '../../../types/common.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { InteractionDecision, InteractionRequest } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';

const sdkMock = vi.hoisted(() => ({ forkSession: vi.fn(), query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: sdkMock.forkSession,
  query: sdkMock.query,
}));

import { ClaudeCodeAgent } from '../index.js';

const tempDirs: string[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

function noopLogger(): Logger {
  const l: Logger = {
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    child() { return l; },
  };
  return l;
}

function createDeps(options: {
  authSource?: 'oauth' | 'api-key';
  reviewAutoPermissionAction?: AgentDeps['reviewAutoPermissionAction'];
} = {}): AgentDeps {
  const auth: AuthAdapter = {
    async getState() { return { authenticated: true, authSource: options.authSource }; },
    async triggerLogin() { return { authenticated: true }; },
    async logout() {},
    async getAuthEnv() { return {}; },
  };
  return {
    auth,
    runtimeConfig: {},
    binaryPath: process.execPath,
    logger: noopLogger(),
    mcpProviders: [],
    reviewAutoPermissionAction: options.reviewAutoPermissionAction,
  };
}

function createFakeQuery() {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<unknown>>(() => {}) };
    },
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    rewindFiles: vi.fn(async () => ({ canRewind: false })),
  };
}

type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: { toolUseID: string; suggestions?: unknown[] },
) => Promise<{ behavior: 'allow' | 'deny'; message?: string }>;

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-auto-review-'));
  tempDirs.push(dir);
  return dir;
}

async function startSession(
  permissionMode: PermissionMode,
  options: {
    providerId?: string;
    authSource?: 'oauth' | 'api-key';
    reviewVerdict?: 'allow' | 'block' | 'ask';
    reviewer?: AgentDeps['reviewAutoPermissionAction'];
    attachResolver?: boolean;
  } = {},
) {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const workingDir = await makeTempDir();
  const fakeQuery = createFakeQuery();
  sdkMock.query.mockReturnValue(fakeQuery);

  const reviewAutoPermissionAction = options.reviewer ?? vi.fn(async () => ({
    verdict: options.reviewVerdict ?? 'allow',
    reason: 'reviewed',
  }));
  const agent = new ClaudeCodeAgent(createDeps({
    authSource: options.authSource,
    reviewAutoPermissionAction,
  }));
  const handle = await agent.startSession({
    sessionId: 'session-auto-review',
    model: 'claude-opus-4-6',
    providerId: options.providerId ?? 'xd',
    workingDir,
    permissionMode,
  });
  const queryOptions = sdkMock.query.mock.calls.at(-1)?.[0]?.options as
    | { canUseTool?: CanUseToolFn; permissionMode?: string }
    | undefined;
  if (!queryOptions?.canUseTool) throw new Error('expected sdk query canUseTool');

  const seen: InteractionRequest[] = [];
  if (options.attachResolver !== false) {
    handle.setInteractionResolver(async (req): Promise<InteractionDecision> => {
      seen.push(req);
      return { kind: 'permission', behavior: 'allow' };
    });
  }

  return {
    agent,
    handle,
    canUseTool: queryOptions.canUseTool,
    fakeQuery,
    queryPermissionMode: queryOptions.permissionMode,
    reviewAutoPermissionAction,
    seen,
    workingDir,
  };
}

function permissionRequests(seen: InteractionRequest[]) {
  return seen.flatMap((req) => (req.kind === 'permission' ? [req] : []));
}

/** SDK 在需要审批时会带上会话级 suggestion(可"总是允许");这里模拟它。 */
const SESSION_SUGGESTION = [{ type: 'addRules', destination: 'session', behavior: 'allow' }];

afterEach(async () => {
  sdkMock.forkSession.mockReset();
  sdkMock.query.mockReset();
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('Auto-review wiring: native first, Cindy fallback', () => {
  it('keeps SDK auto for official Claude OAuth', async () => {
    const { handle, queryPermissionMode, reviewAutoPermissionAction } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
    });
    expect(queryPermissionMode).toBe('auto');
    expect(reviewAutoPermissionAction).not.toHaveBeenCalled();
    await handle.close();
  });

  it('uses SDK default for a third-party route so Cindy can review callbacks', async () => {
    const { handle, queryPermissionMode } = await startSession('auto', { providerId: 'xd' });
    expect(queryPermissionMode).toBe('default');
    await handle.close();
  });

  it('can silently allow a gray action without an interaction resolver', async () => {
    const { handle, canUseTool, reviewAutoPermissionAction, seen } = await startSession('auto', {
      providerId: 'xd',
      reviewVerdict: 'allow',
      attachResolver: false,
    });
    const result = await canUseTool(
      'Bash',
      { command: 'npx tsc --noEmit' },
      { toolUseID: 'typecheck-without-ui' },
    );
    expect(result.behavior).toBe('allow');
    expect(reviewAutoPermissionAction).toHaveBeenCalledOnce();
    expect(seen).toHaveLength(0);
    await handle.close();
  });

  it('keeps the product mode on Auto and switches only the runtime reviewer after native failure', async () => {
    const {
      handle,
      canUseTool,
      fakeQuery,
      reviewAutoPermissionAction,
      seen,
    } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
      reviewVerdict: 'allow',
    });

    await handle.useCindyAutoReviewFallback?.();
    expect(fakeQuery.setPermissionMode).toHaveBeenCalledWith('default');
    const result = await canUseTool(
      'Bash',
      { command: 'npx tsc --noEmit' },
      { toolUseID: 'fallback-typecheck' },
    );
    expect(result.behavior).toBe('allow');
    expect(reviewAutoPermissionAction).toHaveBeenCalledOnce();
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });
});

describe('Auto-review wiring: safe builtin tools auto-approve silently', () => {
  it('read-only tool → allow without hitting the resolver', async () => {
    const { handle, canUseTool, seen } = await startSession('auto');
    const r = await canUseTool('Read', { file_path: '/anywhere/x' }, { toolUseID: 't1' });
    expect(r.behavior).toBe('allow');
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });

  it('read-only shell (ls) → allow without resolver', async () => {
    const { handle, canUseTool, seen } = await startSession('auto');
    const r = await canUseTool('Bash', { command: 'ls -la && git status' }, { toolUseID: 't2' });
    expect(r.behavior).toBe('allow');
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });

  it('in-workspace file write → allow without resolver', async () => {
    const { handle, canUseTool, seen, workingDir } = await startSession('auto');
    const r = await canUseTool('Write', { file_path: path.join(workingDir, 'a.ts') }, { toolUseID: 't3' });
    expect(r.behavior).toBe('allow');
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });
});

describe('Auto-review wiring: lightweight reviewer controls gray actions', () => {
  it('re-checks the latest permission mode after an in-flight review', async () => {
    let resolveReview: ((value: { verdict: 'allow'; reason: string }) => void) | undefined;
    const reviewer = vi.fn(() => new Promise<{ verdict: 'allow'; reason: string }>((resolve) => {
      resolveReview = resolve;
    }));
    const { handle, canUseTool, seen } = await startSession('auto', { reviewer });

    const pending = canUseTool('Write', { file_path: '/tmp/late-mode.conf' }, { toolUseID: 'late-ask' });
    await vi.waitFor(() => expect(reviewer).toHaveBeenCalledOnce());
    await handle.setPermissionMode!('ask');
    resolveReview!({ verdict: 'allow', reason: 'reviewed' });
    await expect(pending).resolves.toMatchObject({ behavior: 'allow' });
    // allow 来自用户确认而非旧 reviewer verdict，且 session grant 已被剥离。
    expect(permissionRequests(seen)).toHaveLength(1);
    expect(permissionRequests(seen)[0]?.suggestions).toBeUndefined();

    let resolveFull: ((value: { verdict: 'allow'; reason: string }) => void) | undefined;
    const fullReviewer = vi.fn(() => new Promise<{ verdict: 'allow'; reason: string }>((resolve) => {
      resolveFull = resolve;
    }));
    // 新建一个 auto 会话，避免上一段 Ask 的本地状态影响断言。
    await handle.close();
    const next = await startSession('auto', { reviewer: fullReviewer });
    const fullPending = next.canUseTool('Write', { file_path: '/tmp/late-full.conf' }, { toolUseID: 'late-full' });
    await vi.waitFor(() => expect(fullReviewer).toHaveBeenCalledOnce());
    await next.handle.setPermissionMode!('bypassPermissions');
    resolveFull!({ verdict: 'allow', reason: 'reviewed' });
    await expect(fullPending).resolves.toMatchObject({ behavior: 'allow' });
    expect(permissionRequests(next.seen)).toHaveLength(0);
    await next.handle.close();
  });

  it('reviewer allow → proceeds silently without hitting the resolver', async () => {
    const { handle, canUseTool, reviewAutoPermissionAction, seen } = await startSession('auto', {
      reviewVerdict: 'allow',
    });
    const r = await canUseTool(
      'Write',
      { file_path: '/tmp/gray-write.conf' },
      { toolUseID: 't4', suggestions: SESSION_SUGGESTION },
    );
    expect(r.behavior).toBe('allow');
    expect(reviewAutoPermissionAction).toHaveBeenCalledOnce();
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });

  it('reviewer block → denies silently and tells the agent to choose a safer action', async () => {
    const { handle, canUseTool, seen } = await startSession('auto', {
      reviewVerdict: 'block',
    });
    const result = await canUseTool('Bash', { command: 'npm install left-pad' }, { toolUseID: 't5' });
    expect(result).toMatchObject({ behavior: 'deny', message: 'reviewed' });
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });

  it('reviewer ask → prompts once with session suggestions stripped', async () => {
    const { handle, canUseTool, seen } = await startSession('auto', {
      reviewVerdict: 'ask',
    });
    await canUseTool(
      'Bash',
      { command: 'npm install left-pad' },
      { toolUseID: 't5-ask', suggestions: SESSION_SUGGESTION },
    );
    const reqs = permissionRequests(seen);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.suggestions).toBeUndefined();
    await handle.close();
  });

  it('deterministic privilege boundary → prompts without calling the reviewer', async () => {
    const { handle, canUseTool, reviewAutoPermissionAction, seen } = await startSession('auto');
    await canUseTool('Bash', { command: 'sudo rm -rf build' }, { toolUseID: 't6', suggestions: SESSION_SUGGESTION });
    const reqs = permissionRequests(seen);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.suggestions).toBeUndefined();
    expect(reviewAutoPermissionAction).not.toHaveBeenCalled();
    await handle.close();
  });
});

/**
 * 「审阅器不可用」要在会话里说一次(issue #1574)。
 *
 * 以前 delegate 缺失 / 超时 / 抛错和「模型判定动作危险」在上层都是同一个 `block`,
 * UI 层零呈现 —— 用户看到的是「工具一直被拒、没有弹窗、重启无效」,却拿不到任何原因。
 * 现在前者额外发一条会话级**一次性**提示(走既有的非终止 error 事件 + `[CODE]` 约定),
 * 动作本身仍然 deny,安全边界不变。
 */
describe('Auto-review wiring: reviewer outages surface once per session', () => {
  /**
   * 单一后台消费者收集会话级提示(非终止 error)。
   *
   * 事件流是**单消费者** AsyncQueue:如果改用「每次断言时新建 iterator + 超时丢弃」的
   * 写法,被超时丢弃的那个 pending `next()` 仍挂在 waiters 里,下一条 push 会被它吃掉,
   * 断言就会莫名少一条。所以整个用例只订阅一次。
   */
  function startNoticeCollector(
    handle: { events(): AsyncIterable<{ type: string; data?: { message?: unknown } }> },
  ) {
    const notices: string[] = [];
    // 刻意不返回这个 promise:fakeQuery 的消息流永远挂起,forward loop 不退出,close()
    // 之后事件流也不会 end —— await 它就是等到测试超时。收集器随测试进程一起结束。
    void (async () => {
      for await (const event of handle.events()) {
        if (event.type === 'error' && typeof event.data?.message === 'string') {
          notices.push(event.data.message);
        }
      }
    })().catch(() => {
      /* 队列在 teardown 时被丢弃,不是测试失败 */
    });
    return { notices };
  }

  /** 让 push 进队列的事件 fan-out 到收集器。 */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it('emits one notice for a broken reviewer, not one per blocked action', async () => {
    // reviewer 抛错 = resolveAutoReviewDecision 走 unavailable 兜底 block。
    const { handle, canUseTool } = await startSession('auto', {
      reviewer: async () => {
        throw new Error('reviewer offline');
      },
      attachResolver: false,
    });
    const { notices } = startNoticeCollector(handle);

    const first = await canUseTool('Write', { file_path: '/tmp/a.conf' }, { toolUseID: 'n1' });
    const second = await canUseTool('Write', { file_path: '/tmp/b.conf' }, { toolUseID: 'n2' });
    expect(first.behavior).toBe('deny');
    expect(second.behavior).toBe('deny');
    await settle();

    // 两次都被拒,但只说一次 —— 逐条提示会把 Auto 退化成比 Ask 更烦的东西。
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('[AUTO_REVIEW_UNAVAILABLE]');
    await handle.close();
  });

  it('stays silent when the model itself blocks the action', async () => {
    const { handle, canUseTool } = await startSession('auto', { reviewVerdict: 'block' });
    const { notices } = startNoticeCollector(handle);

    const result = await canUseTool('Bash', { command: 'npm install left-pad' }, { toolUseID: 'n3' });
    expect(result).toMatchObject({ behavior: 'deny', message: 'reviewed' });
    await settle();

    // 模型判定的 block 按 Auto 本意保持静默 —— 只把 reason 喂给模型,不打扰用户。
    expect(notices).toHaveLength(0);
    await handle.close();
  });

  it('re-arms the notice after the user changes the permission mode', async () => {
    const { handle, canUseTool } = await startSession('auto', {
      reviewer: async () => {
        throw new Error('reviewer offline');
      },
      attachResolver: false,
    });
    const { notices } = startNoticeCollector(handle);

    await canUseTool('Write', { file_path: '/tmp/c.conf' }, { toolUseID: 'n4' });
    await settle();
    expect(notices).toHaveLength(1);

    // 用户自己动过档位之后又回到 Auto、又不可用 → 有权再看到一次。
    await handle.setPermissionMode?.('ask');
    await handle.setPermissionMode?.('auto');
    await canUseTool('Write', { file_path: '/tmp/d.conf' }, { toolUseID: 'n5' });
    await settle();
    expect(notices).toHaveLength(2);
    await handle.close();
  });
});

describe('Auto-review wiring: only affects the auto mode', () => {
  it('default mode does not apply the auto-review policy (safe shell still prompts)', async () => {
    const { handle, canUseTool, seen } = await startSession('default');
    await canUseTool('Bash', { command: 'ls -la' }, { toolUseID: 't7' });
    // default 档下内置工具不走 auto-review 策略,照旧交 resolver。
    expect(permissionRequests(seen)).toHaveLength(1);
    await handle.close();
  });
});
