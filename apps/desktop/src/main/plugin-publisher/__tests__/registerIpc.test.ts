import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: { sender: { id: number } }, payload: unknown) => unknown;

const {
  handlers,
  boundaryPendingMock,
  getActiveAppSessionMock,
  snapshotForOwnerMock,
  cancelForOwnerMock,
  trustedRendererMock,
  startInstalledMock,
  confirmResolveMock,
} = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  boundaryPendingMock: vi.fn(() => false),
  getActiveAppSessionMock: vi.fn(() => ({
    mode: 'cloud' as const,
    dataOwnerId: 'member-1',
    generation: 7,
  })),
  snapshotForOwnerMock: vi.fn(() => ({ transferId: 'transfer-1', stage: 'confirming' })),
  cancelForOwnerMock: vi.fn(() => ({ cancelled: true })),
  trustedRendererMock: vi.fn(),
  startInstalledMock: vi.fn(async () => ({ transferId: 'transfer-2', uploadId: null })),
  confirmResolveMock: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  },
}));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: getActiveAppSessionMock,
  isAppSessionBoundaryPending: boundaryPendingMock,
}));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: trustedRendererMock,
}));
vi.mock('../host.js', () => ({
  startInstalledPluginPublish: startInstalledMock,
  getPluginPublisherConfirmBridge: vi.fn(() => ({ resolve: confirmResolveMock })),
  getPluginPublisherOrchestrator: vi.fn(() => ({
    snapshotForOwner: snapshotForOwnerMock,
    cancelForOwner: cancelForOwnerMock,
  })),
  trackPublisherConfirmRequester: vi.fn(),
}));
vi.mock('../../plugin-contributions/host.js', () => ({
  mapContributionError: (error: unknown) => { throw error; },
}));

const { registerPluginPublisherIpc } = await import('../registerIpc.js');

function handler(channel: string): Handler {
  const registered = handlers.get(channel);
  if (!registered) throw new Error(`${channel} handler 未注册`);
  return registered;
}

const event = { sender: { id: 9 } };

beforeAll(() => registerPluginPublisherIpc());

beforeEach(() => {
  boundaryPendingMock.mockReset();
  boundaryPendingMock.mockReturnValue(false);
  getActiveAppSessionMock.mockClear();
  snapshotForOwnerMock.mockClear();
  cancelForOwnerMock.mockClear();
  trustedRendererMock.mockClear();
  startInstalledMock.mockClear();
  confirmResolveMock.mockClear();
});

describe('plugin-publisher IPC owner boundary', () => {
  // #1541 reopens UI publishing to the organization. The renderer may only name an installed
  // plugin: a file path (forgeable by an XSS) must never reach the publisher.
  it('starts UI publishing from an installed plugin and never accepts a file path', async () => {
    const sender = { id: 9 };
    await expect(handler('plugin-publisher:start-installed')({ sender }, { instanceId: 'local/demo' }))
      .resolves.toEqual({ transferId: 'transfer-2', uploadId: null });
    expect(startInstalledMock).toHaveBeenCalledWith('local/demo', undefined, sender);

    for (const payload of ['C:\\Users\\demo\\plugin.cindy', { filePath: '/tmp/plugin.cindy' },
      { instanceId: 'local/demo', filePath: '/tmp/plugin.cindy' }]) {
      await expect(handler('plugin-publisher:start-installed')(event, payload))
        .rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
    expect(handlers.has('plugin-publisher:start')).toBe(false);
    expect(startInstalledMock).toHaveBeenCalledOnce();
  });

  it('forwards a well-formed audience with the confirmation and rejects malformed ones', () => {
    const audience = { type: 'matchAny', departmentIds: ['d1'] };
    expect(handler('plugin-publisher:resolve-confirm')(event, {
      requestId: 'request-1', confirmed: true, visibilityAudience: audience,
    })).toEqual({ handled: true });
    expect(confirmResolveMock).toHaveBeenCalledWith(9, 'request-1', true, audience);

    expect(() => handler('plugin-publisher:resolve-confirm')(event, {
      requestId: 'request-2', confirmed: true, visibilityAudience: { type: 'everyone' },
    })).toThrow(/INVALID_PARAMS/);
    expect(confirmResolveMock).toHaveBeenCalledOnce();
  });

  it('passes same-owner status and cancel through the owner-aware lookup', () => {
    const owner = getActiveAppSessionMock();

    expect(handler('plugin-publisher:status')(event, 'transfer-1')).toEqual({
      progress: { transferId: 'transfer-1', stage: 'confirming' },
    });
    expect(snapshotForOwnerMock).toHaveBeenCalledWith('transfer-1', owner);
    expect(handler('plugin-publisher:cancel')(event, 'transfer-1')).toEqual({
      cancelled: true,
    });
    expect(cancelForOwnerMock).toHaveBeenCalledWith('transfer-1', owner);
  });

  it('hides status and cancel while the app-session boundary is pending', () => {
    boundaryPendingMock.mockReturnValue(true);

    expect(handler('plugin-publisher:status')(event, 'transfer-1')).toEqual({
      progress: null,
    });
    expect(handler('plugin-publisher:cancel')(event, 'transfer-1')).toEqual({
      cancelled: false,
    });
    // Excludes checking a transfer before the account boundary settles.
    expect(snapshotForOwnerMock).not.toHaveBeenCalled();
    expect(cancelForOwnerMock).not.toHaveBeenCalled();
  });
});
