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
  const client = new WorkdirProbeHostClient({
    fork: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    log: { warn: vi.fn() },
    ...options,
  });
  return { client, children };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WorkdirProbeHostClient', () => {
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
