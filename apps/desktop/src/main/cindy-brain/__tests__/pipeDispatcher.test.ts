/**
 * pipeDispatcher.test.ts — 管子工具派发器单测(纯 DI,无 Electron)。
 * 覆盖:资格审错误分类、按需拉起、callId 配对交卷、交卷验身(不能替别人
 * 交卷)、超时作废、崩溃/熄灯收卷。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { GhostPipeDispatcher, toolNotFoundMessage, type PipeDispatcherDeps } from '../pipeDispatcher';
import type { GhostPipeToolCall, InstalledGhost } from '../../../shared/ghost';
import type { GhostRuntimeState } from '../runtime/GhostRuntime';

function fakeGhost(overrides: Partial<InstalledGhost> = {}): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'art',
      name: '画图',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      tools: [{ name: 'gen_image', description: '生成图片' }],
    },
    dir: '/fake/brain/art',
    enabled: true,
    ...overrides,
  } as InstalledGhost;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface Harness {
  dispatcher: GhostPipeDispatcher;
  deps: {
    getGhost: ReturnType<typeof vi.fn>;
    runtimeStateOf: ReturnType<typeof vi.fn>;
    spawn: ReturnType<typeof vi.fn>;
    sendToGhost: ReturnType<typeof vi.fn>;
    log: {
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
    };
  };
  sent: GhostPipeToolCall[];
}

function makeHarness(opts: {
  ghost?: InstalledGhost | null;
  state?: GhostRuntimeState;
  timeoutMs?: number;
  ownerScope?: PipeDispatcherDeps['ownerScope'];
} = {}): Harness {
  const sent: GhostPipeToolCall[] = [];
  const deps = {
    getGhost: vi.fn(() => (opts.ghost === undefined ? fakeGhost() : opts.ghost)),
    runtimeStateOf: vi.fn(() => opts.state ?? 'running'),
    spawn: vi.fn(async () => ({ ok: true as const })),
    sendToGhost: vi.fn((_id: string, payload: GhostPipeToolCall) => {
      sent.push(payload);
      return true;
    }),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
  const dispatcher = new GhostPipeDispatcher({
    ...deps,
    timeoutMs: opts.timeoutMs,
    ownerScope: opts.ownerScope,
  } as unknown as PipeDispatcherDeps);
  return { dispatcher, deps, sent };
}

const CALL = { ghostId: 'art', tool: 'gen_image', args: { prompt: '一只猫' } };

describe('资格审(结构化错误分类)', () => {
  it('未装入 → GHOST_NOT_FOUND', async () => {
    const h = makeHarness({ ghost: null });
    const r = await h.dispatcher.callGhostTool(CALL);
    expect(r).toMatchObject({ ok: false, errorCode: 'GHOST_NOT_FOUND' });
  });

  it('沉睡 → GHOST_ASLEEP', async () => {
    const h = makeHarness({ ghost: fakeGhost({ enabled: false }) });
    const r = await h.dispatcher.callGhostTool(CALL);
    expect(r).toMatchObject({ ok: false, errorCode: 'GHOST_ASLEEP' });
  });

  it('工具未声明 → TOOL_NOT_FOUND', async () => {
    const h = makeHarness();
    const r = await h.dispatcher.callGhostTool({ ...CALL, tool: 'nope' });
    expect(r).toMatchObject({ ok: false, errorCode: 'TOOL_NOT_FOUND' });
  });

  it('TOOL_NOT_FOUND 自愈文案:普通插件列出可用工具', async () => {
    const h = makeHarness();
    const r = await h.dispatcher.callGhostTool({ ...CALL, tool: 'nope' });
    if (r.ok) throw new Error('应失败');
    expect(r.message).toContain('gen_image');
  });

  it('TOOL_NOT_FOUND 自愈文案:二级分派插件回填 call_tool 正确形态', async () => {
    const base = fakeGhost();
    const dispatchGhost = fakeGhost({
      manifest: {
        ...base.manifest,
        tools: [
          { name: 'list_tools', description: '列操作' },
          { name: 'call_tool', description: '分派' },
        ],
      },
    });
    const h = makeHarness({ ghost: dispatchGhost });
    const r = await h.dispatcher.callGhostTool({ ...CALL, tool: 'create_pull_request_review' });
    if (r.ok) throw new Error('应失败');
    expect(r.errorCode).toBe('TOOL_NOT_FOUND');
    expect(r.message).toContain('call_tool');
    expect(r.message).toContain('create_pull_request_review');
  });

  it('熔断中 → GHOST_CRASHED,不尝试拉起', async () => {
    const h = makeHarness({ state: 'fused' });
    const r = await h.dispatcher.callGhostTool(CALL);
    expect(r).toMatchObject({ ok: false, errorCode: 'GHOST_CRASHED' });
    expect(h.deps.spawn).not.toHaveBeenCalled();
  });
});

describe('toolNotFoundMessage(纯函数直测)', () => {
  it('分派型插件:回填 agent 想调的名字并给出 call_tool 形态', () => {
    const msg = toolNotFoundMessage('cindy-github', 'create_pull_request', [
      { name: 'list_tools', description: '' },
      { name: 'call_tool', description: '' },
    ]);
    expect(msg).toContain('cindy-github');
    expect(msg).toContain('create_pull_request');
    expect(msg).toContain('tool:"call_tool"');
    expect(msg).toContain('name:"create_pull_request"');
    expect(msg).toContain('list_tools');
  });

  it('普通插件:列出可用工具名', () => {
    const msg = toolNotFoundMessage('art', 'nope', [{ name: 'gen_image', description: '' }]);
    expect(msg).toContain('gen_image');
    expect(msg).not.toContain('call_tool');
  });

  it('tools 缺省/空:不崩,提示未声明任何工具', () => {
    expect(toolNotFoundMessage('art', 'nope', undefined)).toContain('(未声明任何工具)');
    expect(toolNotFoundMessage('art', 'nope', [])).toContain('(未声明任何工具)');
  });
});

describe('按需拉起', () => {
  it('off 状态先 spawn 再派发', async () => {
    const h = makeHarness({ state: 'off' });
    const p = h.dispatcher.callGhostTool(CALL);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.deps.spawn).toHaveBeenCalledTimes(1);
    h.dispatcher.handleToolResult('art', {
      type: 'tool-result',
      callId: h.sent[0].callId,
      ok: true,
      result: { done: 1 },
    });
    await expect(p).resolves.toMatchObject({ ok: true });
  });

  it('拉起失败 → GHOST_CRASHED', async () => {
    const h = makeHarness({ state: 'off' });
    h.deps.spawn.mockResolvedValue({ ok: false, reason: '入口加载失败' });
    const r = await h.dispatcher.callGhostTool(CALL);
    expect(r).toMatchObject({ ok: false, errorCode: 'GHOST_CRASHED' });
  });

  it('电子脑离线(send 失败)→ GHOST_CRASHED 立即收卷', async () => {
    const h = makeHarness();
    h.deps.sendToGhost.mockReturnValue(false);
    const r = await h.dispatcher.callGhostTool(CALL);
    expect(r).toMatchObject({ ok: false, errorCode: 'GHOST_CRASHED' });
    expect(h.dispatcher.pendingCount()).toBe(0);
  });

  it('owner changes while spawn is pending: stops the runtime and never dispatches', async () => {
    let generation = 1;
    const invalidated = vi.fn();
    const spawnStarted = deferred();
    const releaseSpawn = deferred();
    const h = makeHarness({
      state: 'off',
      ownerScope: {
        capture: () => generation,
        isCurrent: (scope) => scope === generation,
        isStable: (scope) => scope === generation,
        onInvalidated: invalidated,
      },
    });
    h.deps.spawn.mockImplementation(async () => {
      spawnStarted.resolve();
      await releaseSpawn.promise;
      return { ok: true as const };
    });

    const pending = h.dispatcher.callGhostTool(CALL);
    await spawnStarted.promise;
    generation = 2;
    releaseSpawn.resolve();

    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'GHOST_ASLEEP' });
    expect(h.deps.sendToGhost).not.toHaveBeenCalled();
    expect(invalidated).toHaveBeenCalledWith('art');
  });
});

describe('配对交卷', () => {
  it('happy path:交卷 resolve 原始 result', async () => {
    const h = makeHarness();
    const p = h.dispatcher.callGhostTool(CALL);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toMatchObject({ type: 'tool-call', tool: 'gen_image', args: { prompt: '一只猫' } });
    const outcome = h.dispatcher.handleToolResult('art', {
      type: 'tool-result',
      callId: h.sent[0].callId,
      ok: true,
      result: { url: 'cindy-media://blobs/x.png' },
    });
    expect(outcome.accepted).toBe(true);
    await expect(p).resolves.toEqual({ ok: true, result: { url: 'cindy-media://blobs/x.png' } });
    expect(h.dispatcher.pendingCount()).toBe(0);
  });

  it('rejects a stale result after the owner generation changes', async () => {
    let generation = 1;
    const invalidated = vi.fn();
    const h = makeHarness({
      ownerScope: {
        capture: () => generation,
        isCurrent: (scope) => scope === generation,
        isStable: (scope) => scope === generation,
        onInvalidated: invalidated,
      },
    });
    const pending = h.dispatcher.callGhostTool(CALL);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));

    generation = 2;
    const outcome = h.dispatcher.handleToolResult('art', {
      type: 'tool-result',
      callId: h.sent[0].callId,
      ok: true,
      result: { stale: true },
    });

    expect(outcome).toMatchObject({ accepted: false });
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'GHOST_ASLEEP' });
    expect(invalidated).toHaveBeenCalledWith('art');
  });

  it('完成日志只含元数据，不记录参数或返回内容', async () => {
    const h = makeHarness();
    const secretArg = 'must-not-log-argument';
    const secretResult = 'must-not-log-result';
    const p = h.dispatcher.callGhostTool({
      ...CALL,
      args: { prompt: secretArg },
      callId: 'observable-call',
    });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    h.dispatcher.handleToolResult('art', {
      type: 'tool-result',
      callId: 'observable-call',
      ok: true,
      result: { value: secretResult },
    });
    await expect(p).resolves.toMatchObject({ ok: true });

    expect(h.deps.log.info).toHaveBeenCalledTimes(1);
    expect(h.deps.log.info).toHaveBeenCalledWith('ghost tool call completed', {
      ghostId: 'art',
      tool: 'gen_image',
      callId: 'observable-call',
      ok: true,
      totalMs: expect.any(Number),
    });
    const logs = JSON.stringify(h.deps.log.info.mock.calls);
    expect(logs).not.toContain(secretArg);
    expect(logs).not.toContain(secretResult);
  });

  it('意识侧报错 → INTERNAL 透传 message', async () => {
    const h = makeHarness();
    const p = h.dispatcher.callGhostTool(CALL);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    h.dispatcher.handleToolResult('art', {
      type: 'tool-result',
      callId: h.sent[0].callId,
      ok: false,
      message: '画布爆炸',
    });
    await expect(p).resolves.toMatchObject({ ok: false, errorCode: 'INTERNAL', message: '画布爆炸' });
  });

  it('透传合法插件业务错误码，但不允许覆盖主机错误码', async () => {
    const h = makeHarness();
    const business = h.dispatcher.callGhostTool(CALL);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    h.dispatcher.handleToolResult('art', {
      type: 'tool-result',
      callId: h.sent[0].callId,
      ok: false,
      errorCode: 'CONFIRM_REQUIRED',
      message: '请确认',
    });
    await expect(business).resolves.toMatchObject({ ok: false, errorCode: 'CONFIRM_REQUIRED' });

    const reserved = h.dispatcher.callGhostTool(CALL);
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    h.dispatcher.handleToolResult('art', {
      type: 'tool-result',
      callId: h.sent[1].callId,
      ok: false,
      errorCode: 'GHOST_CRASHED',
      message: '伪造主机错误',
    });
    await expect(reserved).resolves.toMatchObject({ ok: false, errorCode: 'INTERNAL' });
  });

  it('别的意识拿到 callId 也交不了卷(验身)', async () => {
    const h = makeHarness();
    const p = h.dispatcher.callGhostTool(CALL);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const outcome = h.dispatcher.handleToolResult('evil-ghost', {
      type: 'tool-result',
      callId: h.sent[0].callId,
      ok: true,
      result: { hijacked: true },
    });
    expect(outcome.accepted).toBe(false);
    // 原调用仍在等真主人交卷。
    expect(h.dispatcher.pendingCount()).toBe(1);
    h.dispatcher.handleToolResult('art', {
      type: 'tool-result',
      callId: h.sent[0].callId,
      ok: true,
      result: 'real',
    });
    await expect(p).resolves.toEqual({ ok: true, result: 'real' });
  });

  it('载荷形状不合法 / 不存在的 callId → 拒收不炸', () => {
    const h = makeHarness();
    expect(h.dispatcher.handleToolResult('art', { type: 'tool-result' }).accepted).toBe(false);
    expect(
      h.dispatcher.handleToolResult('art', { type: 'tool-result', callId: 'ghost-town', ok: true }).accepted,
    ).toBe(false);
  });
});

describe('tool-call 宿主能力绑定', () => {
  it('按 ghostId + callId + callerTool 验身，同请求只允许一次暂态重试', async () => {
    const h = makeHarness();
    const pending = h.dispatcher.callGhostTool(CALL);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const callId = h.sent[0].callId;

    expect(
      h.dispatcher.claimPendingCall(
        'evil-ghost',
        callId,
        'gen_image',
        'cindy.search.web',
        'request-a',
      ),
    ).toBe(false);
    expect(
      h.dispatcher.claimPendingCall(
        'art',
        callId,
        'other_tool',
        'cindy.search.web',
        'request-a',
      ),
    ).toBe(false);
    expect(
      h.dispatcher.claimPendingCall(
        'art',
        callId,
        'gen_image',
        'cindy.search.web',
        'request-a',
      ),
    ).toBe(true);
    expect(
      h.dispatcher.claimPendingCall(
        'art',
        callId,
        'gen_image',
        'cindy.search.web',
        'request-a',
      ),
    ).toBe(false);
    expect(
      h.dispatcher.settlePendingCallClaim(
        'art',
        callId,
        'gen_image',
        'cindy.search.web',
        'request-a',
        true,
      ),
    ).toBe(true);
    expect(
      h.dispatcher.claimPendingCall(
        'art',
        callId,
        'gen_image',
        'cindy.search.web',
        'request-b',
      ),
    ).toBe(false);
    expect(
      h.dispatcher.claimPendingCall(
        'art',
        callId,
        'gen_image',
        'cindy.search.web',
        'request-a',
      ),
    ).toBe(true);
    expect(
      h.dispatcher.settlePendingCallClaim(
        'art',
        callId,
        'gen_image',
        'cindy.search.web',
        'request-a',
        true,
      ),
    ).toBe(true);
    expect(
      h.dispatcher.claimPendingCall(
        'art',
        callId,
        'gen_image',
        'cindy.search.web',
        'request-a',
      ),
    ).toBe(false);

    h.dispatcher.handleToolResult('art', {
      type: 'tool-result',
      callId,
      ok: true,
      result: 'done',
    });
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it('成功或不可重试结果会永久消费 binding', async () => {
    const h = makeHarness();
    const pending = h.dispatcher.callGhostTool(CALL);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const callId = h.sent[0].callId;

    expect(
      h.dispatcher.claimPendingCall(
        'art',
        callId,
        'gen_image',
        'cindy.search.web',
        'request-a',
      ),
    ).toBe(true);
    expect(
      h.dispatcher.settlePendingCallClaim(
        'art',
        callId,
        'gen_image',
        'cindy.search.web',
        'request-a',
        false,
      ),
    ).toBe(true);
    expect(
      h.dispatcher.claimPendingCall(
        'art',
        callId,
        'gen_image',
        'cindy.search.web',
        'request-a',
      ),
    ).toBe(false);

    h.dispatcher.handleToolResult('art', {
      type: 'tool-result',
      callId,
      ok: true,
      result: 'done',
    });
    await expect(pending).resolves.toMatchObject({ ok: true });
  });
});

describe('超时与收卷', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('超时 → TIMEOUT,迟到卷子作废', async () => {
    const h = makeHarness({ timeoutMs: 1000 });
    const p = h.dispatcher.callGhostTool(CALL);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    vi.advanceTimersByTime(1001);
    await expect(p).resolves.toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
    const late = h.dispatcher.handleToolResult('art', {
      type: 'tool-result',
      callId: h.sent[0].callId,
      ok: true,
      result: 'too late',
    });
    expect(late.accepted).toBe(false);
  });

  it('可信宿主可为 UI 查询单独收短超时，不改变普通调用默认档', async () => {
    const h = makeHarness({ timeoutMs: 1000 });
    const short = h.dispatcher.callGhostTool({ ...CALL, timeoutMs: 50 });
    const normal = h.dispatcher.callGhostTool(CALL);
    expect(h.sent).toHaveLength(2);

    vi.advanceTimersByTime(40);
    expect(h.dispatcher.handleToolProgress('art', {
      callId: h.sent[0].callId,
    }).accepted).toBe(true);
    vi.advanceTimersByTime(10);
    await expect(short).resolves.toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
    expect(h.dispatcher.pendingCount()).toBe(1);

    vi.advanceTimersByTime(950);
    await expect(normal).resolves.toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
  });

  it('崩溃收卷 → GHOST_CRASHED;熄灯收卷 → GHOST_ASLEEP;只收本意识的', async () => {
    const h = makeHarness();
    const p1 = h.dispatcher.callGhostTool(CALL);
    const p2 = h.dispatcher.callGhostTool(CALL);
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    expect(h.dispatcher.pendingCount()).toBe(2);

    h.dispatcher.onRuntimeState('other-ghost', 'crashed');
    expect(h.dispatcher.pendingCount()).toBe(2);

    h.dispatcher.onRuntimeState('art', 'crashed');
    await expect(p1).resolves.toMatchObject({ ok: false, errorCode: 'GHOST_CRASHED' });
    await expect(p2).resolves.toMatchObject({ ok: false, errorCode: 'GHOST_CRASHED' });
    expect(h.dispatcher.pendingCount()).toBe(0);

    const p3 = h.dispatcher.callGhostTool(CALL);
    await vi.waitFor(() => expect(h.sent).toHaveLength(3));
    h.dispatcher.onRuntimeState('art', 'off');
    await expect(p3).resolves.toMatchObject({ ok: false, errorCode: 'GHOST_ASLEEP' });
  });
});

describe('长任务续命(hold / release / tool-progress)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('holdCall 把窗口延到代办预算 + 交卷余量;原基础窗口过点不超时', async () => {
    const h = makeHarness({ timeoutMs: 1000 });
    const p = h.dispatcher.callGhostTool(CALL);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const callId = h.sent[0].callId;

    h.dispatcher.holdCall('art', callId, 5_000); // deadline = 5000 + 60_000 余量
    vi.advanceTimersByTime(64_999);
    expect(h.dispatcher.pendingCount()).toBe(1);
    vi.advanceTimersByTime(1);
    await expect(p).resolves.toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
  });

  it('releaseCall 收回长 hold(不短于基础窗口 + 交卷余量);多单代办计数归零才收', async () => {
    const h = makeHarness({ timeoutMs: 1000 });
    const p = h.dispatcher.callGhostTool(CALL);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const callId = h.sent[0].callId;

    h.dispatcher.holdCall('art', callId, 600_000);
    h.dispatcher.holdCall('art', callId, 600_000);
    vi.advanceTimersByTime(10_000);

    h.dispatcher.releaseCall('art', callId); // 还有一单在途:不收
    vi.advanceTimersByTime(120_000);  // t=130_000,若已收(70_000 到点)早超了
    expect(h.dispatcher.pendingCount()).toBe(1);

    h.dispatcher.releaseCall('art', callId); // 全部收工:收到 now + 60_000 余量
    vi.advanceTimersByTime(59_999);
    expect(h.dispatcher.pendingCount()).toBe(1);
    vi.advanceTimersByTime(1);
    await expect(p).resolves.toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
  });

  it('tool-progress 心跳每次续满一个基础档;验身与配对同交卷纪律', async () => {
    const h = makeHarness({ timeoutMs: 1000 });
    const p = h.dispatcher.callGhostTool(CALL);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const callId = h.sent[0].callId;

    vi.advanceTimersByTime(800);
    // 冒名心跳:拒,且不影响窗口。
    expect(h.dispatcher.handleToolProgress('evil-ghost', { callId }).accepted).toBe(false);
    // 载荷非法 / 查无 callId:拒不炸。
    expect(h.dispatcher.handleToolProgress('art', {}).accepted).toBe(false);
    expect(h.dispatcher.handleToolProgress('art', { callId: 'ghost-town' }).accepted).toBe(false);

    expect(h.dispatcher.handleToolProgress('art', { callId }).accepted).toBe(true); // t=800 → 续到 1800
    vi.advanceTimersByTime(999);
    expect(h.dispatcher.pendingCount()).toBe(1);
    vi.advanceTimersByTime(1);
    await expect(p).resolves.toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
  });

  it('续命从派发起算不越过 30 分钟天花板;超时后 hold/心跳皆无效', async () => {
    const h = makeHarness({ timeoutMs: 1000 });
    const p = h.dispatcher.callGhostTool(CALL);
    // 天花板从派发时刻起算:这里不用 vi.waitFor(fake timers 下它会偷偷
    // advance 虚拟时钟,把绝对边界打偏);running 态派发是同步完成的。
    expect(h.sent).toHaveLength(1);
    const callId = h.sent[0].callId;

    h.dispatcher.holdCall('art', callId, 10 * 3600_000); // 10 小时预算 → 钳到 30 分钟
    vi.advanceTimersByTime(30 * 60_000 - 1);
    expect(h.dispatcher.pendingCount()).toBe(1);
    vi.advanceTimersByTime(1);
    await expect(p).resolves.toMatchObject({ ok: false, errorCode: 'TIMEOUT' });

    // 已收卷:心跳拒;hold 静默无害。
    expect(h.dispatcher.handleToolProgress('art', { callId }).accepted).toBe(false);
    h.dispatcher.holdCall('art', callId, 1000);
    expect(h.dispatcher.pendingCount()).toBe(0);
  });

  it('hold 期间正常交卷照常 resolve', async () => {
    const h = makeHarness({ timeoutMs: 1000 });
    const p = h.dispatcher.callGhostTool(CALL);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const callId = h.sent[0].callId;

    h.dispatcher.holdCall('art', callId, 600_000);
    vi.advanceTimersByTime(200_000);
    const outcome = h.dispatcher.handleToolResult('art', {
      type: 'tool-result',
      callId,
      ok: true,
      result: { url: 'cindy-media://blobs/v.mp4' },
    });
    expect(outcome.accepted).toBe(true);
    await expect(p).resolves.toEqual({ ok: true, result: { url: 'cindy-media://blobs/v.mp4' } });
  });

  it('hold/release 验身:冒用别人在途的 callId 不能续命、不能收短、不污染计数', async () => {
    const h = makeHarness({ timeoutMs: 1000 });
    const p = h.dispatcher.callGhostTool(CALL);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const callId = h.sent[0].callId;

    // 冒名 hold:不生效,窗口仍按基础档到点。
    h.dispatcher.holdCall('evil-ghost', callId, 600_000);
    // 真主人 hold 后,冒名 release 也收不走(计数未被污染)。
    h.dispatcher.holdCall('art', callId, 600_000);
    h.dispatcher.releaseCall('evil-ghost', callId);
    vi.advanceTimersByTime(200_000); // 若冒名 release 生效,60s 余量早已到点
    expect(h.dispatcher.pendingCount()).toBe(1);

    h.dispatcher.releaseCall('art', callId);
    vi.advanceTimersByTime(60_000);
    await expect(p).resolves.toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
  });

  it('注入超大 timeoutMs 被钳到天花板,初始窗口不越界', async () => {
    const h = makeHarness({ timeoutMs: 2 * 3600_000 }); // 2 小时 → 钳到 30 分钟
    const p = h.dispatcher.callGhostTool(CALL);
    expect(h.sent).toHaveLength(1);
    vi.advanceTimersByTime(30 * 60_000 - 1);
    expect(h.dispatcher.pendingCount()).toBe(1);
    vi.advanceTimersByTime(1);
    await expect(p).resolves.toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
  });
});

describe('预铸 callId(卡槽③贯通)', () => {
  it('传入 callId 时下行载荷使用同一值;交卷按它配对', async () => {
    const h = makeHarness();
    const p = h.dispatcher.callGhostTool({ ...CALL, callId: 'pre-minted-id' });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0].callId).toBe('pre-minted-id');

    const outcome = h.dispatcher.handleToolResult('art', {
      type: 'tool-result',
      callId: 'pre-minted-id',
      ok: true,
      result: { done: true },
    });
    expect(outcome.accepted).toBe(true);
    await expect(p).resolves.toEqual({ ok: true, result: { done: true } });
  });

  it('空串 callId 回落自铸', async () => {
    const h = makeHarness();
    void h.dispatcher.callGhostTool({ ...CALL, callId: '' });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0].callId).not.toBe('');
    expect(h.sent[0].callId.length).toBeGreaterThan(10);
  });
});
