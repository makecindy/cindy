import { describe, expect, it, vi } from 'vitest';

import { createOrcaWorkerResumeScheduler } from '../orcaWorkerResumeScheduler';

describe('createOrcaWorkerResumeScheduler', () => {
  it('shares one in-flight resume per session and clears it when settled', async () => {
    let release!: (value: boolean) => void;
    const resume = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const scheduler = createOrcaWorkerResumeScheduler({
      resume,
      withSessionLock: (_sessionId, task) => task(),
    });

    const first = scheduler.request({ sessionId: 'worker-1' });
    const second = scheduler.request({ sessionId: 'worker-1' });

    expect(second).toBe(first);
    expect(scheduler.pendingCount()).toBe(1);
    expect(resume).toHaveBeenCalledTimes(1);

    release(true);
    await expect(first).resolves.toBe(true);
    expect(scheduler.pendingCount()).toBe(0);

    // A settled entry must not be reused: the next request starts a fresh resume.
    resume.mockResolvedValueOnce(false);
    await expect(scheduler.request({ sessionId: 'worker-1' })).resolves.toBe(false);
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('runs resume inside the injected per-session lock', async () => {
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockEntered = false;
    const resume = vi.fn(async () => true);
    const scheduler = createOrcaWorkerResumeScheduler({
      resume,
      withSessionLock: async (_sessionId, task) => {
        lockEntered = true;
        await lockGate;
        return task();
      },
    });

    const pending = scheduler.request({ sessionId: 'worker-1' });
    await Promise.resolve();

    expect(lockEntered).toBe(true);
    expect(resume).not.toHaveBeenCalled();

    releaseLock();
    await expect(pending).resolves.toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('resumes different sessions without coupling them', async () => {
    const releases = new Map<string, (value: boolean) => void>();
    const resume = vi.fn(
      (target: { sessionId: string }) =>
        new Promise<boolean>((resolve) => {
          releases.set(target.sessionId, resolve);
        }),
    );
    const scheduler = createOrcaWorkerResumeScheduler({
      resume,
      withSessionLock: (_sessionId, task) => task(),
    });

    const first = scheduler.request({ sessionId: 'worker-1' });
    const second = scheduler.request({ sessionId: 'worker-2' });

    expect(resume).toHaveBeenCalledTimes(2);
    expect(scheduler.pendingCount()).toBe(2);

    releases.get('worker-2')?.(true);
    await expect(second).resolves.toBe(true);
    expect(scheduler.pendingCount()).toBe(1);

    releases.get('worker-1')?.(false);
    await expect(first).resolves.toBe(false);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('reports background failures without rejecting and retries next time', async () => {
    const onError = vi.fn();
    const resume = vi
      .fn(async () => true)
      .mockRejectedValueOnce(new Error('boot failed'))
      .mockResolvedValueOnce(true);
    const scheduler = createOrcaWorkerResumeScheduler({
      resume,
      withSessionLock: (_sessionId, task) => task(),
    });

    expect(() => scheduler.requestInBackground({ sessionId: 'worker-1' }, onError)).not.toThrow();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(scheduler.pendingCount()).toBe(0);

    await expect(scheduler.request({ sessionId: 'worker-1' })).resolves.toBe(true);
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('aborts a cancelled resume before it starts booting', async () => {
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const resume = vi.fn(async (_target: unknown, isCancelled: () => boolean) => {
      return !isCancelled();
    });
    const scheduler = createOrcaWorkerResumeScheduler({
      resume,
      withSessionLock: async (_sessionId, task) => {
        await lockGate;
        return task();
      },
    });

    const pending = scheduler.request({ sessionId: 'worker-1' });
    await Promise.resolve();
    scheduler.cancel('worker-1');
    releaseLock();

    await expect(pending).resolves.toBe(false);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]?.[1]?.()).toBe(true);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('lets the resume implementation observe cancellation after bootstrap', async () => {
    let releaseBoot!: () => void;
    const bootGate = new Promise<void>((resolve) => {
      releaseBoot = resolve;
    });
    const resume = vi.fn(async (_target: unknown, isCancelled: () => boolean) => {
      await bootGate;
      return !isCancelled();
    });
    const scheduler = createOrcaWorkerResumeScheduler({
      resume,
      withSessionLock: (_sessionId, task) => task(),
    });

    const pending = scheduler.request({ sessionId: 'worker-1' });
    await Promise.resolve();
    scheduler.cancel('worker-1');
    releaseBoot();

    await expect(pending).resolves.toBe(false);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('keeps a cancelled in-flight entry deduplicated until it settles', async () => {
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const resume = vi.fn(async (_target: unknown, isCancelled: () => boolean) => !isCancelled());
    const scheduler = createOrcaWorkerResumeScheduler({
      resume,
      withSessionLock: async (_sessionId, task) => {
        await lockGate;
        return task();
      },
    });

    const first = scheduler.request({ sessionId: 'worker-1' });
    await Promise.resolve();
    scheduler.cancel('worker-1');
    const second = scheduler.request({ sessionId: 'worker-1' });
    expect(second).toBe(first);
    expect(resume).toHaveBeenCalledTimes(0);

    releaseLock();
    await expect(first).resolves.toBe(false);
    expect(scheduler.pendingCount()).toBe(0);

    // A settled cancelled entry must not poison the next request.
    await expect(scheduler.request({ sessionId: 'worker-1' })).resolves.toBe(true);
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('forwards the authority check guard into the resume implementation', async () => {
    const assertCurrent = vi.fn(async () => undefined);
    const resume = vi.fn(
      async (_target: unknown, _isCancelled: () => boolean, _assertCurrent?: () => Promise<void>) =>
        true,
    );
    const scheduler = createOrcaWorkerResumeScheduler({
      resume,
      withSessionLock: (_sessionId, task) => task(),
    });

    scheduler.requestInBackground({ sessionId: 'worker-1' }, () => undefined, { assertCurrent });

    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    expect(resume.mock.calls[0]?.[2]).toBe(assertCurrent);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('ignores cancel for sessions without an in-flight resume', () => {
    const scheduler = createOrcaWorkerResumeScheduler({
      resume: async () => true,
      withSessionLock: (_sessionId, task) => task(),
    });
    expect(() => scheduler.cancel('worker-1')).not.toThrow();
    expect(scheduler.pendingCount()).toBe(0);
  });
});
