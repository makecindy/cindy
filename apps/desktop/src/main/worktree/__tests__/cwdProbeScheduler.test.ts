import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createCwdProbeScheduler } from '../cwdProbeScheduler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('cwd probe scheduling', () => {
  it('shares normalized paths both in flight and in the queue, with at most four active probes', async () => {
    const gates = Array.from({ length: 69 }, () => deferred<number>());
    let active = 0;
    let peak = 0;
    const probe = vi.fn(async (cwd: string) => {
      active++;
      peak = Math.max(peak, active);
      try {
        return await gates[Number(path.basename(cwd))].promise;
      } finally {
        active--;
      }
    });
    const detect = createCwdProbeScheduler(probe);
    const pending = gates.map((_, i) => detect(`/tmp/wt/${i}`));
    expect(detect('/tmp/wt/0/../0')).toBe(pending[0]);
    expect(detect('/tmp/wt/68/')).toBe(pending[68]);
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(4);
    for (let i = 0; i < gates.length; i++) gates[i].resolve(i);
    expect(await Promise.all(pending)).toEqual(gates.map((_, i) => i));
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(probe).toHaveBeenCalledTimes(69);
  });

  it('releases failed probes and does not cache completed or rejected results', async () => {
    const gates = Array.from({ length: 4 }, () => deferred<string>());
    const probe = vi.fn((cwd: string) => {
      const i = Number(path.basename(cwd));
      return i < 4 ? gates[i].promise : Promise.resolve('queued');
    });
    const detect = createCwdProbeScheduler(probe);
    const pending = gates.map((_, i) => detect(`/tmp/wt/${i}`));
    const failed = expect(pending[0]).rejects.toThrow('failed');
    const queued = detect('/tmp/wt/4');
    gates[0].reject(new Error('failed'));
    await failed;
    expect(await queued).toBe('queued');
    for (let i = 1; i < gates.length; i++) gates[i].resolve('done');
    await Promise.all(pending.slice(1));

    probe.mockResolvedValue('new branch');
    expect(await detect('/tmp/wt/0')).toBe('new branch');
    expect(await detect('/tmp/wt/4')).toBe('new branch');
    expect(probe).toHaveBeenCalledTimes(7);
  });

  it('also releases a slot when the probe throws synchronously', async () => {
    const probe = vi.fn<(_cwd: string) => Promise<string>>()
      .mockImplementationOnce(() => { throw new Error('spawn failed'); })
      .mockResolvedValue('ok');
    const detect = createCwdProbeScheduler(probe);
    await expect(detect('/tmp/wt/0')).rejects.toThrow('spawn failed');
    expect(await detect('/tmp/wt/0')).toBe('ok');
  });
});
