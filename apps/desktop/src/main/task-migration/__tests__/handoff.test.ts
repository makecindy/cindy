import { describe, expect, it } from 'vitest';
import { advanceHandoff, canCancelHandoff, type MigrationHandoff } from '../handoff';

function fixture(stage: MigrationHandoff['stage'] = 'preparing') {
  let durable: MigrationHandoff = {
    id: 'migration',
    sessionId: 'fork',
    sourceDeviceId: 'A',
    targetDeviceId: 'B',
    targetSessionId: 'child',
    targetProject: null,
    workingDir: '/shared',
    stage,
  };
  const calls: string[] = [];
  const deps = {
    save: async (r: MigrationHandoff) => {
      durable = structuredClone(r);
      calls.push(r.stage);
    },
    prepare: async () => {
      calls.push('snapshot');
    },
    import: async () => {
      calls.push('import');
    },
    cleanup: async () => {
      expect(durable.stage).toBe('transferring');
      calls.push('cleanup');
    },
    assertCurrent: () => {},
  };
  return { record: structuredClone(durable), deps, calls, durable: () => durable };
}

describe('task copy progress', () => {
  it('snapshots, imports and cleans up before recording completion', async () => {
    const f = fixture();
    await advanceHandoff(f.record, f.deps);
    expect(f.calls).toEqual(['snapshot', 'transferring', 'import', 'cleanup', 'complete']);
    expect(f.durable().workingDir).toBe('/shared');
  });
  it('keeps retryable progress after the target reply is lost', async () => {
    const f = fixture('transferring');
    f.deps.import = async () => {
      throw new Error('lost acknowledgement');
    };
    await expect(advanceHandoff(f.record, f.deps)).rejects.toThrow('lost acknowledgement');
    expect(f.durable().stage).toBe('transferring');
    expect(canCancelHandoff(f.record)).toBe(true);
  });
  it('replays the idempotent import when cleanup was interrupted', async () => {
    const f = fixture('transferring');
    f.deps.cleanup = async () => {
      throw new Error('reply lost');
    };
    await expect(advanceHandoff(f.record, f.deps)).rejects.toThrow();
    const restart = fixture(f.durable().stage);
    await advanceHandoff(restart.record, restart.deps);
    expect(restart.calls).toEqual(['import', 'cleanup', 'complete']);
  });
  it('keeps progress retryable if recording completion fails', async () => {
    const f = fixture('transferring');
    f.deps.save = async () => {
      throw new Error('disk full');
    };
    await expect(advanceHandoff(f.record, f.deps)).rejects.toThrow('disk full');
    expect(f.calls).toEqual(['import', 'cleanup']);
    expect(f.record.stage).toBe('transferring');
  });
  it('allows abandoning either unfinished source stage without rolling back the target', () => {
    expect(canCancelHandoff(fixture().record)).toBe(true);
    expect(canCancelHandoff(fixture('transferring').record)).toBe(true);
    for (const stage of ['complete', 'cancelled'] as const)
      expect(canCancelHandoff(fixture(stage).record)).toBe(false);
  });
});
