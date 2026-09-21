import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_INPUT_WAIT_MS, HumanDesktopInput, HUMAN_INPUT_QUIET_MS, withAgentDesktopInput } from '../inputOwnership';

const humans: HumanDesktopInput[] = [];
const human = () => {
  const input = new HumanDesktopInput();
  humans.push(input);
  return input;
};
const agent = () => withAgentDesktopInput(async () => 'done');
afterEach(() => {
  humans.splice(0).forEach((input) => input.release());
  vi.useRealTimers();
});

describe('remote input yields only during actual interaction', () => {
  it('retains ownership during shutdown even if a rejected key-up batch settles first', async () => {
    vi.useFakeTimers();
    const input = human();
    input.begin([{ kind: 'key', code: 'ShiftLeft', down: true }]).complete();
    const up = input.begin([{ kind: 'key', code: 'ShiftLeft', down: false }]);
    input.holdUntilExit();
    up.complete();
    vi.advanceTimersByTime(60_000);
    await expect(agent()).rejects.toThrow('input is active');
    input.release();
    await expect(agent()).resolves.toBe('done');
  });
  it('allows Agent input with an idle remote connection', async () => {
    human();
    await expect(agent()).resolves.toBe('done');
  });

  it.each(['button', 'key'] as const)(
    'holds a %s gesture past the quiet interval until native key-up completes',
    async (kind) => {
      vi.useFakeTimers();
      const input = human();
      const event =
        kind === 'button'
          ? { kind, button: 0 as const, down: true, x: 0, y: 0 }
          : { kind, code: 'ShiftLeft', down: true };
      input.begin([event]).complete();
      vi.advanceTimersByTime(60_000);
      await expect(agent()).rejects.toThrow('input is active');
      const up = input.begin([{ ...event, down: false }]);
      vi.advanceTimersByTime(60_000);
      await expect(agent()).rejects.toThrow('input is active');
      up.complete();
      await expect(agent()).rejects.toThrow('input is active');
      vi.advanceTimersByTime(HUMAN_INPUT_QUIET_MS);
      await expect(agent()).resolves.toBe('done');
    },
  );

  it('keeps a long text batch protected until native acknowledgement, then releases automatically', async () => {
    vi.useFakeTimers();
    const batch = human().begin([{ kind: 'text', text: 'test' }]);
    vi.advanceTimersByTime(60_000);
    await expect(agent()).rejects.toThrow('input is active');
    batch.complete();
    batch.complete();
    vi.advanceTimersByTime(HUMAN_INPUT_QUIET_MS);
    await expect(agent()).resolves.toBe('done');
  });

  it('reserves human priority and yields between Agent primitives without changing focus during a primitive', async () => {
    const input = human();
    let finish!: () => void;
    const primitive = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const action = withAgentDesktopInput(async (assertCurrent) => {
      await primitive;
      assertCurrent();
      throw new Error('must not dispatch the next text chunk');
    });
    const rejected = expect(action).rejects.toThrow('Agent yielded');
    const batch = input.begin([{ kind: 'text', text: 'human' }]);
    const native = vi.fn();
    void batch.ready.then(native);
    await Promise.resolve();
    expect(native).not.toHaveBeenCalled();
    await expect(agent()).rejects.toThrow('input is active');
    finish();
    await rejected;
    await batch.ready;
    expect(native).toHaveBeenCalledOnce();
    batch.complete();
  });

  it('clears held keys on release and keeps generations independent', async () => {
    vi.useFakeTimers();
    const old = human();
    old.begin([{ kind: 'key', code: 'ControlLeft', down: true }]).complete();
    const current = human();
    current.begin([{ kind: 'button', button: 0, down: true, x: 0, y: 0 }]).complete();
    old.release();
    vi.advanceTimersByTime(60_000);
    await expect(agent()).rejects.toThrow('input is active');
    current.begin([{ kind: 'release' }]).complete();
    vi.advanceTimersByTime(HUMAN_INPUT_QUIET_MS);
    await expect(agent()).resolves.toBe('done');
  });

  it('releases Agent ownership after errors and excludes overlapping Agent actions', async () => {
    let finish!: () => void;
    const events: string[] = [];
    const first = withAgentDesktopInput(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      throw new Error('failed');
    });
    const rejected = expect(first).rejects.toThrow('failed');
    const second = withAgentDesktopInput(async () => { events.push('second'); });
    const third = withAgentDesktopInput(async () => { events.push('third'); });
    expect(events).toEqual([]);
    finish();
    await Promise.all([rejected, second, third]);
    expect(events).toEqual(['second', 'third']);
    await expect(agent()).resolves.toBe('done');
  });

  it.each(['cancel', 'timeout'] as const)('removes a waiter on %s without releasing active input', async (mode) => {
    vi.useFakeTimers();
    let finish!: () => void;
    const active = withAgentDesktopInput(() => new Promise<void>((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const dispatch = vi.fn();
    const waiting = withAgentDesktopInput(dispatch, { signal: controller.signal });
    const rejected = expect(waiting).rejects.toMatchObject({ code: mode === 'cancel' ? 'REQUEST_CANCELLED' : 'DESKTOP_INPUT_BUSY' });
    if (mode === 'cancel') controller.abort();
    else await vi.advanceTimersByTimeAsync(AGENT_INPUT_WAIT_MS);
    await rejected;
    const next = vi.fn();
    const tail = withAgentDesktopInput(next);
    expect(next).not.toHaveBeenCalled();
    finish();
    await Promise.all([active, tail]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('revalidates queued work and drains past a refused waiter', async () => {
    let finish!: () => void;
    const active = withAgentDesktopInput(() => new Promise<void>((resolve) => { finish = resolve; }));
    const dispatch = vi.fn();
    const stale = withAgentDesktopInput(dispatch, { assertCurrent: () => { throw new Error('stale'); } });
    const rejected = expect(stale).rejects.toThrow('stale');
    const tail = agent();
    finish();
    await Promise.all([active, rejected, tail]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('gives human input priority over already-queued Agent work', async () => {
    let finish!: () => void;
    const active = withAgentDesktopInput(() => new Promise<void>((resolve) => { finish = resolve; }));
    const dispatch = vi.fn();
    const waiting = withAgentDesktopInput(dispatch);
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'DESKTOP_INPUT_BUSY' });
    const batch = human().begin([{ kind: 'text', text: 'human' }]);
    finish();
    await Promise.all([active, rejected, batch.ready]);
    batch.complete();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
