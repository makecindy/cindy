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

  it('probes the native classifier again on the next turn after a turn-scoped fallback (#1573)', async () => {
    const { handle, canUseTool, fakeQuery, reviewAutoPermissionAction } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
      reviewVerdict: 'allow',
    });

    // 瞬时故障首次被观察到 → 试探性降级:SDK 立刻离开 auto 档,本 turn 剩余工具由
    // Cindy reviewer 裁决,而不是继续撞原生分类器的"无法判定安全性"硬拒绝。
    await handle.useCindyAutoReviewFallback?.({ scope: 'turn' });
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('default');
    const duringFallback = await canUseTool(
      'Bash',
      { command: 'npx tsc --noEmit' },
      { toolUseID: 'tentative-1' },
    );
    expect(duringFallback.behavior).toBe('allow');
    expect(reviewAutoPermissionAction).toHaveBeenCalledOnce();

    // 下一 turn 起点回探原生:一次上游抖动不该让整个会话余生失去原生 Auto(#596)。
    // 降级后 SDK 不再发分类器请求,proxy 永远观察不到恢复,所以这是唯一的解除点。
    await handle.send({ type: 'user', content: 'next turn' });
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('auto');
    await handle.close();
  });

  it('treats repeated turn-scoped signals within one turn as a no-op', async () => {
    const { handle, fakeQuery } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
    });

    // 一次动作的 retry storm 会让观察器连发多条 turn 级信号(它刻意不按 episode 去重),
    // 收敛责任在这里:同一 turn 内只切一次档。返回值让 host 能把重复信号记成 no-op,
    // 而不是把故障计数冲虚。
    await expect(handle.useCindyAutoReviewFallback?.({ scope: 'turn' })).resolves.toBe(true);
    await expect(handle.useCindyAutoReviewFallback?.({ scope: 'turn' })).resolves.toBe(false);
    await expect(handle.useCindyAutoReviewFallback?.({ scope: 'turn' })).resolves.toBe(false);
    expect(fakeQuery.setPermissionMode).toHaveBeenCalledTimes(1);
    expect(fakeQuery.setPermissionMode).toHaveBeenCalledWith('default');
    await handle.close();
  });

  it('does not commit a turn-scoped fallback when the control request fails, so the same turn retries', async () => {
    // 标记必须与 SDK 实际档位一致。若先置标记、push 再失败,SDK 留在 auto 继续硬拒绝,
    // 而同一 turn 后续故障信号会被幂等闸当成 no-op 吞掉,再也没机会切到 Cindy(codex P2)。
    const { handle, canUseTool, fakeQuery, reviewAutoPermissionAction } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
      reviewVerdict: 'allow',
    });

    fakeQuery.setPermissionMode.mockRejectedValueOnce(new Error('transport not ready'));
    await expect(
      handle.useCindyAutoReviewFallback?.({ scope: 'turn' }),
    ).rejects.toThrow('transport not ready');

    // 同一 turn 的下一个故障信号必须还能重试,而不是拿到幂等 false。
    await expect(handle.useCindyAutoReviewFallback?.({ scope: 'turn' })).resolves.toBe(true);
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('default');

    // 重试成功后审批确实落到 Cindy reviewer 上。
    const decided = await canUseTool(
      'Bash',
      { command: 'npx tsc --noEmit' },
      { toolUseID: 'after-retry' },
    );
    expect(decided.behavior).toBe('allow');
    expect(reviewAutoPermissionAction).toHaveBeenCalledOnce();
    await handle.close();
  });

  it('does not commit a session-scoped fallback when the control request fails', async () => {
    // 会话级更严重:终态标记一旦提前落地,整个会话余生的信号都会被第一道幂等闸吞掉。
    const { handle, fakeQuery } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
    });

    fakeQuery.setPermissionMode.mockRejectedValueOnce(new Error('transport not ready'));
    await expect(
      handle.useCindyAutoReviewFallback?.({ scope: 'session' }),
    ).rejects.toThrow('transport not ready');

    await expect(handle.useCindyAutoReviewFallback?.({ scope: 'session' })).resolves.toBe(true);
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('default');
    await handle.close();
  });

  it('keeps the tentative flag when a turn cannot probe, and probes on the next eligible turn', async () => {
    // 回探的不变量:标记与 SDK 档位必须一致。推不了档的 turn(底层档已不是 auto、plan 档、
    // rewind/bridge 重建窗口)必须**保留**标记 —— 提前清掉会让判据说"该用原生"而 SDK 停在
    // default,后续 send 再也进不来回探逻辑,健康的原生分类器就永久回不来了(greptile P1)。
    const { handle, fakeQuery } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
    });

    await handle.useCindyAutoReviewFallback?.({ scope: 'turn' });
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('default');

    // 底层档已切离 auto:这个 turn 回探必须让位,且不得清标记。
    await handle.setPermissionMode?.('ask');
    fakeQuery.setPermissionMode.mockClear();
    await handle.send({ type: 'user', content: 'ask-mode turn' });
    expect(fakeQuery.setPermissionMode).not.toHaveBeenCalled();

    // 切回 Auto:标记仍在 → SDK 落回 default,而不是 auto(标记没被提前清掉的直接证据)。
    await handle.setPermissionMode?.('auto');
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('default');

    // 下一个条件重新满足的 turn:回探正常发生。
    fakeQuery.setPermissionMode.mockClear();
    await handle.send({ type: 'user', content: 'eligible turn' });
    expect(fakeQuery.setPermissionMode).toHaveBeenCalledWith('auto');
    await handle.close();
  });

  it('restores the tentative flag when the probe control request hangs, so the next turn retries', async () => {
    // 悬挂的控制请求既不 resolve 也不 reject,只挂 resolve/reject 回调兜不住:标记此刻
    // 已乐观清零,SDK 却永远停在 default,后续 send 也不再回探 —— 一次试探性降级会永久
    // 变成 Cindy fallback(codex P2)。有界看门狗负责把标记恢复,重试交回下一 turn。
    const { handle, fakeQuery } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
    });

    await handle.useCindyAutoReviewFallback?.({ scope: 'turn' });

    // 看门狗的计时器必须在 fake timers 生效**期间**注册,否则推进的是另一套时钟。
    vi.useFakeTimers();
    try {
      // 永不 settle 的控制请求。
      fakeQuery.setPermissionMode.mockReturnValueOnce(new Promise<void>(() => {}));
      await handle.send({ type: 'user', content: 'probe hangs here' });
      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      vi.useRealTimers();
    }

    // 看门狗已恢复标记 → 下一 turn 重新回探(而不是永久留在 Cindy fallback)。
    fakeQuery.setPermissionMode.mockClear();
    await handle.send({ type: 'user', content: 'retry after watchdog' });
    expect(fakeQuery.setPermissionMode).toHaveBeenCalledWith('auto');
    await handle.close();
  });

  it('restores the tentative flag when the probe control request fails', async () => {
    const { handle, fakeQuery } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
    });

    await handle.useCindyAutoReviewFallback?.({ scope: 'turn' });
    // 回探是 fire-and-forget(不许阻塞 send 入口),失败只能异步观测。
    fakeQuery.setPermissionMode.mockRejectedValueOnce(new Error('transport not ready'));
    await handle.send({ type: 'user', content: 'probe fails here' });
    await new Promise((resolve) => setImmediate(resolve));

    // 失败 → 标记恢复 → 下一 turn 再试(期间继续由 Cindy 兜住,不影响正确性)。
    fakeQuery.setPermissionMode.mockClear();
    await handle.send({ type: 'user', content: 'retry probe' });
    expect(fakeQuery.setPermissionMode).toHaveBeenCalledWith('auto');
    await handle.close();
  });

  it('never probes back after a session-scoped fallback (#758 self-rescue stays sticky)', async () => {
    const { handle, fakeQuery } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
    });

    // 持续故障已确认 → 会话级终态。回探会让用户在每个 turn 各撞一次硬拒绝,
    // 正是 #758 要关掉的死循环。
    await handle.useCindyAutoReviewFallback?.({ scope: 'session' });
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('default');
    fakeQuery.setPermissionMode.mockClear();

    await handle.send({ type: 'user', content: 'next turn' });
    expect(fakeQuery.setPermissionMode).not.toHaveBeenCalled();

    // 终态之后再来的 turn 级信号同样是 no-op(不得把会话级降级降回试探性)。
    await expect(handle.useCindyAutoReviewFallback?.({ scope: 'turn' })).resolves.toBe(false);
    await handle.send({ type: 'user', content: 'one more turn' });
    expect(fakeQuery.setPermissionMode).not.toHaveBeenCalled();
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

describe('Auto-review wiring: only affects the auto mode', () => {
  it('default mode does not apply the auto-review policy (safe shell still prompts)', async () => {
    const { handle, canUseTool, seen } = await startSession('default');
    await canUseTool('Bash', { command: 'ls -la' }, { toolUseID: 't7' });
    // default 档下内置工具不走 auto-review 策略,照旧交 resolver。
    expect(permissionRequests(seen)).toHaveLength(1);
    await handle.close();
  });
});
