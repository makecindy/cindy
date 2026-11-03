import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ tx: vi.fn(), send: vi.fn(), tap: vi.fn(), session: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: h.send } }] },
}));
vi.mock('../../../logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../client/current', () => ({ getDbClient: () => ({ tx: h.tx }) }));
vi.mock('../../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
  isTrustedAppRendererWindow: () => true,
}));
vi.mock('../../../device-link/broadcast-tap.js', () => ({
  tapWindowBroadcast: h.tap,
  captureDataOwnerBroadcastScope: () => ({ ownerStamp: 'owner' }),
  isDataOwnerBroadcastScopeCurrent: () => true,
}));
vi.mock('../sessions', () => ({ broadcastSessionPatched: h.session }));
import { executeTaskTags } from '../taskTags';
beforeEach(() => vi.clearAllMocks());
it.each(['attach', 'detach'] as const)(
  'broadcasts the revised catalog after %s to local and remote editors',
  async (action) => {
    const tags = [{ id: 'tag', name: 'Tag', color: 'red', revision: 2, favoriteOrder: null }];
    h.tx.mockResolvedValue({
      tags,
      sessions: [{ sessionId: 'task', tags: action === 'attach' ? tags : [] }],
    });
    await executeTaskTags({ action, sessionIds: ['task'], tagIds: ['tag'] });
    expect(h.tap).toHaveBeenCalledWith('local-db:task-tags:changed', { tags }, 'owner');
    expect(h.send).toHaveBeenCalledWith('local-db:task-tags:changed', { tags }, 'owner');
    expect(h.session).toHaveBeenCalledWith(
      'task',
      { tags: action === 'attach' ? tags : [] },
      { ownerStamp: 'owner' },
    );
  },
);
