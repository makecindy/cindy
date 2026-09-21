import { describe, expect, it, vi } from 'vitest';
import { CindyMakeManager } from '../manager.js';
import type { MakeDoctorReport } from '../../../shared/cindyMakeDoctor.js';
import type { SourcePreparationResult } from '../sourcePreparation.js';

const report = (
  runId: string,
  status: MakeDoctorReport['status'] = 'running',
): MakeDoctorReport => ({
  runId,
  platform: 'darwin',
  arch: 'arm64',
  status,
  checks: [],
});

describe('CindyMakeManager', () => {
  it('hides a merge task identity after its account boundary changes', () => {
    const manager = new CindyMakeManager();
    let current = true;
    manager.setUpstreamMerge({ id: 'merge', ref: 'main', upstreamCommit: 'a'.repeat(40), status: 'conflict', sessionId: 'private-task', hasWorkspace: true }, () => current);
    expect(manager.getState().upstreamMerge?.sessionId).toBe('private-task');
    current = false;
    expect(manager.getState().upstreamMerge).toMatchObject({ sessionId: undefined, ownedByAnotherAccount: true, hasWorkspace: true });
  });
  it('blocks source preparation and reset while an unresolved merge workspace is retained', async () => {
    const manager = new CindyMakeManager();
    manager.setUpstreamMerge({ id: 'merge', ref: 'main', upstreamCommit: 'a'.repeat(40), status: 'failed', hasWorkspace: true });
    for (const clearOnly of [false, true]) {
      const run = vi.fn();
      await expect(manager.prepareSource({ root: '/managed', clearOnly, signal: new AbortController().signal,
        cancelled: vi.fn(), onProgress: vi.fn(), toStatus: vi.fn(), run,
      })).rejects.toMatchObject({ code: 'busy' });
      expect(run).not.toHaveBeenCalled();
    }
  });
  it.each([false, true])(
    'blocks unfinished cancellation and releases source work once cancelled (clearOnly=%s)',
    async (clearOnly) => {
      const manager = new CindyMakeManager();
      const merge = {
        id: 'merge',
        ref: 'main',
        upstreamCommit: 'a'.repeat(40),
        hasWorkspace: false,
      };
      manager.setUpstreamMerge({
        ...merge,
        status: 'failed',
        error: 'cancelFailed',
        cancellationRequested: true,
      });
      const result: SourcePreparationResult = {
        status: 'ready',
        path: '/managed/source',
        target: { channel: 'dev', version: '0.0.0-dev', ref: 'main', candidates: [] },
      };
      const run = vi.fn(async () => result);
      const input: Parameters<CindyMakeManager['prepareSource']>[0] = {
        root: '/managed',
        clearOnly,
        signal: new AbortController().signal,
        cancelled: () => ({ ...result, status: 'cancelled' }),
        onProgress: vi.fn(),
        toStatus: ({ status, path }) => ({ status, path }),
        run,
      };
      await expect(manager.prepareSource(input)).rejects.toMatchObject({ code: 'busy' });
      expect(run).not.toHaveBeenCalled();
      manager.setUpstreamMerge({ ...merge, status: 'cancelled' });
      await expect(manager.prepareSource(input)).resolves.toEqual(result);
      expect(run).toHaveBeenCalledOnce();
    },
  );
  it('deduplicates one operation, replays progress, and keeps state after completion', async () => {
    const manager = new CindyMakeManager();
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const first = manager.claim(
      { resource: 'environment', mode: 'check', forceManagedTools: false },
      'first',
      1,
      firstListener,
    );
    first.publish(report('first'));
    const second = manager.claim(
      { resource: 'environment', mode: 'check', forceManagedTools: false },
      'second',
      2,
      secondListener,
    );

    expect(second.attached).toBe(true);
    expect(secondListener).toHaveBeenLastCalledWith({ ...report('first'), runId: 'second' });
    first.complete(report('first', 'completed'));
    await expect(second.promise).resolves.toMatchObject({ runId: 'second', status: 'completed' });
    expect(manager.getState().environmentCheck).toMatchObject({
      active: false,
      report: { status: 'completed' },
    });
    expect(
      manager.snapshot({ resource: 'environment', mode: 'check', forceManagedTools: false }),
    ).toMatchObject({
      status: 'completed',
    });
  });

  it('continues after a listener unsubscribes and only explicit cancel aborts it', () => {
    const manager = new CindyMakeManager();
    const listener = vi.fn();
    const operation = manager.claim(
      { resource: 'source', mode: 'prepare', forceManagedTools: false },
      'source-run',
      1,
      listener,
    );
    operation.unsubscribe();
    operation.publish(report('source-run'));
    expect(listener).not.toHaveBeenCalled();
    expect(operation.controller.signal.aborted).toBe(false);
    expect(manager.cancel('source-run', 99)).toBe('cancelled');
    expect(operation.controller.signal.aborted).toBe(true);
  });

  it('does not attach operations with different preparation parameters', () => {
    const manager = new CindyMakeManager();
    const first = manager.claim(
      { resource: 'environment', mode: 'prepare', forceManagedTools: false },
      'system',
      1,
      vi.fn(),
    );
    const second = manager.claim(
      { resource: 'environment', mode: 'prepare', forceManagedTools: true },
      'managed',
      1,
      vi.fn(),
    );
    expect(first.attached).toBe(false);
    expect(second.attached).toBe(false);
  });

  it('shares the prepared context without broadcasting it', async () => {
    const manager = new CindyMakeManager();
    const key = { resource: 'environment', mode: 'prepare', forceManagedTools: false } as const;
    const first = manager.claim<{ selectedTool: string }>(key, 'first', 1, vi.fn());
    const attached = manager.claim<{ selectedTool: string }>(key, 'attached', 2, vi.fn());
    const context = { selectedTool: 'managed-node' };
    first.complete(report('first', 'completed'), context);
    await attached.promise;
    expect(first.context).toBe(context);
    expect(attached.context).toBe(context);
    expect(manager.getState().environmentPrepare).toEqual({
      active: false,
      report: report('first', 'completed'),
    });
  });

  it.each(['canonical', 'attached'])(
    'allows explicit preparation cancellation using the %s id after unsubscribe',
    async (target) => {
      const manager = new CindyMakeManager();
      const key = { resource: 'environment', mode: 'prepare', forceManagedTools: false } as const;
      const first = manager.claim(key, 'canonical', 1, vi.fn());
      const attached = manager.claim(key, 'attached', 2, vi.fn());
      const stateListener = vi.fn();
      const unsubscribeState = manager.subscribe(stateListener);
      first.unsubscribe();
      attached.unsubscribe();
      unsubscribeState();
      first.publish(report('canonical'));
      expect(first.controller.signal.aborted).toBe(false);
      expect(stateListener).toHaveBeenCalledTimes(1);
      expect(manager.cancel(target, target === 'canonical' ? 99 : 2)).toBe('cancelled');
      expect(attached.controller.signal.aborted).toBe(true);
      first.complete(report('canonical', 'cancelled'));
      await expect(attached.promise).resolves.toMatchObject({
        runId: 'attached',
        status: 'cancelled',
      });
      expect(manager.cancel(target, 99)).toBe('not-found');
    },
  );

  it('allows attached diagnostic participants to stop without admitting other windows', () => {
    const manager = new CindyMakeManager();
    const key = { resource: 'environment', mode: 'check', forceManagedTools: false } as const;
    const first = manager.claim(key, 'first', 1, vi.fn());
    manager.claim(key, 'attached', 2, vi.fn());
    expect(manager.cancel('first', 99)).toBe('forbidden');
    expect(manager.cancel('attached', 2)).toBe('cancelled');
    expect(first.controller.signal.aborted).toBe(true);
    first.complete(report('first', 'cancelled'));
  });

  it('keeps workflow cancellation private and separate from the completed environment', () => {
    const manager = new CindyMakeManager();
    const key = { resource: 'environment', mode: 'prepare', forceManagedTools: false } as const;
    const environment = manager.claim(key, 'first', 1, vi.fn());
    manager.claim(key, 'second', 2, vi.fn());
    environment.complete(report('first', 'completed'));
    const first = manager.startWorkflow('first', 1);
    const second = manager.startWorkflow('second', 2);
    expect(manager.cancel('first', 2)).toBe('forbidden');
    expect(manager.cancel('first', 1)).toBe('cancelled');
    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(false);
    expect(environment.controller.signal.aborted).toBe(false);
    expect(manager.getState().environmentPrepare).toEqual({
      active: false,
      report: report('first', 'completed'),
    });
    expect(() => manager.claim(key, 'second', 2, vi.fn())).toThrow('already running');
    expect(() => manager.startWorkflow('second', 2)).toThrow('already running');
    first.complete();
    const retried = manager.startWorkflow('first', 1);
    first.complete();
    expect(manager.cancel('first', 1)).toBe('cancelled');
    expect(retried.controller.signal.aborted).toBe(true);
    retried.complete();
    second.complete();
    expect(manager.cancel('second', 2)).toBe('not-found');
  });

  it('rejects duplicate run ids across different resources', () => {
    const manager = new CindyMakeManager();
    const first = manager.claim(
      { resource: 'environment', mode: 'prepare', forceManagedTools: false },
      'same-id',
      1,
      vi.fn(),
    );
    expect(() =>
      manager.claim(
        { resource: 'source', mode: 'prepare', forceManagedTools: false },
        'same-id',
        2,
        vi.fn(),
      ),
    ).toThrow('already running');
    first.complete(report('same-id', 'completed'));
  });
});
