/**
 * errandSlot.test.ts — 派活取件守门层单测(纯 DI,无 Electron)。
 * 覆盖:资格审(agent 槽 + errand 详单)、载荷校验、频控(最小间隔 + 单在途)、
 * 异步受理/查询生命周期、wait 同步、结果截断、归属校验话术、TTL 清理、
 * runner 异常折叠、clearGhost。
 */

import { describe, it, expect, vi } from 'vitest';

import {
  clampErrandResultText,
  GhostErrandSlot,
  type GhostErrandRunner,
  type GhostErrandSlotDeps,
} from '../errandSlot';
import {
  GHOST_ERRAND_JOB_TTL_MS,
  GHOST_ERRAND_MAX_RESULT_CHARS,
  GHOST_ERRAND_MIN_INTERVAL_MS,
  type InstalledGhost,
} from '../../../shared/ghost';

function fakeGhost(
  overrides: { enabled?: boolean; slots?: string[]; agent?: Record<string, unknown> | null } = {},
): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'helper',
      name: '帮手',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: overrides.slots ?? ['tool', 'agent'],
      ...(overrides.agent === null ? {} : { agent: overrides.agent ?? { errand: true } }),
    },
    dir: '/fake/brain/helper',
    enabled: overrides.enabled ?? true,
  } as InstalledGhost;
}

function makeSlot(overrides: Partial<GhostErrandSlotDeps> = {}): {
  slot: GhostErrandSlot;
  runner: ReturnType<typeof vi.fn>;
  clock: { now: number };
} {
  const clock = { now: 1_000_000 };
  const runner = vi.fn(async () => ({
    ok: true as const,
    sessionId: 'sess-1',
    text: '干完了',
    agentKind: 'cc',
    model: 'claude-x',
  }));
  const slot = new GhostErrandSlot({
    getGhost: () => fakeGhost(),
    runner: runner as unknown as GhostErrandRunner,
    now: () => clock.now,
    createJobId: (() => {
      let n = 0;
      return () => `job-${++n}`;
    })(),
    ...overrides,
  });
  return { slot, runner, clock };
}

const RUN = { type: 'agent-errand-request', kind: 'run', task: '总结 README' };

describe('资格审', () => {
  it('未声明 agent 槽 / 未声明 errand / 未启用 → PERMISSION_DENIED', async () => {
    for (const ghost of [
      fakeGhost({ slots: ['tool'] }),
      fakeGhost({ agent: null }),
      fakeGhost({ agent: { background: true } }),
      fakeGhost({ enabled: false }),
    ]) {
      const { slot, runner } = makeSlot({ getGhost: () => ghost });
      expect(await slot.handleRequest('helper', RUN)).toMatchObject({
        ok: false,
        errorCode: 'PERMISSION_DENIED',
      });
      expect(runner).not.toHaveBeenCalled();
    }
  });
});

describe('载荷校验', () => {
  it('空 task / 超长 task / 非法 title / 非法 mode / 非法 callId → INVALID_REQUEST', async () => {
    const { slot } = makeSlot();
    const cases = [
      { ...RUN, task: '  ' },
      { ...RUN, task: 'x'.repeat(32_769) },
      { ...RUN, title: '' },
      { ...RUN, title: 'x'.repeat(101) },
      { ...RUN, mode: 'submit' },
      { ...RUN, callId: '' },
      { ...RUN, workingDir: '' },
      { ...RUN, workingDir: '   ' },
      { ...RUN, workingDir: 42 },
      { ...RUN, workingDir: 'x'.repeat(1025) },
      { ...RUN, sessionKey: '' },
      { ...RUN, sessionKey: 'pr#1' },
      { ...RUN, sessionKey: 'x'.repeat(65) },
      { ...RUN, sessionKey: 42 },
    ];
    for (const payload of cases) {
      expect(await slot.handleRequest('helper', payload)).toMatchObject({
        ok: false,
        errorCode: 'INVALID_REQUEST',
      });
    }
  });

  it('context 不可 JSON 化 / JSON 超长 → INVALID_REQUEST', async () => {
    const { slot } = makeSlot();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(await slot.handleRequest('helper', { ...RUN, context: cyclic })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(
      await slot.handleRequest('helper', { ...RUN, context: 'x'.repeat(65_600) }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
  });

  it('context 以固定标记附在任务消息尾部(确定性组装)', async () => {
    const { slot, runner } = makeSlot();
    await slot.handleRequest('helper', { ...RUN, context: { a: 1 } });
    const req = runner.mock.calls[0][0] as { message: string };
    expect(req.message).toBe('总结 README\n\n[结构化上下文 JSON]\n{"a":1}');
  });

  it('sessionKey 合法时原样透传 runner;不传则请求里不带该字段', async () => {
    const { slot, runner, clock } = makeSlot();
    await slot.handleRequest('helper', { ...RUN, sessionKey: 'pr-123' });
    expect((runner.mock.calls[0][0] as { sessionKey?: string }).sessionKey).toBe('pr-123');
    clock.now += GHOST_ERRAND_MIN_INTERVAL_MS;
    await slot.handleRequest('helper', RUN);
    expect('sessionKey' in (runner.mock.calls[1][0] as object)).toBe(false);
  });

  it('workingDir 原样透传给 runner(是否亲选目录由 runner 对台账把关)', async () => {
    const { slot, runner } = makeSlot();
    await slot.handleRequest('helper', { ...RUN, workingDir: '/proj/repo' });
    expect(runner.mock.calls[0][0]).toMatchObject({ workingDir: '/proj/repo' });
  });

  it('不带 workingDir 时 runner 请求里没有该字段', async () => {
    const { slot, runner } = makeSlot();
    await slot.handleRequest('helper', RUN);
    expect('workingDir' in (runner.mock.calls[0][0] as object)).toBe(false);
  });
});

describe('频控', () => {
  it('相邻提交小于最小间隔 → RATE_LIMITED;runner 失败也不退间隔', async () => {
    const { slot, runner, clock } = makeSlot({
      runner: vi.fn(async () => ({
        ok: false as const,
        errorCode: 'INTERNAL' as const,
        message: '炸了',
      })) as unknown as GhostErrandRunner,
    });
    void runner;
    await slot.handleRequest('helper', RUN);
    clock.now += GHOST_ERRAND_MIN_INTERVAL_MS - 1;
    expect(await slot.handleRequest('helper', RUN)).toMatchObject({
      ok: false,
      errorCode: 'RATE_LIMITED',
    });
  });

  it('单在途:上一单未完成时再提交 → BUSY', async () => {
    let release: (() => void) | null = null;
    const runner = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ ok: true, sessionId: 's', text: 'done' });
        }),
    );
    const { slot, clock } = makeSlot({ runner: runner as unknown as GhostErrandRunner });
    const first = await slot.handleRequest('helper', RUN);
    expect(first).toMatchObject({ ok: true, status: 'running' });
    clock.now += GHOST_ERRAND_MIN_INTERVAL_MS + 1;
    expect(await slot.handleRequest('helper', RUN)).toMatchObject({
      ok: false,
      errorCode: 'BUSY',
    });
    release!();
  });

  it('runner 未注入 → HOST_NOT_READY', async () => {
    const { slot } = makeSlot({ runner: null });
    expect(await slot.handleRequest('helper', RUN)).toMatchObject({
      ok: false,
      errorCode: 'HOST_NOT_READY',
    });
  });
});

describe('异步受理 + 查询生命周期', () => {
  it('受理即返 jobId;进行中可见 sessionId(onSession 回填)与耗时;完成后取件', async () => {
    let finish: (() => void) | null = null;
    let hooks: { onSession?: (sid: string) => void } | undefined;
    const runner = vi.fn((_req: unknown, h?: { onSession?: (sid: string) => void }) => {
      hooks = h;
      return new Promise((resolve) => {
        finish = () =>
          resolve({ ok: true, sessionId: 'sess-9', text: '结果文字', agentKind: 'cc', model: 'm1' });
      });
    });
    const { slot, clock } = makeSlot({ runner: runner as unknown as GhostErrandRunner });
    const accepted = await slot.handleRequest('helper', RUN);
    expect(accepted).toMatchObject({ ok: true, jobId: 'job-1', status: 'running' });

    hooks?.onSession?.('sess-9');
    clock.now += 5000;
    expect(
      await slot.handleRequest('helper', { type: 'agent-errand-request', kind: 'query', jobId: 'job-1' }),
    ).toMatchObject({ ok: true, status: 'running', sessionId: 'sess-9', elapsedSeconds: 5 });

    finish!();
    await new Promise((r) => setTimeout(r, 0));
    expect(
      await slot.handleRequest('helper', { type: 'agent-errand-request', kind: 'query', jobId: 'job-1' }),
    ).toMatchObject({
      ok: true,
      status: 'done',
      sessionId: 'sess-9',
      text: '结果文字',
      agentKind: 'cc',
      model: 'm1',
    });
  });

  it('runner 失败 → 查询返回结构化失败;runner 抛错 → INTERNAL', async () => {
    const failed = makeSlot({
      runner: vi.fn(async () => ({
        ok: false as const,
        errorCode: 'TIMEOUT' as const,
        message: '超时了',
      })) as unknown as GhostErrandRunner,
    });
    const a = await failed.slot.handleRequest('helper', RUN);
    await new Promise((r) => setTimeout(r, 0));
    expect(
      await failed.slot.handleRequest('helper', {
        type: 'agent-errand-request',
        kind: 'query',
        jobId: (a as { jobId: string }).jobId,
      }),
    ).toMatchObject({ ok: false, errorCode: 'TIMEOUT', message: '超时了' });

    const thrown = makeSlot({
      runner: vi.fn(async () => {
        throw new Error('爆炸');
      }) as unknown as GhostErrandRunner,
    });
    const b = await thrown.slot.handleRequest('helper', RUN);
    await new Promise((r) => setTimeout(r, 0));
    expect(
      await thrown.slot.handleRequest('helper', {
        type: 'agent-errand-request',
        kind: 'query',
        jobId: (b as { jobId: string }).jobId,
      }),
    ).toMatchObject({ ok: false, errorCode: 'INTERNAL' });
  });

  it('查无此单与他人单同一话术(JOB_NOT_FOUND,不泄露归属差异)', async () => {
    const { slot } = makeSlot();
    await slot.handleRequest('helper', RUN);
    await new Promise((r) => setTimeout(r, 0));
    const foreign = await slot.handleRequest('other', {
      type: 'agent-errand-request',
      kind: 'query',
      jobId: 'job-1',
    });
    // other 未声明 errand → 先被资格审拦;换一个声明了的插件查别人的单:
    expect(foreign).toMatchObject({ ok: false });
    const otherGhost = fakeGhost();
    (otherGhost.manifest as { id: string }).id = 'other';
    const slot2 = makeSlot({
      getGhost: (id) => (id === 'other' ? otherGhost : fakeGhost()),
    });
    await slot2.slot.handleRequest('helper', RUN);
    await new Promise((r) => setTimeout(r, 0));
    expect(
      await slot2.slot.handleRequest('other', {
        type: 'agent-errand-request',
        kind: 'query',
        jobId: 'job-1',
      }),
    ).toMatchObject({ ok: false, errorCode: 'JOB_NOT_FOUND' });
    expect(
      await slot2.slot.handleRequest('helper', {
        type: 'agent-errand-request',
        kind: 'query',
        jobId: 'job-none',
      }),
    ).toMatchObject({ ok: false, errorCode: 'JOB_NOT_FOUND' });
  });

  it('完成态过 TTL 被惰性清理 → 查无此单', async () => {
    const { slot, clock } = makeSlot();
    const a = await slot.handleRequest('helper', RUN);
    await new Promise((r) => setTimeout(r, 0));
    clock.now += GHOST_ERRAND_JOB_TTL_MS + 1;
    expect(
      await slot.handleRequest('helper', {
        type: 'agent-errand-request',
        kind: 'query',
        jobId: (a as { jobId: string }).jobId,
      }),
    ).toMatchObject({ ok: false, errorCode: 'JOB_NOT_FOUND' });
  });
});

describe('wait 同步模式', () => {
  it('直接返回完成态;署名单在途 hold/release 管子', async () => {
    const holdPipeCall = vi.fn();
    const releasePipeCall = vi.fn();
    const { slot } = makeSlot({ holdPipeCall, releasePipeCall });
    const r = await slot.handleRequest('helper', { ...RUN, mode: 'wait', callId: 'call-1' });
    expect(r).toMatchObject({ ok: true, status: 'done', text: '干完了', sessionId: 'sess-1' });
    expect(holdPipeCall).toHaveBeenCalledWith('helper', 'call-1', expect.any(Number));
    expect(releasePipeCall).toHaveBeenCalledWith('helper', 'call-1');
  });

  it('未署名(无 callId)不 hold', async () => {
    const holdPipeCall = vi.fn();
    const { slot } = makeSlot({ holdPipeCall });
    await slot.handleRequest('helper', { ...RUN, mode: 'wait' });
    expect(holdPipeCall).not.toHaveBeenCalled();
  });
});

describe('结果截断', () => {
  it('超过上限从头保留并带明示标记', () => {
    const text = 'x'.repeat(GHOST_ERRAND_MAX_RESULT_CHARS + 10);
    const clamped = clampErrandResultText(text);
    expect(clamped.length).toBeLessThan(text.length + 30);
    expect(clamped).toContain('已截断');
    expect(clampErrandResultText('短')).toBe('短');
  });
});

describe('clearGhost', () => {
  it('clearGhost 后仍把在途 errand 视为忙,直到 execute finally 收口', async () => {
    let release: (() => void) | null = null;
    const runner = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, sessionId: 'sess-1', text: 'done' });
        }),
    );
    const { slot } = makeSlot({ runner: runner as unknown as GhostErrandRunner });

    await expect(slot.handleRequest('helper', RUN)).resolves.toMatchObject({
      ok: true,
      status: 'running',
    });
    expect(slot.hasActiveErrandFor('helper')).toBe(true);
    slot.clearGhost('helper');
    expect(slot.hasActiveErrandFor('helper')).toBe(true);

    release!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slot.hasActiveErrandFor('helper')).toBe(false);
  });

  it('清除任务记录与节流状态', async () => {
    const { slot, clock } = makeSlot();
    const a = await slot.handleRequest('helper', RUN);
    await new Promise((r) => setTimeout(r, 0));
    slot.clearGhost('helper');
    expect(
      await slot.handleRequest('helper', {
        type: 'agent-errand-request',
        kind: 'query',
        jobId: (a as { jobId: string }).jobId,
      }),
    ).toMatchObject({ ok: false, errorCode: 'JOB_NOT_FOUND' });
    // 节流状态一并清:立刻可再次提交(不受最小间隔限制)。
    void clock;
    expect(await slot.handleRequest('helper', RUN)).toMatchObject({ ok: true, status: 'running' });
  });
});
