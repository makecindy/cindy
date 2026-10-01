import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: { sender: { id: number } }, payload: unknown) => unknown;

const {
  handlers,
  boundaryPendingMock,
  getActiveAppSessionMock,
  snapshotForOwnerMock,
  cancelForOwnerMock,
  trustedRendererMock,
  publisherApiMock,
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
  publisherApiMock: vi.fn(() => ({ listMine: async () => ({ releases: [], nextCursor: null }) })),
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
  createPluginPublisherApi: publisherApiMock,
  currentPublisherIdentity: vi.fn(() => ({
    membershipId: 'member-1',
    orgSlug: 'acme',
    orgName: 'Acme',
  })),
  getPluginPublisherConfirmBridge: vi.fn(() => ({ resolve: vi.fn() })),
  getPluginPublisherOrchestrator: vi.fn(() => ({
    snapshotForOwner: snapshotForOwnerMock,
    cancelForOwner: cancelForOwnerMock,
  })),
  trackPublisherConfirmRequester: vi.fn(),
}));
vi.mock('../api.js', () => ({
  PluginPublisherApiError: class extends Error {},
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
  publisherApiMock.mockClear();
});

describe('plugin-publisher IPC owner boundary', () => {
  it('uses the shared Host HTTP client for publication-history requests', async () => {
    await expect(handler('plugin-publisher:list-mine')(event, null)).resolves.toEqual({ releases: [], nextCursor: null });
    expect(publisherApiMock).toHaveBeenCalledOnce();
  });

  it('fails closed when an untrusted Renderer submits a publish file path', async () => {
    let caught: unknown;
    try {
      await handler('plugin-publisher:start')(event, 'C:\\Users\\demo\\plugin.cindy');
    } catch (error) {
      caught = error;
    }
    // Excludes restoring the path-taking Renderer IPC before a Main-minted grant exists.
    expect(caught).toMatchObject({ code: 'INVALID_PARAMS' });
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
