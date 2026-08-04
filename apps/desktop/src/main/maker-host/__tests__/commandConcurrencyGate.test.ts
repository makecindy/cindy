import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCommandConcurrencyGate,
  type CommandConcurrencyGate,
} from '../command-concurrency-gate';

const silentLog = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function makeGate(opts?: {
  limit?: () => number;
  queueWaitMaxMs?: number;
  runningTtlMs?: number;
}): { gate: CommandConcurrencyGate; setLimit: (n: number) => void } {
  let limit = 2;
  const gate = createCommandConcurrencyGate({
    readMaxConcurrent: opts?.limit ?? (() => limit),
    log: silentLog,
    queueWaitMaxMs: opts?.queueWaitMaxMs,
    runningTtlMs: opts?.runningTtlMs,
  });
  return { gate, setLimit: (n) => (limit = n) };
}

/** 让已 resolve 的 promise 回调有机会跑完(fake timers 下 microtask 仍即时)。 */
async function settled(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('command concurrency gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('admits immediately while under the limit', async () => {
    const { gate } = makeGate();
    await expect(gate.acquire({ toolUseId: 'a', sessionId: 's1' })).resolves.toBe('immediate');
    await expect(gate.acquire({ toolUseId: 'b', sessionId: 's1' })).resolves.toBe('immediate');
    expect(gate.snapshot()).toEqual({ running: 2, queued: 0 });
  });

  it('admits everything without queueing when limit is 0 (unlimited)', async () => {
    const { gate, setLimit } = makeGate();
    setLimit(0);
    for (let i = 0; i < 10; i += 1) {
      await expect(gate.acquire({ toolUseId: `t${i}`, sessionId: 's1' })).resolves.toBe(
        'immediate',
      );
    }
    expect(gate.snapshot()).toEqual({ running: 10, queued: 0 });
  });

  it('queues over-limit commands and admits them FIFO on release', async () => {
    const { gate } = makeGate();
    await gate.acquire({ toolUseId: 'a', sessionId: 's1' });
    await gate.acquire({ toolUseId: 'b', sessionId: 's1' });

    const admissions: string[] = [];
    const c = gate.acquire({ toolUseId: 'c', sessionId: 's2' }).then((r) => {
      admissions.push(`c:${r}`);
      return r;
    });
    const d = gate.acquire({ toolUseId: 'd', sessionId: 's2' }).then((r) => {
      admissions.push(`d:${r}`);
      return r;
    });
    expect(gate.snapshot()).toEqual({ running: 2, queued: 2 });

    gate.release('a', 'test');
    await settled();
    expect(admissions).toEqual(['c:queued']);
    expect(gate.snapshot()).toEqual({ running: 2, queued: 1 });

    gate.release('b', 'test');
    await settled();
    expect(admissions).toEqual(['c:queued', 'd:queued']);
    await expect(c).resolves.toBe('queued');
    await expect(d).resolves.toBe('queued');
  });

  it('does not let a new command jump a non-empty queue after the limit is raised', async () => {
    const { gate, setLimit } = makeGate();
    await gate.acquire({ toolUseId: 'a', sessionId: 's1' });
    await gate.acquire({ toolUseId: 'b', sessionId: 's1' });
    const waiting = gate.acquire({ toolUseId: 'c', sessionId: 's1' });
    expect(gate.snapshot().queued).toBe(1);

    // limit 热更调高:下一个 acquire 先 pump,老等待者 c 先占新槽,新命令 d 排它后面
    setLimit(3);
    const next = gate.acquire({ toolUseId: 'd', sessionId: 's1' });
    await settled();
    await expect(waiting).resolves.toBe('queued');
    // d 进来时 c 已被 pump 放行,槽位 3/3 满,d 排队
    expect(gate.snapshot()).toEqual({ running: 3, queued: 1 });
    gate.release('a', 'test');
    await expect(next).resolves.toBe('queued');
  });

  it('repumps queued waiters within one poll interval after the limit is raised (no acquire/release needed)', async () => {
    const { gate, setLimit } = makeGate();
    await gate.acquire({ toolUseId: 'a', sessionId: 's1' });
    await gate.acquire({ toolUseId: 'b', sessionId: 's1' });
    const c = gate.acquire({ toolUseId: 'c', sessionId: 's1' });
    const d = gate.acquire({ toolUseId: 'd', sessionId: 's1' });
    expect(gate.snapshot()).toEqual({ running: 2, queued: 2 });

    // limit 热更调高:没有任何 acquire/release 事件,repump 轮询必须自己唤醒队列
    setLimit(4);
    vi.advanceTimersByTime(1000);
    await expect(c).resolves.toBe('queued');
    await expect(d).resolves.toBe('queued');
    expect(gate.snapshot()).toEqual({ running: 4, queued: 0 });
  });

  it('repumps everything when the limit is switched to unlimited mid-wait', async () => {
    const { gate, setLimit } = makeGate();
    await gate.acquire({ toolUseId: 'a', sessionId: 's1' });
    await gate.acquire({ toolUseId: 'b', sessionId: 's1' });
    const waiting = gate.acquire({ toolUseId: 'c', sessionId: 's1' });

    setLimit(0);
    vi.advanceTimersByTime(1000);
    await expect(waiting).resolves.toBe('queued');
    // 队列清空后 repump 轮询自停:继续推进时间不应产生任何状态变化
    vi.advanceTimersByTime(10_000);
    expect(gate.snapshot()).toEqual({ running: 3, queued: 0 });
  });

  it('fails open with wait-timeout after queueWaitMaxMs', async () => {
    const { gate } = makeGate({ queueWaitMaxMs: 1000 });
    await gate.acquire({ toolUseId: 'a', sessionId: 's1' });
    await gate.acquire({ toolUseId: 'b', sessionId: 's1' });
    const waiting = gate.acquire({ toolUseId: 'c', sessionId: 's1' });

    vi.advanceTimersByTime(1001);
    await expect(waiting).resolves.toBe('wait-timeout');
    // 超时放行仍登记 running,如实反映超载
    expect(gate.snapshot()).toEqual({ running: 3, queued: 0 });
    expect(silentLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('timed out'),
      expect.objectContaining({ toolUseId: 'c' }),
    );
  });

  it('resolves aborted when the signal fires while queued, without taking a slot', async () => {
    const { gate } = makeGate();
    await gate.acquire({ toolUseId: 'a', sessionId: 's1' });
    await gate.acquire({ toolUseId: 'b', sessionId: 's1' });
    const controller = new AbortController();
    const waiting = gate.acquire({
      toolUseId: 'c',
      sessionId: 's1',
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiting).resolves.toBe('aborted');
    expect(gate.snapshot()).toEqual({ running: 2, queued: 0 });
    // 之后到达的 release(c) 不应误伤任何在途槽位
    gate.release('c', 'test');
    expect(gate.snapshot()).toEqual({ running: 2, queued: 0 });
  });

  it('resolves aborted immediately when the signal is already aborted', async () => {
    const { gate } = makeGate();
    const controller = new AbortController();
    controller.abort();
    await expect(
      gate.acquire({ toolUseId: 'a', sessionId: 's1', signal: controller.signal }),
    ).resolves.toBe('aborted');
    expect(gate.snapshot()).toEqual({ running: 0, queued: 0 });
  });

  it('release is idempotent and unknown ids are no-ops', async () => {
    const { gate } = makeGate();
    await gate.acquire({ toolUseId: 'a', sessionId: 's1' });
    gate.release('a', 'test');
    gate.release('a', 'test');
    gate.release('never-acquired', 'test');
    expect(gate.snapshot()).toEqual({ running: 0, queued: 0 });
  });

  it('releasing a queued id (e.g. PermissionDenied while waiting) cancels the wait', async () => {
    const { gate } = makeGate();
    await gate.acquire({ toolUseId: 'a', sessionId: 's1' });
    await gate.acquire({ toolUseId: 'b', sessionId: 's1' });
    const waiting = gate.acquire({ toolUseId: 'c', sessionId: 's1' });
    gate.release('c', 'permission-denied');
    await expect(waiting).resolves.toBe('aborted');
    expect(gate.snapshot()).toEqual({ running: 2, queued: 0 });
  });

  it('releaseSession clears running slots and cancels queued waiters of that session', async () => {
    const { gate } = makeGate();
    await gate.acquire({ toolUseId: 'a', sessionId: 's1' });
    await gate.acquire({ toolUseId: 'b', sessionId: 's2' });
    const s1Waiter = gate.acquire({ toolUseId: 'c', sessionId: 's1' });
    const s2Waiter = gate.acquire({ toolUseId: 'd', sessionId: 's2' });

    gate.releaseSession('s1', 'session-end');
    await settled();
    await expect(s1Waiter).resolves.toBe('aborted');
    // s1 释放了一个槽,s2 的等待者顶上
    await expect(s2Waiter).resolves.toBe('queued');
    expect(gate.snapshot()).toEqual({ running: 2, queued: 0 });
  });

  it('reclaims stale running slots after the TTL (lost release events)', async () => {
    const { gate } = makeGate({ runningTtlMs: 60_000 });
    await gate.acquire({ toolUseId: 'a', sessionId: 's1' });
    await gate.acquire({ toolUseId: 'b', sessionId: 's1' });

    vi.advanceTimersByTime(61_000);
    // 下一次 acquire 触发 sweep:两个僵尸槽被回收,新命令直接放行
    await expect(gate.acquire({ toolUseId: 'c', sessionId: 's1' })).resolves.toBe('immediate');
    expect(gate.snapshot()).toEqual({ running: 1, queued: 0 });
    expect(silentLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('stale slot'),
      expect.objectContaining({ toolUseId: 'a' }),
    );
  });

  it('treats a throwing limit reader as unlimited (fail-open)', async () => {
    const { gate } = makeGate({
      limit: () => {
        throw new Error('boom');
      },
    });
    for (let i = 0; i < 5; i += 1) {
      await expect(gate.acquire({ toolUseId: `t${i}`, sessionId: 's1' })).resolves.toBe(
        'immediate',
      );
    }
    expect(gate.snapshot()).toEqual({ running: 5, queued: 0 });
  });

  it('lowering the limit mid-flight blocks new admissions until running drains below it', async () => {
    const { gate, setLimit } = makeGate();
    setLimit(3);
    await gate.acquire({ toolUseId: 'a', sessionId: 's1' });
    await gate.acquire({ toolUseId: 'b', sessionId: 's1' });
    await gate.acquire({ toolUseId: 'c', sessionId: 's1' });

    setLimit(1);
    const waiting = gate.acquire({ toolUseId: 'd', sessionId: 's1' });
    expect(gate.snapshot()).toEqual({ running: 3, queued: 1 });
    gate.release('a', 'test');
    // 3 → 2,仍在 limit=1 之上,d 继续等
    expect(gate.snapshot()).toEqual({ running: 2, queued: 1 });
    gate.release('b', 'test');
    // 2 → 1,仍不低于 limit=1,d 继续等
    expect(gate.snapshot()).toEqual({ running: 1, queued: 1 });
    gate.release('c', 'test');
    await expect(waiting).resolves.toBe('queued');
    expect(gate.snapshot()).toEqual({ running: 1, queued: 0 });
  });
});
