import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../i18n', () => ({ t: (key: string) => key }));
import { LinuxPrivacyScreen } from '../linuxPrivacy';
const owners: LinuxPrivacyScreen[] = [];
afterEach(() => {
  owners.splice(0).forEach((owner) => owner.stop());
  vi.useRealTimers();
});
function fixture() {
  let state = 'active';
  const resume = vi.fn(async () => {});
  const pause = vi.fn(async () => resume);
  const stop = vi.fn(async () => {});
  const prepare = vi.fn(async () => {});
  const call = vi.fn(async (request: Record<string, unknown>) => {
    if (request.op === 'confirm') return (state = 'confirming');
    if (request.op === 'resume') return (state = 'active');
    if (request.op === 'stop') return 'off';
    return state;
  });
  const owner = new LinuxPrivacyScreen(stop, pause, { prepare, call, labels: () => [] });
  owners.push(owner);
  return {
    owner,
    call,
    prepare,
    pause,
    resume,
    stop,
    state: (next: string) => {
      state = next;
    },
  };
}
it('fences input before confirmation and restores it before native resume', async () => {
  vi.useFakeTimers();
  const h = fixture();
  await h.owner.set(true, () => true);
  h.state('pending');
  await vi.advanceTimersByTimeAsync(250);
  expect(h.pause).toHaveBeenCalledOnce();
  expect(h.call).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'confirm' }));
  h.state('resume');
  await vi.advanceTimersByTimeAsync(250);
  expect(h.resume).toHaveBeenCalledOnce();
  expect(h.call).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'resume' }));
  h.state('disconnect');
  await vi.advanceTimersByTimeAsync(250);
  expect(h.stop).toHaveBeenCalledOnce();
  expect(h.owner.active).toBe(false);
});
it('does not start privacy after preparation loses its lease', async () => {
  const h = fixture();
  let resolve!: () => void;
  h.prepare.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const starting = h.owner.set(true, () => true);
  await Promise.resolve();
  h.owner.stop();
  resolve();
  await expect(starting).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
  expect(h.call).not.toHaveBeenCalled();
});
it('ends only this desktop when native privacy disappears', async () => {
  vi.useFakeTimers();
  const h = fixture();
  await h.owner.set(true, () => true);
  h.state('off');
  await vi.advanceTimersByTimeAsync(250);
  expect(h.stop).toHaveBeenCalledOnce();
  expect(h.owner.active).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it('stopping during a local input pause cannot reopen the dialog', async () => {
  vi.useFakeTimers();
  const h = fixture();
  let resolve!: (value: typeof h.resume) => void;
  h.pause.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await h.owner.set(true, () => true);
  h.state('pending');
  await vi.advanceTimersByTimeAsync(250);
  h.owner.stop();
  resolve(h.resume);
  await vi.advanceTimersByTimeAsync(250);
  expect(h.call.mock.calls.some(([r]) => r.op === 'confirm')).toBe(false);
  expect(h.resume).not.toHaveBeenCalled();
});
it('retires a late native start after an earlier stop already returned', async () => {
  const h = fixture();
  let reply!: (state: string) => void;
  h.call.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  const starting = h.owner.set(true, () => true);
  await Promise.resolve();
  await Promise.resolve();
  const token = h.call.mock.calls[0][0].token;
  h.owner.stop();
  reply('active');
  await expect(starting).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
  expect(h.call.mock.calls.filter(([r]) => r.op === 'stop' && r.token === token)).toHaveLength(2);
});
it('waits for first rendered masks instead of acknowledging the start command', async () => {
  vi.useFakeTimers();
  const h = fixture();
  h.call.mockResolvedValueOnce('starting');
  let ready = false;
  const starting = h.owner
    .set(true, () => true)
    .then(() => {
      ready = true;
    });
  await vi.advanceTimersByTimeAsync(24);
  expect(ready).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await starting;
  expect(ready).toBe(true);
});
it('releases masks even when controller teardown fails', async () => {
  vi.useFakeTimers();
  const h = fixture();
  await h.owner.set(true, () => true);
  h.stop.mockRejectedValue(new Error('shutdown'));
  h.state('off');
  await vi.advanceTimersByTimeAsync(250);
  expect(h.owner.active).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it('disabling privacy during a pending local pause restores input for the live lease', async () => {
  vi.useFakeTimers();
  const h = fixture();
  let resolve!: (value: typeof h.resume) => void;
  h.pause.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await h.owner.set(true, () => true);
  h.state('pending');
  await vi.advanceTimersByTimeAsync(250);
  const disabling = h.owner.set(false, () => true);
  resolve(h.resume);
  await disabling;
  expect(h.resume).toHaveBeenCalledOnce();
  expect(h.call.mock.calls.some(([r]) => r.op === 'confirm')).toBe(false);
});
it('a late input resume cannot clear the replacement owner resume callback', async () => {
  vi.useFakeTimers();
  const h = fixture();
  let finish!: () => void;
  h.resume.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        finish = done;
      }),
  );
  await h.owner.set(true, () => true);
  h.state('pending');
  await vi.advanceTimersByTimeAsync(250);
  h.state('resume');
  await vi.advanceTimersByTimeAsync(250);
  h.owner.stop();
  h.state('active');
  await h.owner.set(true, () => true);
  const nextResume = vi.fn(async () => {});
  h.pause.mockResolvedValueOnce(nextResume);
  h.state('pending');
  await vi.advanceTimersByTimeAsync(250);
  finish();
  await Promise.resolve();
  h.state('resume');
  await vi.advanceTimersByTimeAsync(250);
  expect(nextResume).toHaveBeenCalledOnce();
});
