import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  boundaryPending: false,
  limit: vi.fn(),
  ownerScope: 'owner-a',
  tap: vi.fn(),
}));

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: () => ({ dataOwnerId: h.ownerScope, epoch: 1 }),
  tapWindowBroadcast: h.tap,
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.ownerScope,
  isAppSessionBoundaryPending: () => h.boundaryPending,
}));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: h.limit }),
        }),
      }),
    },
  }),
}));

import {
  scheduleBotRemoteResourceChangedForSession,
} from '../botRemoteResourceInvalidation.js';

describe('Bot remote resource message invalidation', () => {
  beforeEach(() => {
    h.boundaryPending = false;
    h.ownerScope = 'owner-a';
    h.limit.mockReset();
    h.limit.mockResolvedValue([{ botId: 'bot-1' }]);
    h.tap.mockReset();
  });

  it('coalesces canonical Session message writes into a generic collection invalidation', async () => {
    scheduleBotRemoteResourceChangedForSession('session-1');
    scheduleBotRemoteResourceChangedForSession('session-1');

    await vi.waitFor(() => expect(h.tap).toHaveBeenCalledOnce());
    expect(h.limit).toHaveBeenCalledWith(1);
    expect(h.tap).toHaveBeenCalledWith(
      'maker:remote-resources:changed',
      expect.objectContaining({ collectionId: 'teammates' }),
      expect.objectContaining({ dataOwnerId: 'owner-a' }),
    );
  });

  it('drops the deferred lookup across an account boundary', async () => {
    scheduleBotRemoteResourceChangedForSession('session-2');
    h.ownerScope = 'owner-b';

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.tap).not.toHaveBeenCalled();
  });
});
