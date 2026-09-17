import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WorkdirProbeHostClient,
  type WorkdirProbeChildLike,
} from '../WorkdirProbeHostClient.js';
import type { WorkdirProbeRequest, WorkdirProbeResponse } from '../protocol.js';

class FakeChild extends EventEmitter implements WorkdirProbeChildLike {
  readonly posted: WorkdirProbeRequest[] = [];
  killResult = true;
  kill = vi.fn(() => this.killResult);

  postMessage(message: unknown): void {
    this.posted.push(message as WorkdirProbeRequest);
  }

  respond(isDirectory = true): void {
    const request = this.posted.at(-1)!;
    const response: WorkdirProbeResponse = {
      kind: 'result',
      id: request.id,
      result: { ok: true, isDirectory },
    };
    this.emit('message', response);
  }
}

function createHarness(options: { maxWorkers?: number; maxQueued?: number } = {}) {
  const children: FakeChild[] = [];
  const log = { info: vi.fn(), warn: vi.fn() };
  const client = new WorkdirProbeHostClient({
    fork: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    log,
    ...options,
  });
  return { client, children, log };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WorkdirProbeHostClient', () => {
  it('identifies queue timeout before any request reaches the worker', async () => {
    vi.useFakeTimers();
    const { client, children, log } = createHarness({ maxWorkers: 1 });
    const blocked = client.probe('/private/blocker', '/private/blocker', 1000).catch((error) => error);
    const queued = client.probe('/private/queued', '/private/queued', 50).catch((error) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await queued).toMatchObject({ code: 'WORKDIR_PROBE_TIMEOUT' });
    expect(children[0].posted).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith('workdir probe failed', expect.objectContaining({
      reason: 'queue-timeout', phase: 'before-dispatch', requestId: 2,
      timeoutMs: 50, elapsedMs: 50, queueWaitMs: 50, responseWaitMs: null,
      activeWorkers: 1, terminatingWorkers: 0,
    }));
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private');
    client.dispose();
    await blocked;
  });

  it('reports queue and response wait separately and confirms worker exit', async () => {
    vi.useFakeTimers();
    const { client, children, log } = createHarness({ maxWorkers: 1 });
    const blocked = client.probe('/private/blocker', '/private/blocker', 100).catch((error) => error);
    const queued = client.probe('/private/queued', '/private/queued', 150).catch((error) => error);
    await vi.advanceTimersByTimeAsync(100);
    children[0].emit('exit', 9);
    await vi.advanceTimersByTimeAsync(50);
    expect(await queued).toMatchObject({ code: 'WORKDIR_PROBE_TIMEOUT' });
    expect(log.warn).toHaveBeenCalledWith('workdir probe failed', expect.objectContaining({
      reason: 'response-timeout', phase: 'waiting-result', requestId: 2, workerId: 2,
      elapsedMs: 150, queueWaitMs: 100, responseWaitMs: 50,
    }));
    expect(log.info).toHaveBeenCalledWith('workdir probe worker exited', expect.objectContaining({
      workerId: 1, requestId: 1, exitCode: 9, terminationRequested: true,
    }));
    client.dispose();
    await blocked;
  });

  it.each(['host-exited', 'host-error', 'dispatch-failed'] as const)('reports a process failure without filesystem or error contents: %s', async (reason) => {
    const { client, children, log } = createHarness({ maxWorkers: 1 });
    const first = client.probe('/private/first', '/private/first', 1000);
    children[0].respond();
    await first;
    if (reason === 'dispatch-failed') vi.spyOn(children[0], 'postMessage').mockImplementation(() => { throw new Error('private credentials'); });
    const failure = client.probe('/private/second', '/private/second', 1000).catch((error) => error);
    if (reason === 'host-exited') children[0].emit('exit', 1);
    if (reason === 'host-error') children[0].emit('error', 'private-type', 'private-location', 'private-report');
    expect(await failure).toMatchObject({ code: 'WORKDIR_PROBE_UNAVAILABLE' });
    expect(log.warn).toHaveBeenCalledWith('workdir probe failed', expect.objectContaining({ reason, requestId: 2 }));
    expect(JSON.stringify([...log.warn.mock.calls, ...log.info.mock.calls])).not.toContain('private');
    client.dispose();
  });

  it('reports a spawn failure without logging its raw exception', async () => {
    const log = { warn: vi.fn() };
    const client = new WorkdirProbeHostClient({
      fork: () => { throw new Error('private executable path'); }, log,
    });
    await expect(client.probe('/private/dir', '/private/dir', 100)).rejects.toMatchObject({ code: 'WORKDIR_PROBE_UNAVAILABLE' });
    expect(log.warn).toHaveBeenCalledWith('workdir probe failed', expect.objectContaining({ reason: 'host-start-failed', phase: 'before-dispatch' }));
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private');
    client.dispose();
  });

  it.each(['ENOENT', 'EACCES', 'EIO', 'PRIVATE_CREDENTIAL'])('distinguishes a returned filesystem error from probe failures: %s', async (code) => {
    const { client, children, log } = createHarness();
    const result = client.probe('/private/dir', '/private/dir', 1000);
    children[0].emit('message', { kind: 'result', id: 1, result: { ok: false, code } });
    await expect(result).resolves.toEqual({ ok: false, code });
    expect(log.warn).toHaveBeenCalledWith('workdir probe filesystem result', expect.objectContaining({
      reason: 'filesystem-error', code: code === 'PRIVATE_CREDENTIAL' ? 'UNKNOWN' : code, requestId: 1,
    }));
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('PRIVATE_CREDENTIAL');
    client.dispose();
  });

  it.each(['mkdir', 'realpath', 'similar'] as const)('isolates %s from stat and ignores its late timeout response', async (kind) => {
    vi.useFakeTimers();
    const { client, children } = createHarness({ maxWorkers: 1 });
    const operation = client.probe('/share/a', '/share/a', 50, kind);
    const failure = operation.catch((error) => error);
    const stat = client.probe('/share/a', '/share/a', 150);
    expect(children[0].posted[0].kind).toBe(kind);
    await vi.advanceTimersByTimeAsync(50);
    await expect(failure).resolves.toMatchObject({ code: 'WORKDIR_PROBE_TIMEOUT' });
    expect(children[0].kill).toHaveBeenCalledOnce();
    children[0].respond();
    expect(children).toHaveLength(1);
    children[0].emit('exit', 0);
    expect(children[1].posted[0].kind).toBe('probe');
    children[1].respond();
    await expect(stat).resolves.toEqual({ ok: true, isDirectory: true });
    client.dispose();
  });

  it('single-flights equivalent paths', async () => {
    const { client, children } = createHarness();

    const first = client.probe('/share/a', '/share/a', 1_000);
    const second = client.probe('/share/a/', '/share/a', 1_000);

    expect(children).toHaveLength(1);
    expect(children[0].posted).toHaveLength(1);
    children[0].respond();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, isDirectory: true },
      { ok: true, isDirectory: true },
    ]);
    client.dispose();
  });

  it('kills timed-out hosts, releases slots, and runs a queued healthy probe', async () => {
    vi.useFakeTimers();
    const { client, children } = createHarness({ maxWorkers: 2 });

    const first = client.probe('/share/a', '/share/a', 100);
    const second = client.probe('/share/b', '/share/b', 100);
    const healthy = client.probe('/local/healthy', '/local/healthy', 200);
    const failures = Promise.allSettled([first, second]);

    expect(children).toHaveLength(2);
    expect(children[0].posted[0].dir).toBe('/share/a');
    expect(children[1].posted[0].dir).toBe('/share/b');

    await vi.advanceTimersByTimeAsync(100);

    expect(children[0].kill).toHaveBeenCalledOnce();
    expect(children[1].kill).toHaveBeenCalledOnce();
    expect(children).toHaveLength(2);
    children[0].emit('exit', 0);
    children[1].emit('exit', 0);
    expect(children).toHaveLength(3);
    expect(children[2].posted[0].dir).toBe('/local/healthy');
    children[2].respond();

    await expect(healthy).resolves.toEqual({ ok: true, isDirectory: true });
    await expect(failures).resolves.toEqual([
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ]);
    client.dispose();
  });

  it('allows the same path to retry on a fresh host after timeout', async () => {
    vi.useFakeTimers();
    const { client, children } = createHarness({ maxWorkers: 1 });

    const first = client.probe('/share/a', '/share/a', 50);
    const firstFailure = first.catch((error) => error);
    await vi.advanceTimersByTimeAsync(50);
    await expect(firstFailure).resolves.toMatchObject({ code: 'WORKDIR_PROBE_TIMEOUT' });
    children[0].emit('exit', 0);

    const retry = client.probe('/share/a', '/share/a', 50);
    expect(children).toHaveLength(2);
    children[1].respond();
    await expect(retry).resolves.toEqual({ ok: true, isDirectory: true });
    client.dispose();
  });

  it('waits for a busy slot but bounds the queue', async () => {
    vi.useFakeTimers();
    const { client } = createHarness({ maxWorkers: 1, maxQueued: 1 });

    const active = client.probe('/share/a', '/share/a', 100);
    const queued = client.probe('/share/b', '/share/b', 100);
    const overflow = client.probe('/share/c', '/share/c', 100);
    const settled = Promise.allSettled([active, queued]);

    await expect(overflow).rejects.toMatchObject({ code: 'WORKDIR_PROBE_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(100);
    await expect(settled).resolves.toEqual([
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ]);
    client.dispose();
  });

  it('does not replace a timed-out host until exit is confirmed, even when kill returns false', async () => {
    vi.useFakeTimers();
    const { client, children } = createHarness({ maxWorkers: 1 });

    const first = client.probe('/share/a', '/share/a', 50);
    children[0].killResult = false;
    const firstFailure = first.catch((error) => error);
    await vi.advanceTimersByTimeAsync(50);
    await expect(firstFailure).resolves.toMatchObject({ code: 'WORKDIR_PROBE_TIMEOUT' });

    const second = client.probe('/local/healthy', '/local/healthy', 100);
    expect(children).toHaveLength(1);
    expect(children[0].kill).toHaveReturnedWith(false);

    children[0].emit('exit', 0);
    expect(children).toHaveLength(2);
    children[1].respond();
    await expect(second).resolves.toEqual({ ok: true, isDirectory: true });
    client.dispose();
  });

  it('shares one end-to-end deadline between queue wait and active probing', async () => {
    vi.useFakeTimers();
    const { client, children } = createHarness({ maxWorkers: 1 });

    const blocker = client.probe('/share/a', '/share/a', 100);
    const blockerFailure = blocker.catch((error) => error);
    const queued = client.probe('/share/b', '/share/b', 150);
    let queuedSettled = false;
    const queuedFailure = queued.catch((error) => {
      queuedSettled = true;
      return error;
    });

    await vi.advanceTimersByTimeAsync(100);
    await expect(blockerFailure).resolves.toMatchObject({ code: 'WORKDIR_PROBE_TIMEOUT' });
    children[0].emit('exit', 0);
    expect(children[1].posted[0].dir).toBe('/share/b');

    await vi.advanceTimersByTimeAsync(49);
    expect(queuedSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(queuedFailure).resolves.toMatchObject({ code: 'WORKDIR_PROBE_TIMEOUT' });
    client.dispose();
  });
});
