import { afterEach, expect, it, vi } from 'vitest';
import type { DirectRuntimeCommand, DirectRuntimeEvents } from '@cindy/device-link';
const fake = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(), commands: [] as DirectRuntimeCommand[],
  starts: 0, closes: 0, failed: undefined as (() => void) | undefined,
  ready: undefined as Promise<void> | undefined,
}));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => fake.handlers.set(name, fn) } }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn() {} }) }));
vi.mock('../../remote-desktop/captureWindow', () => ({ DesktopCaptureWindow: class {
  constructor(failed: () => void) { fake.failed = failed; }
  contents = { isDestroyed: () => false, send: (_name: string, c: DirectRuntimeCommand) => {
    fake.commands.push(c);
    if (c.action === 'offer' || c.action === 'answer' || c.action === 'accept')
      fake.handlers.get('direct-link:host:event')!({ trusted: true }, { type: 'reply', id: c.id, ok: true, value: 'fixture-sdp' });
  } };
  async start() { fake.starts++; await fake.ready; }
  dispose() { fake.closes++; }
  registered(event: { trusted: boolean }) { this.assertSender(event); }
  assertSender(event: { trusted: boolean }) { if (!event.trusted) throw new Error('PERMISSION_DENIED'); }
} }));
import { desktopDirectRuntime } from '../directLink';

// Native startup and sender/lifetime boundary cannot be exercised by the browser-only
// transport tests. No real windows, sockets, credentials or module resets in unit tier.
afterEach(() => { desktopDirectRuntime.suspend?.(); fake.commands = []; fake.ready = undefined; vi.useRealTimers(); });
const events = (): DirectRuntimeEvents => ({ open: vi.fn(), closed: vi.fn(), message: vi.fn(), drained: vi.fn() });

it('starts one isolated process lazily and routes authorized native frames to their registered peer', async () => {
  const before = fake.starts, observer = events();
  const a = desktopDirectRuntime.create('one', observer), b = desktopDirectRuntime.create('two', events());
  expect(fake.starts).toBe(before);
  expect(await a.offer()).toBe('fixture-sdp'); expect(await b.offer()).toBe('fixture-sdp');
  expect(fake.starts).toBe(before + 1);
  const receive = fake.handlers.get('direct-link:host:event')!;
  receive({ trusted: true }, { type: 'open', connection: 'one' });
  receive({ trusted: true }, { type: 'message', connection: 'unknown', text: 'foreign' });
  receive({ trusted: true }, { type: 'message', connection: 'one', text: 'authorized' });
  expect(observer.open).toHaveBeenCalledOnce(); expect(observer.message).toHaveBeenCalledExactlyOnceWith('authorized');
  a.send('outbound'); expect(fake.commands.at(-1)).toMatchObject({ action: 'send', connection: 'one', text: 'outbound' });
});

it('rejects foreign senders before processing any bridge event', async () => {
  const observer = events(), session = desktopDirectRuntime.create('one', observer);
  await session.offer();
  expect(() => fake.handlers.get('direct-link:host:event')!({ trusted: false }, { type: 'open', connection: 'one' })).toThrow('PERMISSION_DENIED');
  expect(observer.open).not.toHaveBeenCalled();
});

it('does not create a late session after the authenticated owner was suspended during startup', async () => {
  let resolve!: () => void;
  fake.ready = new Promise(r => { resolve = r; });
  const session = desktopDirectRuntime.create('one', events());
  const opening = session.offer(), rejected = expect(opening).rejects.toThrow('CLOSED');
  desktopDirectRuntime.suspend?.(); resolve(); await rejected;
  expect(fake.commands).toHaveLength(0);
});

it('releases active paths after a renderer crash and bounds automatic process restarts', async () => {
  vi.useFakeTimers();
  const observer = events(), session = desktopDirectRuntime.create('one', observer);
  await session.offer();
  fake.failed!(); expect(observer.closed).toHaveBeenCalledOnce();
  const second = desktopDirectRuntime.create('two', events()); await second.offer();
  fake.failed!();
  await expect(desktopDirectRuntime.create('three', events()).offer()).rejects.toThrow('UNAVAILABLE');
});
