import { describe, expect, it, vi } from "vitest";
import { RoutineEngine, type RoutineState, type RoutineEngineDeps } from "../routine-engine.js";
import { parseRoutineInput, type RoutineInput } from "../routines.js";

const input: RoutineInput = {
  name: "PR review",
  prompt: "Check whether the new PR can merge",
  enabled: true,
  triggers: [
    {
      id: "github",
      kind: "event",
      sourceId: "github",
      eventType: "pr",
      filters: [{ field: "repo", operator: "equals", value: "team/app" }],
    },
    { id: "fallback", kind: "interval", intervalMs: 3600_000 },
  ],
};
const event = (id = "delivery-1") => ({
  id,
  type: "pr",
  occurredAt: 1,
  data: { repo: "team/app" },
});

async function fixture(
  execute: RoutineEngineDeps["execute"] = vi.fn(async () => ({})),
  saved: RoutineState | null = null,
  persist: (state: RoutineState) => Promise<void> = async () => {},
) {
  let snapshot = saved;
  let now = 1000;
  let id = 0;
  const onError = vi.fn();
  const changed = vi.fn();
  const engine = new RoutineEngine({
    load: async () => structuredClone(snapshot),
    save: async (state) => {
      await persist(state);
      snapshot = structuredClone(state);
    },
    execute,
    id: () => `id-${++id}`,
    now: () => now,
    changed,
    onError,
  });
  await engine.start();
  engine.registerSource({
    id: "github",
    name: "GitHub",
    status: "listening",
    events: [{ type: "pr", name: "PR", fields: ["repo"] }],
  });
  return {
    engine,
    execute,
    onError,
    changed,
    snapshot: () => snapshot,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("Routine event admission and execution", () => {
  it.each([
    { id: 'timer', kind: 'interval' as const, intervalMs: 60_000 },
    { id: 'timer', kind: 'cron' as const, expression: '* * * * *', timezone: 'UTC' },
  ])('does not write or broadcast disabled $kind timers and resumes from re-enable time', async (trigger) => {
    const persist = vi.fn(async () => {});
    const execute = vi.fn(async () => ({}));
    const f = await fixture(execute, null, persist);
    const enabledInput = { ...input, triggers: [trigger] };
    try {
      const routine = await f.engine.put('bot', enabledInput);
      await f.engine.put('bot', { ...enabledInput, enabled: false }, routine.id);
      // Creating an already-disabled rule must also remain idle.
      const disabled = await f.engine.put('bot', { ...enabledInput, enabled: false });
      expect(f.snapshot()?.next).toEqual({});
      persist.mockClear();
      f.changed.mockClear();
      for (let minute = 0; minute < 3; minute++) {
        f.advance(60_000);
        await f.engine.tick();
      }
      expect(persist).not.toHaveBeenCalled();
      expect(f.changed).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();

      await f.engine.put('bot', enabledInput, routine.id);
      persist.mockClear();
      f.changed.mockClear();
      await f.engine.tick();
      expect(persist).not.toHaveBeenCalled();
      expect(f.changed).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      f.advance(60_000);
      await f.engine.tick();
      await vi.waitFor(() => expect(f.engine.history(routine.id)[0]?.status).toBe('success'));
      expect(execute).toHaveBeenCalledOnce();
      expect(f.engine.history(disabled.id)).toEqual([]);
      expect(f.snapshot()?.next[`${disabled.id}:timer`]).toBeUndefined();
    } finally {
      await f.engine.stop();
    }
  });

  it('cleans legacy disabled timer cursors on restart without shifting enabled timers or history', async () => {
    const first = await fixture();
    const disabled = await first.engine.put('bot', { ...input, enabled: false });
    const enabled = await first.engine.put('bot', input);
    await first.engine.runNow('bot', disabled.id);
    await vi.waitFor(() => expect(first.engine.history(disabled.id)[0]?.status).toBe('success'));
    await first.engine.stop();
    const saved = structuredClone(first.snapshot()!);
    saved.next[`${disabled.id}:fallback`] = 1;
    const enabledNext = saved.next[`${enabled.id}:fallback`];
    const history = structuredClone(saved.runs);
    const persist = vi.fn(async () => {});
    const execute = vi.fn(async () => ({}));
    const restored = await fixture(execute, saved, persist);
    try {
      expect(restored.snapshot()?.next).toEqual({ [`${enabled.id}:fallback`]: enabledNext });
      expect(restored.snapshot()?.runs).toEqual(history);
      persist.mockClear();
      restored.changed.mockClear();
      for (let minute = 0; minute < 3; minute++) {
        restored.advance(60_000);
        await restored.engine.tick();
      }
      expect(persist).not.toHaveBeenCalled();
      expect(restored.changed).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await restored.engine.stop();
    }
  });

  it('still dispatches an explicit manual run of a disabled routine', async () => {
    const execute = vi.fn<RoutineEngineDeps['execute']>(async (_routine, _run, _signal, canDispatch) => {
      expect(canDispatch()).toBe(true);
      return {};
    });
    const f = await fixture(execute);
    try {
      const routine = await f.engine.put('bot', { ...input, enabled: false });
      await f.engine.runNow('bot', routine.id);
      await vi.waitFor(() => expect(f.engine.history(routine.id)[0].status).toBe('success'));
      expect(execute).toHaveBeenCalledOnce();
      expect(f.engine.list('bot')[0].enabled).toBe(false);
      expect(f.snapshot()?.next).toEqual({});
    } finally {
      await f.engine.stop();
    }
  });

  it.each(['name', 'prompt', 'triggers'] as const)('rejects the old revision after an enabled routine changes %s during host queue wait', async (field) => {
    let accept!: () => void;
    let canDispatch!: () => boolean;
    const dispatched: string[] = [];
    const execute: RoutineEngineDeps['execute'] = async (routine, _run, _signal, guard) => {
      canDispatch = guard;
      await new Promise<void>((resolve) => { accept = resolve; });
      if (!guard()) return { deferred: true };
      dispatched.push(routine.prompt);
      return {};
    };
    const f = await fixture(execute);
    try {
      const routine = await f.engine.put('bot', input);
      await f.engine.runNow('bot', routine.id);
      await vi.waitFor(() => expect(canDispatch).toBeTypeOf('function'));
      expect(canDispatch()).toBe(true);
      const edited = { ...input, [field]: field === 'triggers' ? [input.triggers[1]] : 'Edited' };
      await f.engine.put('bot', edited, routine.id);
      expect(canDispatch()).toBe(false);
      accept();
      await vi.waitFor(() => expect(f.engine.history(routine.id)[0].status).toBe('cancelled'));
      expect(dispatched).toEqual([]);
      await f.engine.runNow('bot', routine.id);
      await vi.waitFor(() => expect(canDispatch()).toBe(true));
      accept();
      await vi.waitFor(() => expect(f.engine.history(routine.id)[0].status).toBe('success'));
      expect(dispatched).toEqual([edited.prompt]);
    } finally {
      accept?.();
      await f.engine.stop();
    }
  });

  it("filters scope before execution and deduplicates a redelivered event", async () => {
    const { engine, execute } = await fixture();
    const routine = await engine.put("bot", input);
    expect(
      await engine.publish("github", {
        ...event("wrong"),
        data: { repo: "elsewhere" },
      }),
    ).toEqual({ accepted: 0, duplicate: false });
    expect(execute).not.toHaveBeenCalled();
    expect(await engine.publish("github", event())).toEqual({
      accepted: 1,
      duplicate: false,
    });
    expect(await engine.publish("github", event())).toEqual({
      accepted: 0,
      duplicate: true,
    });
    await vi.waitFor(() =>
      expect(engine.history(routine.id)[0].status).toBe("success"),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    await engine.stop();
  });

  it("coalesces events and timer fallback while a run is active", async () => {
    let release!: () => void;
    const execute = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {};
    });
    const { engine, advance } = await fixture(execute);
    const routine = await engine.put("bot", input);
    await engine.publish("github", event());
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await engine.publish("github", event("delivery-2"));
    await engine.publish("github", event("delivery-3"));
    advance(3600_000);
    await engine.tick();
    const queued = engine
      .history(routine.id)
      .find((run) => run.status === "queued");
    expect(queued?.events).toHaveLength(2);
    expect(queued?.triggerIds).toEqual(["github", "fallback"]);
    release();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    release();
    await vi.waitFor(() =>
      expect(
        engine.history(routine.id).every((run) => run.status === "success"),
      ).toBe(true),
    );
    await engine.stop();
  });

  it("retains receipts across restart and does not replay an ambiguous interrupted run", async () => {
    const first = await fixture(vi.fn(async (_routine, _run, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return {};
    }));
    const routine = await first.engine.put("bot", input);
    await first.engine.publish("github", event());
    await vi.waitFor(() =>
      expect(first.engine.history(routine.id)[0].status).toBe("running"),
    );
    await vi.waitFor(() => expect(first.execute).toHaveBeenCalledOnce());
    await first.engine.stop();
    const second = await fixture(
      vi.fn(async () => ({})),
      first.snapshot(),
    );
    expect(second.engine.history(routine.id)[0].status).toBe("interrupted");
    expect(await second.engine.publish("github", event())).toEqual({
      accepted: 0,
      duplicate: true,
    });
    expect(second.execute).not.toHaveBeenCalled();
    await second.engine.stop();
  });

  it("rejects undeclared sources, self loops, and cross-Bot mutations", async () => {
    const { engine, execute } = await fixture();
    const routine = await engine.put("bot", input);
    await expect(engine.publish("other", event())).rejects.toThrow("source");
    expect(
      await engine.publish("github", {
        ...event(),
        originRoutineId: routine.id,
      }),
    ).toEqual({ accepted: 0, duplicate: false });
    await expect(engine.put("other-bot", input, routine.id)).rejects.toThrow(
      "not found",
    );
    await expect(engine.remove("other-bot", routine.id)).rejects.toThrow(
      "not found",
    );
    await engine.put("bot", { ...input, enabled: false }, routine.id);
    expect(await engine.publish("github", event("paused"))).toEqual({
      accepted: 0,
      duplicate: false,
    });
    expect(execute).not.toHaveBeenCalled();
    await engine.stop();
  });

  it("rejects invalid timing and duplicate trigger identities", () => {
    expect(() =>
      parseRoutineInput({
        ...input,
        triggers: [{ id: "bad", kind: "interval", intervalMs: 0 }],
      }),
    ).toThrow("Interval");
    expect(() =>
      parseRoutineInput({
        ...input,
        triggers: [input.triggers[0], input.triggers[0]],
      }),
    ).toThrow("unique");
    expect(() =>
      parseRoutineInput({
        ...input,
        triggers: [
          { id: "bad", kind: "cron", expression: "invalid", timezone: "UTC" },
        ],
      }),
    ).toThrow();
  });
});

it("retains the accepted batch when the canonical task defers and retries after backoff", async () => {
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ deferred: true })
    .mockResolvedValue({ resultText: "Reviewed" });
  const { engine, advance } = await fixture(execute);
  const routine = await engine.put("bot", input);
  await engine.publish("github", event());
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  await vi.waitFor(() =>
    expect(engine.history(routine.id)[0].status).toBe("queued"),
  );
  await engine.publish("github", event("second"));
  expect(execute).toHaveBeenCalledTimes(1);
  advance(30_000);
  await engine.tick();
  await vi.waitFor(() =>
    expect(engine.history(routine.id)[0].status).toBe("success"),
  );
  expect(engine.history(routine.id)[0].events).toHaveLength(2);
  expect(engine.history(routine.id)[0].resultText).toBe("Reviewed");
  await engine.stop();
});

it("does not acknowledge a failed durable write or a revoked publisher", async () => {
  let fail = false;
  const execute = vi.fn(async () => ({}));
  const engine = new RoutineEngine({
    load: async () => null,
    save: async () => {
      if (fail) throw new Error("disk full");
    },
    execute,
    id: () => "rule",
    now: () => 1,
    changed: () => {},
    onError: () => {},
  });
  await engine.start();
  engine.registerSource({
    id: "github",
    name: "GitHub",
    status: "listening",
    events: [{ type: "pr", name: "PR", fields: [] }],
  });
  await engine.put("bot", input);
  fail = true;
  await expect(engine.publish("github", event())).rejects.toThrow("disk full");
  expect(engine.history("rule")).toEqual([]);
  expect(execute).not.toHaveBeenCalled();
  fail = false;
  await expect(engine.publish("github", event(), () => false)).rejects.toThrow(
    "no longer active",
  );
  expect(await engine.publish("github", event())).toEqual({
    accepted: 1,
    duplicate: false,
  });
  await engine.stop();
});

it('locks a routine after its outcome cannot be saved, retries only persistence, and keeps other routines usable', async () => {
  let blockedId = '';
  let fail = true;
  const executedIds: string[] = [];
  const execute = vi.fn<RoutineEngineDeps['execute']>(async (_routine, run) => {
    executedIds.push(run.id);
    return { resultText: 'External action completed' };
  });
  const persist = vi.fn(async (state: RoutineState) => {
    if (fail && state.runs.some((run) => run.routineId === blockedId && run.status === 'success'))
      throw new Error('disk full');
  });
  const { engine, advance, snapshot, onError } = await fixture(execute, null, persist);
  const routine = await engine.put('bot', input);
  blockedId = routine.id;
  await engine.runNow('bot', routine.id);
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' })));
  expect(execute).toHaveBeenCalledTimes(1);
  const firstRunId = engine.history(routine.id)[0].id;
  await engine.runNow('bot', routine.id);
  await engine.publish('github', event());
  advance(3600_000);
  await engine.tick();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(engine.history(routine.id).find((run) => run.id === firstRunId)?.status).toBe('running');
  expect(snapshot()?.runs.find((run) => run.id === firstRunId)?.status).toBe('running');

  const other = await engine.put('other-bot', { ...input, enabled: false });
  await engine.runNow('other-bot', other.id);
  await vi.waitFor(() => expect(engine.history(other.id)[0].status).toBe('success'));
  expect(execute).toHaveBeenCalledTimes(2);

  fail = false;
  advance(30_000);
  await engine.tick();
  await vi.waitFor(() => expect(engine.history(routine.id).every((run) => run.status === 'success')).toBe(true));
  expect(execute).toHaveBeenCalledTimes(3);
  expect(executedIds.filter((id) => id === firstRunId)).toHaveLength(1);
  expect(engine.history(routine.id).find((run) => run.id === firstRunId)?.resultText).toBe('External action completed');
  await engine.stop();
});

it('restores an unsaved completion as interrupted after restart without executing it again', async () => {
  let fail = true;
  const execute = vi.fn(async () => ({}));
  const first = await fixture(execute, null, async (state) => {
    if (fail && state.runs.some((run) => run.status === 'success')) throw new Error('disk full');
  });
  const routine = await first.engine.put('bot', input);
  await first.engine.runNow('bot', routine.id);
  await vi.waitFor(() => expect(first.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' })));
  await first.engine.stop();
  fail = false;
  const second = await fixture(vi.fn(async () => ({})), first.snapshot());
  expect(second.engine.history(routine.id)[0].status).toBe('interrupted');
  expect(second.execute).not.toHaveBeenCalled();
  await second.engine.stop();
});

it('keeps a deferred batch after a failed save and waits for durable requeue before executing', async () => {
  let fail = false;
  const execute = vi.fn<RoutineEngineDeps['execute']>().mockImplementationOnce(async () => {
    fail = true;
    return { deferred: true };
  }).mockResolvedValue({ resultText: 'done' });
  const { engine, advance, onError } = await fixture(execute, null, async (state) => {
    if (fail && state.runs.some((run) => run.status === 'queued')) throw new Error('disk full');
  });
  const routine = await engine.put('bot', input);
  await engine.publish('github', event());
  await vi.waitFor(() => expect(onError).toHaveBeenCalled());
  advance(30_000);
  await engine.tick();
  expect(execute).toHaveBeenCalledTimes(1);
  fail = false;
  advance(30_000);
  await engine.tick();
  expect(engine.history(routine.id)[0].status).toBe('queued');
  expect(execute).toHaveBeenCalledTimes(1);
  advance(30_000);
  await engine.tick();
  await vi.waitFor(() => expect(engine.history(routine.id)[0].status).toBe('success'));
  expect(engine.history(routine.id)[0].events).toEqual([{ sourceId: 'github', event: event() }]);
  expect(execute).toHaveBeenCalledTimes(2);
  await engine.stop();
});


it('pauses all Bot triggers, aborts active work, and resumes only the originally enabled rules', async () => {
  const aborted = vi.fn();
  const execute = vi.fn<RoutineEngineDeps['execute']>()
    .mockImplementationOnce(async (_routine, _run, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
      return {};
    }).mockResolvedValue({});
  const f = await fixture(execute);
  const enabled = await f.engine.put('bot', input);
  const disabled = await f.engine.put('bot', { ...input, enabled: false });
  await f.engine.publish('github', event());
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  await f.engine.publish('github', event('queued'));
  await f.engine.setBotPaused('bot', true);
  expect(aborted).toHaveBeenCalledOnce();
  expect(f.engine.history(enabled.id).every((run) => run.status === 'cancelled')).toBe(true);
  const historyLength = f.engine.history(enabled.id).length;
  f.advance(86_400_000);
  await f.engine.tick();
  expect(await f.engine.publish('github', event('paused'))).toMatchObject({ accepted: 0 });
  await expect(f.engine.runNow('bot', enabled.id)).rejects.toThrow('paused');
  expect(f.engine.history(enabled.id)).toHaveLength(historyLength);
  expect(f.snapshot()?.next).toEqual({});
  expect(f.engine.list('bot').map((routine) => routine.enabled)).toEqual([true, false]);
  const saved = f.snapshot();
  await f.engine.stop();
  const restarted = await fixture(vi.fn(async () => ({})), saved);
  await expect(restarted.engine.runNow('bot', enabled.id)).rejects.toThrow('paused');
  await restarted.engine.setBotPaused('bot', false);
  await restarted.engine.tick();
  expect(restarted.execute).not.toHaveBeenCalled();
  restarted.advance(3_600_000);
  await restarted.engine.tick();
  await vi.waitFor(() => expect(restarted.execute).toHaveBeenCalledOnce());
  expect(restarted.engine.history(disabled.id)).toEqual([]);
  await restarted.engine.stop();
});

it('purges a deleted Bot and its event history while preserving other Bots', async () => {
  const f = await fixture();
  const removed = await f.engine.put('removed-bot', input);
  const retained = await f.engine.put('retained-bot', input);
  await f.engine.publish('github', event());
  await vi.waitFor(() => expect(f.engine.history(removed.id)[0].status).toBe('success'));
  await f.engine.removeBot('removed-bot');
  expect(f.engine.list('removed-bot')).toEqual([]);
  expect(f.engine.history(removed.id)).toEqual([]);
  expect(f.snapshot()?.runs.every((run) => run.routineId !== removed.id)).toBe(true);
  expect(Object.keys(f.snapshot()!.next).every((key) => !key.startsWith(removed.id))).toBe(true);
  expect(f.engine.list('retained-bot')).toHaveLength(1);
  expect(f.engine.history(retained.id)).toHaveLength(1);
  await f.engine.remove('retained-bot', retained.id);
  expect(f.engine.history(retained.id)).toEqual([]);
  await f.engine.stop();
});

it('blocks new dispatch even if persisting the Bot pause fails', async () => {
  let fail = false;
  const f = await fixture(vi.fn(async () => ({})), null, async () => {
    if (fail) throw new Error('disk full');
  });
  const routine = await f.engine.put('bot', input);
  fail = true;
  await expect(f.engine.setBotPaused('bot', true)).rejects.toThrow('disk full');
  fail = false;
  f.advance(3_600_000);
  await f.engine.tick();
  await expect(f.engine.runNow('bot', routine.id)).rejects.toThrow('paused');
  expect(f.execute).not.toHaveBeenCalled();
  await f.engine.stop();
});

it('blocks all admission and edits during cleanup without blocking another rule of the same Bot', async () => {
  const f = await fixture();
  const removed = await f.engine.put('bot', input);
  const retained = await f.engine.put('bot', { ...input, name: 'Retained', triggers: [input.triggers[1]] });
  let finishCleanup!: () => void;
  const cleanup = vi.fn(() => new Promise<void>((resolve) => { finishCleanup = resolve; }));
  const removal = f.engine.remove('bot', removed.id, cleanup);
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  await expect(f.engine.runNow('bot', removed.id)).rejects.toThrow('being removed');
  await expect(f.engine.put('bot', input, removed.id)).rejects.toThrow('being removed');
  await expect(f.engine.remove('bot', removed.id, cleanup)).rejects.toThrow('being removed');
  expect(await f.engine.publish('github', event('during-cleanup'))).toMatchObject({ accepted: 0 });
  f.advance(3600_000);
  await f.engine.tick();
  await vi.waitFor(() => expect(f.engine.history(retained.id)[0]?.status).toBe('success'));
  expect(f.engine.history(removed.id)).toEqual([]);
  finishCleanup();
  await removal;
  expect(f.engine.list('bot').map((routine) => routine.id)).toEqual([retained.id]);
  await f.engine.stop();
});

it('keeps deletion retryable across restart if the final routine purge cannot be persisted', async () => {
  let rejectPurge = false;
  const f = await fixture(undefined, null, async (state) => {
    if (rejectPurge && state.routines.length === 0) throw new Error('disk full');
  });
  const routine = await f.engine.put('bot', input);
  await f.engine.publish('github', event());
  await vi.waitFor(() => expect(f.engine.history(routine.id)[0].status).toBe('success'));
  const cleanup = vi.fn(async () => {});
  await expect(f.engine.remove('other-bot', routine.id, cleanup)).rejects.toThrow('not found');
  expect(cleanup).not.toHaveBeenCalled();
  rejectPurge = true;
  await expect(f.engine.remove('bot', routine.id, cleanup)).rejects.toThrow('disk full');
  expect(cleanup).toHaveBeenCalledOnce();
  expect(f.engine.list('bot')[0].enabled).toBe(false);
  expect(f.engine.history(routine.id)).toHaveLength(1);
  await f.engine.stop();
  const restarted = await fixture(undefined, f.snapshot());
  restarted.advance(7200_000);
  await restarted.engine.tick();
  expect(await restarted.engine.publish('github', event('after-restart'))).toMatchObject({ accepted: 0 });
  expect(restarted.execute).not.toHaveBeenCalled();
  await restarted.engine.remove('bot', routine.id, cleanup);
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(restarted.snapshot()?.routines).toEqual([]);
  expect(restarted.snapshot()?.runs).toEqual([]);
  await restarted.engine.stop();
});

it('waits for every active execution to finish cancelling before stop resolves', async () => {
  const release: Array<() => void> = [];
  const aborted = vi.fn();
  const execute = vi.fn<RoutineEngineDeps['execute']>(async (_routine, _run, signal) => {
    signal.addEventListener('abort', aborted, { once: true });
    await new Promise<void>((resolve) => release.push(resolve));
    return {};
  });
  const f = await fixture(execute);
  const a = await f.engine.put('bot-a', input);
  const b = await f.engine.put('bot-b', input);
  await f.engine.runNow('bot-a', a.id);
  await f.engine.runNow('bot-b', b.id);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  await f.engine.runNow('bot-a', a.id);
  let stopped = false;
  const stop = f.engine.stop().then(() => { stopped = true; });
  expect(aborted).toHaveBeenCalledTimes(2);
  await Promise.resolve();
  expect(stopped).toBe(false);
  release[0]();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(stopped).toBe(false);
  release[1]();
  await stop;
  expect(stopped).toBe(true);
  expect(execute).toHaveBeenCalledTimes(2);
});

it('does not start execution if stop arrives while its running claim is being saved', async () => {
  let release!: () => void;
  const f = await fixture(undefined, null, async (state) => {
    if (state.runs.some((run) => run.status === 'running')) {
      await new Promise<void>((resolve) => { release = resolve; });
    }
  });
  const routine = await f.engine.put('bot', input);
  await f.engine.runNow('bot', routine.id);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  let stopped = false;
  const stop = f.engine.stop().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await stop;
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.snapshot()?.runs[0].status).toBe('running');
});

it('rate-limits unmatched events before writing, without resetting the limit on source status updates', async () => {
  const persist = vi.fn(async () => {});
  const f = await fixture(undefined, null, persist);
  for (let i = 0; i < 60; i++) await f.engine.publish('github', event(`unmatched-${i}`));
  const writes = persist.mock.calls.length;
  f.engine.registerSource({ id: 'github', name: 'GitHub', status: 'listening', events: [{ type: 'pr', name: 'PR', fields: [] }] });
  await expect(f.engine.publish('github', event('overflow'))).rejects.toThrow('rate limit');
  expect(persist).toHaveBeenCalledTimes(writes);
  f.advance(60_000);
  expect(await f.engine.publish('github', event('unmatched-0'))).toMatchObject({ duplicate: true });
  expect(persist).toHaveBeenCalledTimes(writes);
  await f.engine.publish('github', event('overflow'));
  expect(persist).toHaveBeenCalledTimes(writes + 1);
  await f.engine.stop();
});

it('bounds concurrent plugin requests before they enter the slow persistent write queue', async () => {
  let release!: () => void;
  let block = false;
  const f = await fixture(undefined, null, async () => {
    if (block) await new Promise<void>((resolve) => { release = resolve; });
  });
  block = true;
  const pending = Array.from({ length: 8 }, (_, i) => f.engine.publish('github', event(`pending-${i}`)));
  await expect(f.engine.publish('github', event('overflow'))).rejects.toThrow('busy');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  block = false;
  release();
  await Promise.all(pending);
  expect(await f.engine.publish('github', event('overflow'))).toMatchObject({ duplicate: false });
  await f.engine.stop();
});

it('keeps committed deduplication across restart and expires it after the bounded window', async () => {
  const f = await fixture();
  await f.engine.publish('github', event('receipt'));
  await f.engine.stop();
  const restored = await fixture(undefined, f.snapshot());
  expect(await restored.engine.publish('github', event('receipt'))).toMatchObject({ duplicate: true });
  restored.advance(24 * 60 * 60_000);
  expect(await restored.engine.publish('github', event('receipt'))).toMatchObject({ duplicate: false });
  expect(Object.keys(restored.snapshot()!.receipts)).toHaveLength(1);
  await restored.engine.stop();
});
