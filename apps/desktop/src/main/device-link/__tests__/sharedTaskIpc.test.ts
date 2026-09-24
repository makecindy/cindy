import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED_TASK_ACCOUNT_CHANNEL, SHARED_TASK_HOST_CHANNEL } from '@cindy/device-link';
import { registerSharedTaskIpc } from '../sharedTaskIpc.js';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  context: null as null | { sharedTask?: object },
  trusted: vi.fn(),
  list: vi.fn(),
  close: vi.fn(),
  host: { activeSharedTaskIds: vi.fn(() => []), open: vi.fn(), close: vi.fn() },
}));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (event: unknown, raw: unknown) => Promise<unknown>) => h.handlers.set(channel, handler) } }));
vi.mock('../../authManager.js', () => ({ getCurrentUserId: () => 'owner' }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: h.trusted }));
vi.mock('../invoke-context.js', () => ({ getDeviceLinkInvokeContext: () => h.context }));
vi.mock('../sharedTaskRuntime.js', () => ({ requireSharedTaskHost: () => h.host }));
vi.mock('../sharedTaskApi.js', () => ({ sharedTaskApi: { list: h.list, close: h.close } }));

const invoke = (channel: string, command: unknown) => h.handlers.get(channel)!({}, command);
const commands = [
  [SHARED_TASK_HOST_CHANNEL, { action: 'state', sessionId: 'task' }],
  [SHARED_TASK_HOST_CHANNEL, { action: 'open', sessionId: 'task' }],
  [SHARED_TASK_ACCOUNT_CHANNEL, { action: 'owned' }],
  [SHARED_TASK_ACCOUNT_CHANNEL, { action: 'close', sharedTaskId: 'share' }],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear(); h.context = null;
  h.list.mockResolvedValue([]);
});

describe('shared-task IPC availability', () => {
  it.each(commands)('returns a retryable disconnect for %s %j without side effects', async (channel, command) => {
    registerSharedTaskIpc(() => false, () => false);
    await expect(invoke(channel, command)).rejects.toMatchObject({ code: 'DEVICE_LINK_NOT_CONNECTED' });
    expect(h.host.open).not.toHaveBeenCalled();
    expect(h.host.activeSharedTaskIds).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
  });

  it('keeps unsupported capability distinct when the relay is online', async () => {
    registerSharedTaskIpc(() => false, () => true);
    await expect(invoke(SHARED_TASK_HOST_CHANNEL, { action: 'state', sessionId: 'task' }))
      .resolves.toEqual({ available: false, detail: null });
    for (const [channel, command] of commands.slice(1)) {
      await expect(invoke(channel, command)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    }
    expect(h.list).not.toHaveBeenCalled();
  });

  it('recovers after reconnection without re-registering handlers', async () => {
    let online = true;
    registerSharedTaskIpc(() => online, () => online);
    const state = () => invoke(SHARED_TASK_HOST_CHANNEL, { action: 'state', sessionId: 'task' });
    await expect(state()).resolves.toEqual({ available: true, detail: null });
    online = false;
    await expect(state()).rejects.toMatchObject({ code: 'DEVICE_LINK_NOT_CONNECTED' });
    online = true;
    await expect(state()).resolves.toEqual({ available: true, detail: null });
    await expect(invoke(SHARED_TASK_ACCOUNT_CHANNEL, { action: 'owned' })).resolves.toEqual([]);
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it('retains the guest and tunneled-account permission guards before availability', async () => {
    registerSharedTaskIpc(() => false, () => false);
    h.context = { sharedTask: {} };
    for (const [channel, command] of commands) {
      await expect(invoke(channel, command)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    h.context = {};
    await expect(invoke(SHARED_TASK_ACCOUNT_CHANNEL, { action: 'owned' }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
