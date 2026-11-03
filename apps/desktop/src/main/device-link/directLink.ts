import { ipcMain } from 'electron';
import { createDirectRuntimeBridge, type DirectRuntime, type DirectRuntimeSession,
  type DirectRuntimeEvents } from '@cindy/device-link';
import { DIRECT_LINK_LOCAL } from '../../shared/directLink';
import { DesktopCaptureWindow } from '../remote-desktop/captureWindow';
import { createLogger } from '../logger';

const log = createLogger('device-link:direct');
const bridge = createDirectRuntimeBridge();
let detach: (() => void) | undefined;
let starting: Promise<void> | undefined;
let epoch = 0;
let registered = false;
let crashes = 0;
let stableTimer: ReturnType<typeof setTimeout> | undefined;
const host = new DesktopCaptureWindow(() => {
  crashes += 1;
  suspend();
  log.warn('data transport process stopped; active peers fall back to relay');
}, 'direct');

function suspend() {
  epoch += 1;
  clearTimeout(stableTimer);
  detach?.();
  detach = undefined;
  starting = undefined;
  host.dispose();
}
function ensureStarted(): Promise<void> {
  if (detach) return Promise.resolve();
  if (starting) return starting;
  if (crashes >= 2) return Promise.reject(new Error('DIRECT_RUNTIME_UNAVAILABLE'));
  if (!registered) {
    registered = true;
    ipcMain.handle(DIRECT_LINK_LOCAL.REGISTER, (event) => host.registered(event));
    ipcMain.handle(DIRECT_LINK_LOCAL.EVENT, (event, payload: unknown) => {
      host.assertSender(event);
      // Bridge validates shape, frame sizes, connection ownership and pending operation IDs.
      bridge.receive(payload);
    });
  }
  const generation = epoch;
  const work = host.start().then(() => {
    if (epoch !== generation) throw new Error('DIRECT_RUNTIME_CLOSED');
    detach = bridge.attach((command) => {
      const contents = host.contents;
      if (!contents || contents.isDestroyed()) throw new Error('DIRECT_RUNTIME_CLOSED');
      contents.send(DIRECT_LINK_LOCAL.COMMAND, command);
    });
    stableTimer = setTimeout(() => { crashes = 0; }, 60_000);
    stableTimer.unref();
  }).catch((error) => {
    // Constructor/setup failures may precede the window's own failure callback.
    if (generation === epoch) { crashes += 1; suspend(); }
    throw error;
  }).finally(() => { if (starting === work) starting = undefined; });
  starting = work;
  return work;
}

/** Startup is deferred until a capable, authorized peer actually needs a LAN path. */
export const desktopDirectRuntime: DirectRuntime = {
  create(id: string, events: DirectRuntimeEvents): DirectRuntimeSession {
    const generation = epoch;
    let session: DirectRuntimeSession | undefined;
    let closed = false;
    const get = async () => {
      await ensureStarted();
      if (closed || generation !== epoch) throw new Error('DIRECT_RUNTIME_CLOSED');
      return session ??= bridge.runtime.create(id, events);
    };
    return {
      offer: async () => (await get()).offer(),
      accept: async (sdp) => (await get()).accept(sdp),
      answer: async (sdp) => (await get()).answer(sdp),
      send: (text) => { if (!session || closed) throw new Error('DIRECT_RUNTIME_CLOSED'); session.send(text); },
      get bufferedAmount() { return session?.bufferedAmount ?? 0; },
      close: () => { closed = true; session?.close(); },
    };
  },
  suspend,
};
