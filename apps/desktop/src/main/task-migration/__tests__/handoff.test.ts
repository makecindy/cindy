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
    activate: async () => {
      expect(durable.stage).toBe('moved');
      calls.push('activate');
    },
    assertCurrent: () => {},
  };
  return { record: structuredClone(durable), deps, calls, durable: () => durable };
}

describe('task migration handoff', () => {
  it('copies before importing and persists source retirement before target activation', async () => {
    const f = fixture();
    await advanceHandoff(f.record, f.deps);
    expect(f.calls).toEqual([
      'snapshot',
      'transferring',
      'import',
      'moved',
      'activate',
      'complete',
    ]);
    expect(f.durable().workingDir).toBe('/shared');
  });
  it('does not release source after target commits but its reply is lost', async () => {
    const f = fixture('transferring');
    f.deps.import = async () => {
      throw new Error('lost acknowledgement');
    };
    await expect(advanceHandoff(f.record, f.deps)).rejects.toThrow('lost acknowledgement');
    expect(f.durable().stage).toBe('transferring');
    expect(canCancelHandoff(f.record)).toBe(false);
  });
  it('restarts from moved after a lost activation reply without importing again', async () => {
    const f = fixture('transferring');
    f.deps.activate = async () => {
      throw new Error('reply lost');
    };
    await expect(advanceHandoff(f.record, f.deps)).rejects.toThrow();
    const restart = fixture(f.durable().stage);
    await advanceHandoff(restart.record, restart.deps);
    expect(restart.calls).toEqual(['activate', 'complete']);
  });
  it('never activates if persisting source retirement fails', async () => {
    const f = fixture('transferring');
    f.deps.save = async () => {
      throw new Error('disk full');
    };
    await expect(advanceHandoff(f.record, f.deps)).rejects.toThrow('disk full');
    expect(f.calls).toEqual(['import']);
    expect(f.record.stage).toBe('transferring');
  });
  it('allows cancellation only before any target import could have started', () => {
    expect(canCancelHandoff(fixture().record)).toBe(true);
    for (const stage of ['transferring', 'moved', 'complete', 'cancelled'] as const)
      expect(canCancelHandoff(fixture(stage).record)).toBe(false);
  });
});
