/**
 * Auto-review 接线集成测试:官方 Claude OAuth 保留原生 Auto classifier；第三方路由
 * 映射到 SDK default，让 canUseTool 走 Cindy 当前模型轻量 fallback。
 *
 * 覆盖(靶心是接线,而非策略本身 —— 策略逐规则由 auto-review-policy.test.ts 覆盖):
 *   - auto + 安全内置(只读 / 区内写 / 只读 shell)→ 静默 allow,不惊动 resolver
 *   - auto + 灰区 → lightweight reviewer 的 allow/block 静默处理，只有 ask 才弹窗
 *   - auto + 确定危险命令 → 弹窗且 suggestion 被剥(不可持久化授权)
 *   - 送审阅器的 model 恒为目录 id(不是 [1m] wire 串),切模后仍然如此
 *   - 审阅器不可用(而非模型判定危险)时,会话里出现一条一次性提示
 *   - default 档 → 内置工具不走 auto-review 策略(照旧弹窗),证明只作用于 auto
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import type { AutoReviewRequest } from '../../shared/auto-review-decision.js';
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
    model?: string;
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
    model: options.model ?? 'claude-opus-4-6',
    providerId: options.providerId ?? 'xd',
    workingDir,
    permissionMode,
  });
  const queryOptions = sdkMock.query.mock.calls.at(-1)?.[0]?.options as
    | { canUseTool?: CanUseToolFn; permissionMode?: string; model?: string }
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
    querySdkModel: queryOptions.model,
    reviewAutoPermissionAction,
    seen,
    workingDir,
  };
}

/** 取 reviewer 第 n 次调用收到的 AutoReviewRequest。 */
function reviewedRequest(
  reviewer: NonNullable<AgentDeps['reviewAutoPermissionAction']>,
  callIndex = 0,
): AutoReviewRequest {
  const request = vi.mocked(reviewer).mock.calls[callIndex]?.[0];
  if (!request) throw new Error(`expected reviewer call #${callIndex}`);
  return request;
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

  it('does not let a failed newer escalation erase an older push that succeeded', async () => {
    // 代际号的语义是「最后一个**发起**的档位变更」,前提是发起者最终会写状态。会话级升级
    // 穿透在飞的 turn 级降级、自己 push 失败(终态也没置上)时,先发起的 turn 级 push 之后
    // 成功了却因代际不匹配直接返回 —— SDK 已在 default 而状态仍是 'native',send() 不再
    // 回探、default 档也不再产生分类器响应触发新信号,会话永久停在没记账的 Cindy fallback。
    const { handle, fakeQuery } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
    });

    let releaseTurnPush!: () => void;
    const turnPushGate = new Promise<void>((resolve) => { releaseTurnPush = resolve; });
    fakeQuery.setPermissionMode
      .mockReturnValueOnce(turnPushGate)                                  // turn 级:先发起、后成功
      .mockRejectedValueOnce(new Error('transport not ready'));           // 会话级:后发起、失败

    const turnFallback = handle.useCindyAutoReviewFallback?.({ scope: 'turn' });
    await new Promise((resolve) => setImmediate(resolve));
    await expect(
      handle.useCindyAutoReviewFallback?.({ scope: 'session' }),
    ).rejects.toThrow('transport not ready');

    releaseTurnPush();
    // 失败的会话级把写入权交还了它,所以这次成功仍然要提交状态。
    await expect(turnFallback).resolves.toBe(true);

    // 状态确实是「已确认降级」而不是残留的 'native':下一 turn 会正常回探 auto。
    fakeQuery.setPermissionMode.mockClear();
    await handle.send({ type: 'user', content: 'next turn' });
    expect(fakeQuery.setPermissionMode).toHaveBeenCalledWith('auto');
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

  it('reconciles a probe that succeeds after the watchdog instead of dropping the result', async () => {
    // 第 5 轮 review 的核心竞态:watchdog 超时后控制请求**迟到成功**,SDK 实际已回到 auto。
    // 旧实现用 probeSettled 一刀切丢弃迟到结果,状态却仍声称 Cindy 兜底 → 本 turn 后续
    // 故障信号被幂等闸吞掉、推不回 default,用户继续撞硬拒绝。现在按代际校验后调和。
    const { handle, fakeQuery } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
    });
    await handle.useCindyAutoReviewFallback?.({ scope: 'turn' });

    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    vi.useFakeTimers();
    try {
      fakeQuery.setPermissionMode.mockReturnValueOnce(probeGate);
      await handle.send({ type: 'user', content: 'probe hangs, then succeeds' });
      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      vi.useRealTimers();
    }

    releaseProbe();
    await new Promise((resolve) => setImmediate(resolve));

    // 已调和为 'native'(SDK 确认在 auto)→ 下一 turn 不需要再回探。
    fakeQuery.setPermissionMode.mockClear();
    await handle.send({ type: 'user', content: 'next turn' });
    expect(fakeQuery.setPermissionMode).not.toHaveBeenCalled();
    await handle.close();
  });

  it('lets an unconfirmed probe state re-push default instead of swallowing the signal', async () => {
    // watchdog 超时后 SDK 档位未知(可能已被迟到的回探切回 auto):此时的故障信号**不能**
    // 被当成"本 turn 已降级"的重复信号,必须允许再推一次 default。
    const { handle, fakeQuery } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
    });
    await handle.useCindyAutoReviewFallback?.({ scope: 'turn' });
    // 已确认降级时重复信号仍是幂等 no-op。
    await expect(handle.useCindyAutoReviewFallback?.({ scope: 'turn' })).resolves.toBe(false);

    vi.useFakeTimers();
    try {
      fakeQuery.setPermissionMode.mockReturnValueOnce(new Promise<void>(() => {}));
      await handle.send({ type: 'user', content: 'probe hangs' });
      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      vi.useRealTimers();
    }

    fakeQuery.setPermissionMode.mockClear();
    await expect(handle.useCindyAutoReviewFallback?.({ scope: 'turn' })).resolves.toBe(true);
    expect(fakeQuery.setPermissionMode).toHaveBeenCalledWith('default');
    await handle.close();
  });

  it('leaves the mode unconfirmed when an already-landed default write loses its generation', async () => {
    // greptile P1 / codex P2 的共同根因:代际过期时把「push 已成功、SDK 现在就在 default」
    // 这个物理事实整个丢弃,会留下"状态说 native、SDK 在 default"且再也没人纠正的死角 ——
    // send() 因状态是 native 不再回探,default 档又不再产生分类器响应触发新信号。
    //
    // 这里构造「旧降级请求先成功、更新的决策后失败」这一反向完成顺序(此前的用例只固定了
    // "新请求先失败、旧请求后成功")。
    const { handle, fakeQuery } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
    });

    let releaseTurnPush!: () => void;
    const turnPushGate = new Promise<void>((resolve) => { releaseTurnPush = resolve; });
    let rejectSessionPush!: (e: Error) => void;
    const sessionPushGate = new Promise<void>((_, reject) => { rejectSessionPush = reject; });
    fakeQuery.setPermissionMode
      .mockReturnValueOnce(turnPushGate)
      .mockReturnValueOnce(sessionPushGate);

    const turnFallback = handle.useCindyAutoReviewFallback?.({ scope: 'turn' });
    // 更新的会话级决策穿透进来并推进代际,它的 push 也还在飞。
    const sessionResult = handle.useCindyAutoReviewFallback?.({ scope: 'session' })
      ?.then(() => null, (e: unknown) => e);

    // 旧的 turn 级 push **先**成功:代际已被 session 级推进,它只能降级后返回 —— 这一刻
    // 它就"已结束"了,后面任何代际回滚都不会再把它叫回来提交状态。
    releaseTurnPush();
    await expect(turnFallback).resolves.toBe(false);

    // session 级随后失败 → 回滚代际,可它并不知道 turn 级那次已经落地在 SDK 上。
    rejectSessionPush(new Error('transport not ready'));
    await expect(sessionResult).resolves.toBeInstanceOf(Error);

    // 状态必须落在"未确认"而不是 native:下一 turn 仍会回探,把真实档位重新确认回来。
    fakeQuery.setPermissionMode.mockClear();
    await handle.send({ type: 'user', content: 'next turn' });
    expect(fakeQuery.setPermissionMode).toHaveBeenCalledWith('auto');
    await handle.close();
  });

  it('times out a hanging default push so the signal can retry instead of pinning in-flight', async () => {
    // codex P1:降级方向的 await 没有上界时,悬挂的控制请求会让 coordinator 永久扣着该会话
    // 的 in-flight 记录,后续信号全被去重,而状态仍声称 native、SDK 可能还在 auto ——
    // #1573 的硬拒绝窗口原样复现。
    const { handle, fakeQuery } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
    });

    vi.useFakeTimers();
    let rejected: unknown;
    try {
      fakeQuery.setPermissionMode.mockReturnValueOnce(new Promise<void>(() => {}));
      const pending = handle.useCindyAutoReviewFallback?.({ scope: 'turn' })?.catch((e) => {
        rejected = e;
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }

    // 必须按失败上抛(coordinator 据此记 failed 并释放 in-flight),而不是无限等待。
    expect(String(rejected)).toContain('timed out');

    // 档位未知 → 状态保守置"未确认",于是同一 turn 的下一个故障信号可以重推 default。
    fakeQuery.setPermissionMode.mockClear();
    await expect(handle.useCindyAutoReviewFallback?.({ scope: 'turn' })).resolves.toBe(true);
    expect(fakeQuery.setPermissionMode).toHaveBeenCalledWith('default');
    await handle.close();
  });

  it('does not let a late probe success override a newer fallback decision', async () => {
    // 代际保护:unconfirmed 期间新的降级已把 SDK 推回 default,更晚到达的回探成功不得把
    // 状态改回 'native' —— 否则状态说原生而 SDK 在 default,下一 turn 也不会再回探。
    const { handle, fakeQuery } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
    });
    await handle.useCindyAutoReviewFallback?.({ scope: 'turn' });

    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    vi.useFakeTimers();
    try {
      fakeQuery.setPermissionMode.mockReturnValueOnce(probeGate);
      await handle.send({ type: 'user', content: 'probe hangs' });
      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      vi.useRealTimers();
    }

    // 更新的决策:重新降级并确认 SDK 在 default。
    await expect(handle.useCindyAutoReviewFallback?.({ scope: 'turn' })).resolves.toBe(true);
    // 迟到的回探成功此刻才返回 —— 代际已过期,不得改写状态。
    releaseProbe();
    await new Promise((resolve) => setImmediate(resolve));

    // 状态仍是已确认降级 → 下一 turn 照常回探 auto。
    fakeQuery.setPermissionMode.mockClear();
    await handle.send({ type: 'user', content: 'next turn' });
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

/**
 * 送审阅器的是**用户选中的目录模型 id**,不是送 SDK 的 wire 串。
 *
 * host 侧 reviewer 按 (providerId, model) 精确查目录条目定路由,查不到就 fail closed
 * (oneShotCandidates 的 no_candidate)—— 灰区动作会退化成没有 UI 提示的永久 block。
 * Claude 的 wire 串带 [1m] beta 通道后缀(toSdkModelString),而目录条目不带,所以这两个
 * 值必须始终分离:`mutableModel` 只跟随用户选择,wire 串在送 SDK 前单独派生、不回写。
 *
 * Codex 侧的同一约束靠 mutableCatalogModel 兜(它的 app-server 会把规范化后的 wire id
 * **回带**覆盖运行期 model);Claude 没有那条回带路径,不变量由下面两个用例守住 —— 任何
 * 把 wire 串写回 mutableModel 的改动都会让它们变红。见 issue #1575。
 */
describe('Auto-review wiring: the reviewer routes through the catalog model id', () => {
  it('reviews through the catalog id while the SDK receives the [1m] wire id', async () => {
    const { handle, canUseTool, querySdkModel, reviewAutoPermissionAction } = await startSession('auto', {
      model: 'claude-opus-4-6',
      reviewVerdict: 'allow',
    });
    expect(querySdkModel).toBe('claude-opus-4-6[1m]');

    const r = await canUseTool(
      'Write',
      { file_path: '/tmp/catalog-model.conf' },
      { toolUseID: 'catalog-model' },
    );
    expect(r.behavior).toBe('allow');
    expect(reviewedRequest(reviewAutoPermissionAction).model).toBe('claude-opus-4-6');
    await handle.close();
  });

  it('keeps reviewing through the catalog id after setModel switches the route', async () => {
    const { handle, canUseTool, fakeQuery, reviewAutoPermissionAction } = await startSession('auto', {
      model: 'claude-opus-4-6',
      reviewVerdict: 'allow',
    });

    await handle.setModel?.('claude-sonnet-5');
    expect(fakeQuery.setModel).toHaveBeenCalledWith('claude-sonnet-5[1m]');

    await canUseTool(
      'Write',
      { file_path: '/tmp/catalog-model-switched.conf' },
      { toolUseID: 'catalog-model-switched' },
    );
    expect(reviewedRequest(reviewAutoPermissionAction).model).toBe('claude-sonnet-5');
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

  /**
   * 裁决缓存的 key 不含 permissionMode。用户切离 Auto、等审阅器恢复、再切回 Auto 时,
   * 同一个动作会命中先前那条 `unavailable` block —— 审阅器早就好了,动作还是被拒
   * (greptile P1 of #1574)。切档必须连缓存一起清。
   */
  it('drops cached unavailable verdicts when the permission mode changes', async () => {
    let reviewerBroken = true;
    const reviewer = vi.fn(async () => {
      if (reviewerBroken) throw new Error('reviewer offline');
      return { verdict: 'allow' as const };
    });
    const { handle, canUseTool } = await startSession('auto', {
      reviewer,
      attachResolver: false,
    });

    const sameAction = { file_path: '/tmp/cached.conf' };
    const denied = await canUseTool('Write', sameAction, { toolUseID: 'cache-1' });
    expect(denied.behavior).toBe('deny');

    // 用户接管 → 审阅器恢复 → 切回 Auto。
    await handle.setPermissionMode?.('ask');
    reviewerBroken = false;
    await handle.setPermissionMode?.('auto');

    const allowed = await canUseTool('Write', sameAction, { toolUseID: 'cache-2' });
    expect(allowed.behavior).toBe('allow');
    // 缓存真的清了才会有第二次 reviewer 调用。
    expect(reviewer).toHaveBeenCalledTimes(2);
    await handle.close();
  });

  /**
   * ErrorBanner 那份提示只活到下一条非 error 事件(renderer 的 handleStreamEvent 会清
   * recoverableError),所以「整个会话只说一次」会让用户在后续轮次里完全看不到。每轮
   * 至多一条:不刷屏,又保证每一轮遇到时都有机会看见。
   */
  it('re-arms the notice on each new user turn', async () => {
    const { handle, canUseTool } = await startSession('auto', {
      reviewer: async () => {
        throw new Error('reviewer offline');
      },
      attachResolver: false,
    });
    const { notices } = startNoticeCollector(handle);

    await canUseTool('Write', { file_path: '/tmp/t1.conf' }, { toolUseID: 'turn1-a' });
    await canUseTool('Write', { file_path: '/tmp/t2.conf' }, { toolUseID: 'turn1-b' });
    await settle();
    expect(notices).toHaveLength(1); // 同一轮内两次被拒 → 仍只一条

    await handle.send({ type: 'user', content: 'Try something else then.' });
    await canUseTool('Write', { file_path: '/tmp/t3.conf' }, { toolUseID: 'turn2-a' });
    await settle();
    expect(notices).toHaveLength(2); // 新一轮 → 重新武装
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
