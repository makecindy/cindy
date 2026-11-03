import { expect, it, vi } from 'vitest';
import { RoutineEngine, type RoutineEngineDeps, type RoutineState } from '../routine-engine.js';
import { nextRoutineTriggerAt } from '../routines.js';

it('keeps interval phase instead of restarting its clock during import', () => {
  expect(nextRoutineTriggerAt({ id: 'tick', kind: 'interval', intervalMs: 60000, anchorMs: 10000 }, 65000)).toBe(70000);
});
it('fires an imported one-shot only once, including after restoring its durable state', async () => {
  let now = 1000; let seq = 0; let state: RoutineState | null = null;
  const execute = vi.fn(async () => ({ resultText: 'reminder' }));
  const deps = { load: async () => structuredClone(state), save: async (value: RoutineState) => { state = structuredClone(value); }, execute, id: () => `id-${++seq}`, now: () => now, changed() {}, onError(error: unknown) { throw error; } };
  const engine = new RoutineEngine(deps); await engine.start();
  await engine.put('bot', { name: 'Reminder', prompt: 'Remember', enabled: true, triggers: [{ id: 'at', kind: 'once', at: 2000 }] });
  now = 2000; await engine.tick(); await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1)); await engine.stop();
  const restarted = new RoutineEngine(deps); await restarted.start(); now = 500000; await restarted.tick(); await restarted.stop();
  expect(execute).toHaveBeenCalledTimes(1);
});

it('commits the last successful run with disabling, cancels queued work and stays idle after restart', async () => {
  let now = 1000; let seq = 0; let state: RoutineState | null = null;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const execute = vi.fn(async () => { await done; return { resultText: 'last report', disableRoutine: true }; });
  const save = vi.fn(async (value: RoutineState) => { state = structuredClone(value); });
  const deps = { load: async () => structuredClone(state), save, execute, id: () => `id-${++seq}`, now: () => now, changed() {}, onError: vi.fn() };
  const engine = new RoutineEngine(deps); await engine.start();
  const routine = await engine.put('bot', { name: 'Limited', prompt: 'Report', enabled: true, triggers: [{ id: 'tick', kind: 'interval', intervalMs: 60000 }] });
  try {
    await engine.runNow('bot', routine.id);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await engine.runNow('bot', routine.id);
    expect(engine.history(routine.id).map(run => run.status)).toEqual(['queued', 'running']);
    finish();
    await vi.waitFor(() => expect(engine.list()[0]!.enabled).toBe(false));
    expect(engine.history(routine.id).map(run => run.status)).toEqual(['cancelled', 'success']);
    const committed = save.mock.calls.at(-1)![0];
    expect(committed.routines[0]!.revision).toBe(routine.revision + 1);
    expect(committed.next).toEqual({});
    expect(committed.runs[0]).toMatchObject({ resultText: 'last report', status: 'success' });
    expect(committed.runs[0]).not.toHaveProperty('disableRoutine');
  } finally { finish(); await engine.stop(); }
  const restarted = new RoutineEngine(deps); await restarted.start();
  try {
    const writes = save.mock.calls.length;
    const history = restarted.history(routine.id);
    for (let i = 0; i < 3; i++) { now += 60000; await restarted.tick(); }
    expect(execute).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledTimes(writes);
    expect(restarted.history(routine.id)).toEqual(history);
    expect(deps.onError).not.toHaveBeenCalled();
  } finally { await restarted.stop(); }
});

it.each([false, true])('retries terminal persistence without rerunning and respects a newer edit (%s)', async edited => {
  let now = 1000; let seq = 0; let fail = true;
  const execute = vi.fn(async () => ({ resultText: 'last report', disableRoutine: true }));
  const onError = vi.fn();
  const deps: RoutineEngineDeps = {
    load: async () => null,
    save: async state => {
      if (fail && state.runs.some(run => run.status === 'success')) throw new Error('fixture write failed');
    },
    execute, id: () => `id-${++seq}`, now: () => now, changed() {}, onError,
  };
  const engine = new RoutineEngine(deps); await engine.start();
  const routine = await engine.put('bot', { name: 'Limited', prompt: 'Report', enabled: true, triggers: [{ id: 'tick', kind: 'interval', intervalMs: 60000 }] });
  try {
    await engine.runNow('bot', routine.id);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(engine.list()[0]!.enabled).toBe(true);
    expect(engine.history(routine.id)[0]!.status).toBe('running');
    if (edited) await engine.put('bot', { ...routine, name: 'User edit' }, routine.id, routine.revision);
    fail = false; now += 30001; await engine.tick();
    expect(engine.history(routine.id)[0]!.status).toBe('success');
    expect(engine.list()[0]!.enabled).toBe(edited);
    expect(engine.list()[0]!.name).toBe(edited ? 'User edit' : 'Limited');
    expect(execute).toHaveBeenCalledOnce();
  } finally { await engine.stop(); }
});
