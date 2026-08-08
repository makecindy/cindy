import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  };
});

vi.mock('electron', () => ({
  ipcMain: { handle: h.handle },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  app: {
    getPath: vi.fn(() => '/tmp/cindy-test-user-data'),
    getAppPath: vi.fn(() => '/tmp/cindy-test-app'),
    isPackaged: false,
  },
}));

vi.mock('../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: vi.fn(),
}));

vi.mock('../../agent-island/service.js', () => ({
  getAgentIslandService: () => null,
}));

import { __resetReadinessForTest, registerScheduleHandlers, setSchedulerReady } from '../schedule';

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const registered = h.handlers.get(channel);
  if (!registered) throw new Error(`missing handler: ${channel}`);
  return registered as (...args: unknown[]) => Promise<unknown>;
}

describe('schedule origin metadata IPC boundary', () => {
  const scheduler = {
    create: vi.fn(async (input: unknown) => input),
    updateFromCurrent: vi.fn(async (_id: string, patcher: unknown) => patcher),
  };

  beforeEach(() => {
    h.handlers.clear();
    h.handle.mockClear();
    scheduler.create.mockClear();
    scheduler.updateFromCurrent.mockClear();
    __resetReadinessForTest();
    registerScheduleHandlers();
    setSchedulerReady(scheduler as never, {} as never);
  });

  it.each(['originKind', 'originId'])('rejects %s on generic schedule create', async (field) => {
    await expect(handler('maker:schedule:create')({}, { [field]: undefined })).rejects.toThrow(
      /origin/i,
    );
    expect(scheduler.create).not.toHaveBeenCalled();
  });

  it.each(['originKind', 'originId'])('rejects %s on generic schedule update', async (field) => {
    await expect(
      handler('maker:schedule:update')({}, 'schedule-1', { [field]: undefined }),
    ).rejects.toThrow(/origin/i);
    expect(scheduler.updateFromCurrent).not.toHaveBeenCalled();
  });
});
