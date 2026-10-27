/**
 * 多任务共用一个 poll：被控端按游标返回、控制端去重，链路抖动后不丢不重。
 */
import { randomUUID } from 'node:crypto';

import { REMOTE_AGENT_MAX_POLL_RUNS, REMOTE_AGENT_READ_MAX_BYTES, REMOTE_AGENT_READ_WAIT_MS, type RemoteAgentErrorInfo } from '@cindy/device-link';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteAgentPoller, type PolledRun } from '../controller/poller';
import { EventLog } from '../eventLog';
import { REMOTE_AGENT_HOST_IDLE_MS } from '../host/runHost';

interface FakeRun {
  log: EventLog;
}

/** 与 runHost 的 poll 同一套语义的最小被控端(只关心事件流)。 */
function fakeHost(maxWaitMs = 200) {
  const runs = new Map<string, FakeRun>();
  const calls: Array<{ runs: Array<{ runId: string; cursor: number }>; waitMs?: number }> = [];
  let failNext: Error | null = null;
  const host = {
    runs,
    calls,
    failNext(error: Error) {
      failNext = error;
    },
    add(runId: string) {
      const run = { log: new EventLog(1 << 20) };
      runs.set(runId, run);
      return run.log;
    },
    async invoke(args: unknown[]): Promise<unknown> {
      const request = args[0] as { op: string; runs: Array<{ runId: string; cursor: number }>; waitMs?: number };
      calls.push({ runs: request.runs, waitMs: request.waitMs });
      if (failNext) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      const live = request.runs.flatMap(({ runId, cursor }) => {
        const run = runs.get(runId);
        return run && run.log.isValidCursor(cursor) ? [{ run, cursor }] : [];
      });
      const ready = live.length < request.runs.length || live.some(({ run, cursor }) => run.log.isReady(cursor));
      if (!ready && (request.waitMs ?? 0) > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(finish, Math.min(request.waitMs ?? 0, maxWaitMs));
          const offs = live.map(({ run }) => run.log.onChange(finish));
          function finish() {
            clearTimeout(timer);
            for (const off of offs) off();
            resolve();
          }
        });
      }
      return {
        runs: request.runs.flatMap(({ runId, cursor }): Array<Record<string, unknown>> => {
          const run = runs.get(runId);
          if (!run || !run.log.isValidCursor(cursor)) return [{ runId, cursor, missing: true }];
          const result = run.log.readNow(cursor, REMOTE_AGENT_READ_MAX_BYTES);
          if (!result.data?.length && !result.done) return [];
          return [{
            runId,
            ...(result.from !== cursor ? { from: result.from } : {}),
            cursor: result.cursor,
            ...(result.data?.length ? { data: result.data.toString('base64') } : {}),
            ...(result.done ? { done: true } : {}),
          }];
        }),
      };
    },
  };
  return host;
}

function collector(runId: string) {
  const chunks: Buffer[] = [];
  let done = false;
  let lost: { reason: string; error: RemoteAgentErrorInfo } | null = null;
  const run: PolledRun = {
    runId,
    onData(data, isDone) {
      chunks.push(data);
      if (isDone) done = true;
    },
    onLost(reason, error) {
      lost = { reason, error };
    },
  };
  return {
    run,
    text: () => Buffer.concat(chunks).toString(),
    get done() {
      return done;
    },
    get lost() {
      return lost;
    },
  };
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('multiplexed poll', () => {
  // 长等待最多两个，另留一个给没有在途覆盖的任务，持续到普通 poll 接手；合计不超过 3 个。
  it.each([130, 1000])('refreshes all %i idle runs before host expiry with at most three polls', async count => {
    vi.useFakeTimers();
    const host = fakeHost(REMOTE_AGENT_READ_WAIT_MS);
    const lastRead = new Map<string, number>();
    let inflight = 0;
    let peak = 0;
    const poller = new RemoteAgentPoller(async args => {
      const request = args[0] as { runs: Array<{ runId: string }> };
      expect(request.runs.length).toBeLessThanOrEqual(REMOTE_AGENT_MAX_POLL_RUNS);
      request.runs.forEach(({ runId }) => lastRead.set(runId, Date.now()));
      peak = Math.max(peak, ++inflight);
      try { return await host.invoke(args); } finally { inflight -= 1; }
    });
    const sinks = Array.from({ length: count }, (_, i) => collector(`idle-${i}`));
    for (const sink of sinks) {
      host.add(sink.run.runId);
      lastRead.set(sink.run.runId, Date.now());
      poller.register(sink.run);
    }
    try {
      // 没有任何事件，host 每次都挂满 10 秒；连续检查两个回收周期。
      for (let elapsed = 0; elapsed < REMOTE_AGENT_HOST_IDLE_MS * 2; elapsed += 5_000) {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(Math.max(...[...lastRead.values()].map(at => Date.now() - at))).toBeLessThan(REMOTE_AGENT_HOST_IDLE_MS);
      }
      expect(peak).toBeLessThanOrEqual(3);
      expect(sinks.every(sink => sink.lost === null)).toBe(true);
    } finally {
      sinks.forEach(sink => poller.unregister(sink.run.runId));
      await vi.advanceTimersByTimeAsync(REMOTE_AGENT_READ_WAIT_MS);
    }
  });
  // provider-sharing.md §3「闲置收回由提供方决定」：本机还有对方看不到的工作(Codex 在本机起的进程)时，拉取带 hold，
  // 对方不按闲置收回；工作结束就不再带。判断出错时照常拉取、不带 hold(否则可能永远不收回)。
  it('marks only runs with local work as held, and stops once that work ends', async () => {
    const host = fakeHost(20);
    const busy = collector('busy');
    const idle = collector('idle');
    const broken = collector('broken');
    let holding = true;
    busy.run.holdsRemote = () => holding;
    broken.run.holdsRemote = () => { throw new Error('boom'); };
    const sinks = [busy, idle, broken];
    for (const sink of sinks) host.add(sink.run.runId);
    const poller = new RemoteAgentPoller((args) => host.invoke(args));
    const held = (call: (typeof host.calls)[number]) =>
      (call.runs as Array<{ runId: string; hold?: true }>).filter((run) => run.hold).map((run) => run.runId);
    try {
      for (const sink of sinks) poller.register(sink.run);
      await until(() => host.calls.some((call) => call.runs.length === 3));
      expect(held(host.calls.find((call) => call.runs.length === 3)!)).toEqual(['busy']);
      holding = false;
      const seen = host.calls.length;
      await until(() => host.calls.length > seen + 2);
      expect(held(host.calls.at(-1)!)).toEqual([]);
      expect(sinks.every((sink) => sink.lost === null)).toBe(true);
    } finally {
      sinks.forEach((sink) => poller.unregister(sink.run.runId));
    }
  });

  it('keeps pulling a run registered during a long wait, without waiting for the old poll to time out', async () => {
    // 被控端照实挂满等待时间：旧的长等待只覆盖第一个任务。
    const host = fakeHost(10_000);
    const poller = new RemoteAgentPoller((args) => host.invoke(args));
    const first = randomUUID();
    const second = randomUUID();
    host.add(first).append({ step: 'started' });
    const firstSink = collector(first);
    poller.register(firstSink.run);
    await until(() => firstSink.text().includes('started'));
    const secondLog = host.add(second);
    const secondSink = collector(second);
    poller.register(secondSink.run);
    secondLog.append({ step: 'projection' });
    await until(() => secondSink.text().includes('projection'));
    const startedAt = Date.now();
    secondLog.append({ step: 'started' });
    await until(() => secondSink.text().includes('"started"'), 2_000);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    host.runs.get(first)!.log.end();
    secondLog.end();
    await until(() => firstSink.done && secondSink.done);
  });

  // 2026-10-22 远程供应商调查：两个旧任务的长等待都在途且都没有数据时，新任务第一个事件(Codex 执行环境
  // 的 initialize 握手)要等旧长等待超时 10 秒才有人拉，正好撞上 Codex 握手的 10 秒上限。
  it('pulls a run registered behind two idle long waits within one round trip', async () => {
    vi.useFakeTimers();
    const host = fakeHost(REMOTE_AGENT_READ_WAIT_MS);
    const poller = new RemoteAgentPoller((args) => host.invoke(args));
    const sinks = [randomUUID(), randomUUID(), randomUUID()].map((runId) => {
      host.add(runId);
      return collector(runId);
    });
    poller.register(sinks[0].run);
    poller.register(sinks[1].run);
    await vi.advanceTimersByTimeAsync(1);
    poller.register(sinks[2].run);
    // #6844 review：首包只有连接打开，initialize 与后续文件查询分别到达；补位必须持续到普通 poll 接手。
    for (const data of ['open', 'initialize', 'fs/getMetadata']) {
      const appendedAt = Date.now();
      host.runs.get(sinks[2].run.runId)!.log.append({ t: 'ws', kind: 'message', data });
      await vi.waitFor(() => expect(sinks[2].text()).toContain(data));
      expect(Date.now() - appendedAt).toBeLessThan(1_000);
    }
    // 补位 poll 也在等待时，再登记第四个任务：不能再次被三个旧长等待挡住 10 秒。
    const fourth = collector(randomUUID());
    host.add(fourth.run.runId).append({ step: 'fourth-started' });
    poller.register(fourth.run);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(fourth.text()).toContain('fourth-started');
    for (const run of host.runs.values()) run.log.end();
    await vi.advanceTimersByTimeAsync(REMOTE_AGENT_READ_WAIT_MS);
    expect(sinks.every((sink) => sink.done)).toBe(true);
    expect(fourth.done).toBe(true);
  });

  it.each([12, 130])('delivers %i runs exactly once with at most three polls in flight', async count => {
    const host = fakeHost();
    let inflight = 0;
    let peak = 0;
    const poller = new RemoteAgentPoller(async (args) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      try {
        return await host.invoke(args);
      } finally {
        inflight -= 1;
      }
    });
    const ids = Array.from({ length: count }, () => randomUUID());
    const logs = ids.map((runId) => host.add(runId));
    const sinks = ids.map((runId) => collector(runId));
    for (const sink of sinks) poller.register(sink.run);
    for (let round = 0; round < 5; round += 1) {
      logs.forEach((log, index) => log.append({ run: index, round }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const log of logs) log.end();
    await until(() => sinks.every((sink) => sink.done));
    sinks.forEach((sink, index) => {
      const expected = Array.from({ length: 5 }, (_, round) => `${JSON.stringify({ run: index, round })}\n`).join('');
      expect(sink.text()).toBe(expected);
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(poller.size).toBe(0);
  });

  it('drops data already delivered by an overlapping poll', async () => {
    const r = randomUUID();
    const other = randomUUID();
    const sink = collector(r);
    const second = collector(other);
    const whole = Buffer.from('{"a":1}\n{"b":2}\n');
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const seen: Array<Array<{ runId: string; cursor: number }>> = [];
    const poller = new RemoteAgentPoller(async (args) => {
      const request = args[0] as { runs: Array<{ runId: string; cursor: number }> };
      seen.push(request.runs);
      const call = seen.length;
      if (call === 1) {
        // 第一个 poll 在途时第二个任务登记，第二个 poll 带着同样的游标出发。
        await firstHeld;
        return { runs: [{ runId: r, cursor: 8, data: whole.subarray(0, 8).toString('base64') }] };
      }
      if (call === 2) {
        releaseFirst();
        await new Promise((resolve) => setTimeout(resolve, 20));
        // 与第一个 poll 重叠：同一段再给一次，后面多了一段。
        return { runs: [{ runId: r, cursor: 16, data: whole.toString('base64') }, { runId: other, cursor: 0, done: true }] };
      }
      return { runs: [{ runId: r, from: 16, cursor: 16, done: true }] };
    });
    poller.register(sink.run);
    poller.register(second.run);
    await until(() => sink.done && second.done);
    expect(seen[1].find((item) => item.runId === r)?.cursor).toBe(0);
    expect(sink.text()).toBe('{"a":1}\n{"b":2}\n');
  });

  it('rejects streams whose data does not match the cursor or leaves a gap', async () => {
    const a = randomUUID();
    const mismatch = collector(a);
    new RemoteAgentPoller(async () => ({ runs: [{ runId: a, cursor: 10, data: Buffer.from('xy').toString('base64') }] }))
      .register(mismatch.run);
    await until(() => !!mismatch.lost);
    expect(mismatch.lost!.error.code).toBe('REMOTE_AGENT_INVALID');

    const b = randomUUID();
    const gap = collector(b);
    new RemoteAgentPoller(async () => ({ runs: [{ runId: b, from: 4, cursor: 6, data: Buffer.from('xy').toString('base64') }] }))
      .register(gap.run);
    await until(() => !!gap.lost);
    expect(gap.lost!.error.code).toBe('REMOTE_AGENT_INVALID');

    const garbage = collector(randomUUID());
    new RemoteAgentPoller(async () => ({ runs: 'nope' })).register(garbage.run);
    await until(() => !!garbage.lost);
    expect(garbage.lost!.error.code).toBe('REMOTE_AGENT_INVALID');
  });
  it('re-reads from the same cursor after a link reset and reports runs the other computer no longer has', async () => {
    const host = fakeHost();
    const keptId = randomUUID();
    const log = host.add(keptId);
    const kept = collector(keptId);
    const gone = collector(randomUUID());
    const poller = new RemoteAgentPoller((args) => host.invoke(args));
    log.append({ n: 1 });
    host.failNext(Object.assign(new Error('peer reset'), { code: 'PEER_RESET' }));
    poller.register(kept.run);
    poller.register(gone.run);
    await until(() => !!gone.lost);
    expect(gone.lost!.reason).toBe('missing');
    log.append({ n: 2 });
    log.end();
    await until(() => kept.done, 5_000);
    expect(kept.text()).toBe('{"n":1}\n{"n":2}\n');
  });

  it('ends every run when the other computer refuses the poll, and gives up after it stays unreachable', async () => {
    const refused = collector(randomUUID());
    new RemoteAgentPoller(async () => {
      throw Object.assign(new Error('[CHANNEL_NOT_ALLOWED] not allowed'), { code: 'CHANNEL_NOT_ALLOWED' });
    }).register(refused.run);
    await until(() => !!refused.lost);
    expect(refused.lost!.error.code).toBe('CHANNEL_NOT_ALLOWED');

    vi.useFakeTimers();
    let t = 0;
    const offline = collector(randomUUID());
    let attempts = 0;
    const poller = new RemoteAgentPoller(async () => {
      attempts += 1;
      throw Object.assign(new Error('offline'), { code: 'DEVICE_OFFLINE' });
    }, undefined, () => t);
    poller.register(offline.run);
    for (let step = 0; step < 40 && !offline.lost; step += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
      t += 5_000;
    }
    expect(offline.lost!.reason).toBe('unreachable');
    expect(attempts).toBeGreaterThan(5);
  });

  it('slows down when the other computer keeps answering immediately with nothing new', async () => {
    vi.useFakeTimers();
    let polls = 0;
    const sink = collector(randomUUID());
    new RemoteAgentPoller(async () => {
      polls += 1;
      return { runs: [] };
    }).register(sink.run);
    await vi.advanceTimersByTimeAsync(0);
    const burst = polls;
    expect(burst).toBeLessThanOrEqual(4);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(polls).toBeLessThanOrEqual(burst + 4);
  });
});

describe('link errors', () => {
  it('names an outdated other computer and keeps link codes for retry decisions', async () => {
    const { remoteAgentInvoker } = await import('../controller/runClient');
    const { isRetryableLinkError } = await import('../controller/poller');
    const old = remoteAgentInvoker('d', async () => ({ ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: "channel 'x' not allowed remotely" } }));
    await expect(old([{ op: 'caps' }])).rejects.toMatchObject({ code: 'REMOTE_AGENT_PEER_TOO_OLD', message: expect.stringMatching(/^\[REMOTE_AGENT_PEER_TOO_OLD\]/) });
    const offline = remoteAgentInvoker('d', async () => {
      throw Object.assign(new Error('[DEVICE_LINK_NOT_CONNECTED] not connected'), { code: 'NOT_CONNECTED' });
    });
    const error = await offline([{ op: 'caps' }]).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/^\[REMOTE_AGENT_UNAVAILABLE\] \[DEVICE_LINK_NOT_CONNECTED\]/);
    expect(isRetryableLinkError(error)).toBe(true);
    const host = remoteAgentInvoker('d', async () => ({ ok: false, error: { code: 'IPC_ERROR', message: '[REMOTE_AGENT_BUSY] too many tasks' } }));
    const busy = await host([{ op: 'caps' }]).catch((e: unknown) => e);
    expect((busy as Error).message).toBe('[REMOTE_AGENT_BUSY] too many tasks');
    expect(isRetryableLinkError(busy)).toBe(false);
  });
});
