import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  create: vi.fn(), list: vi.fn(), broadcast: vi.fn(), fromWebContents: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler) },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../maker-orchestration/fork.js', () => ({
  createSideChat: mocks.create, listSideChats: mocks.list,
  forkSessionAtMessage: vi.fn(), forkSessionStripEncrypted: vi.fn(),
}));
vi.mock('../../localDb/ipc/sessionCreatedBroadcast.js', () => ({ emitSessionCreated: mocks.broadcast }));

import { runDeviceLinkInvokeContext } from '../../device-link/invoke-context';
import { markAppContentWindow } from '../../windowFocusClassifier';
import { registerMakerForkIpc } from '../fork';
import { MAKER_INVOKE } from '../channels';

// Unit: review #6529 exposed missing sender checks on both new IPC routes.
// Orchestration tests never exercise the Electron boundary. Register the real
// handlers and use the real sender guard; only fork storage/runtime is replaced.
// Minimal failures: a child/external/unregistered frame or a mismatched remote
// context must not read history, create a task, or broadcast it.
describe('side chat IPC caller boundary', () => {
  const channels = [MAKER_INVOKE.SIDE_CHAT, MAKER_INVOKE.SIDE_CHAT_LIST];
  function event(kind = 'trusted') {
    const frame = { url: kind === 'external' ? 'https://untrusted.example/' : 'http://localhost:5173/', parent: null };
    const win = { isDestroyed: () => false };
    if (kind !== 'unregistered') markAppContentWindow(win as never);
    mocks.fromWebContents.mockReturnValue(win);
    return { sender: { mainFrame: frame }, senderFrame: kind === 'child' ? { ...frame, parent: frame } : frame };
  }
  function invoke(channel: string, caller: unknown) {
    return Promise.resolve().then(() => mocks.handlers.get(channel)!(caller, 'parent'));
  }
  beforeEach(() => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173/');
    vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
    mocks.handlers.clear();
    mocks.create.mockReset().mockResolvedValue({ id: 'child', source: 'side-chat' });
    mocks.list.mockReset().mockResolvedValue([{ id: 'child', source: 'side-chat' }]);
    mocks.broadcast.mockClear();
    registerMakerForkIpc();
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['child', 'external', 'unregistered'])('rejects a %s frame on both routes before data access', async kind => {
    for (const channel of channels) await expect(invoke(channel, event(kind))).rejects.toThrow('[PERMISSION_DENIED]');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('allows a registered top-level app frame to create and list follow-ups', async () => {
    await expect(invoke(channels[0], event())).resolves.toMatchObject({ id: 'child' });
    await expect(invoke(channels[1], event())).resolves.toEqual([{ id: 'child', source: 'side-chat' }]);
    expect(mocks.broadcast).toHaveBeenCalledExactlyOnceWith('child');
  });

  it('preserves authorized same-account device-link calls without an Electron frame', async () => {
    for (const channel of channels) {
      await expect(runDeviceLinkInvokeContext({ controllerDeviceId: 'phone', channel }, () => invoke(channel, {})))
        .resolves.toEqual(channel === channels[0] ? { id: 'child', source: 'side-chat' } : [{ id: 'child', source: 'side-chat' }]);
    }
  });

  it.each(['wrong-channel', 'shared-task'])('rejects %s remote context on both routes', async kind => {
    for (const channel of channels) {
      const context = { controllerDeviceId: 'phone', channel: kind === 'wrong-channel' ? 'other' : channel,
        ...(kind === 'shared-task' ? { sharedTask: {} as never } : {}) };
      await expect(runDeviceLinkInvokeContext(context, () => invoke(channel, event())))
        .rejects.toThrow('[PERMISSION_DENIED]');
    }
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
