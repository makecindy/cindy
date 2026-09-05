import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ handle: vi.fn(), list: vi.fn(), trust: vi.fn(), remote: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: h.handle } }));
vi.mock('../conversationSearch.js', () => ({ searchConversations: vi.fn() }));
vi.mock('../quickSwitcher.js', () => ({ listQuickSwitcherCatalog: h.list }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: h.trust }));
vi.mock('../../device-link/invoke-context.js', () => ({ isDeviceLinkInvoke: h.remote }));

import { registerSearchIpc } from '../ipc/search';
import { createIpcError } from '../../../shared/ipc-errors';

function handler(): (event: unknown, cursor?: unknown) => Promise<unknown> {
  registerSearchIpc();
  return h.handle.mock.calls.find(([channel]) => channel === 'local-db:conversations:catalog')![1];
}
beforeEach(() => {
  vi.resetAllMocks();
  h.remote.mockReturnValue(false);
  h.list.mockResolvedValue({ version: 1, sessions: [], nextCursor: null });
});
describe('title catalogue IPC boundary', () => {
  it('validates the app renderer and passes the opaque page cursor', async () => {
    const event = {};
    await handler()(event, 'last-id');
    expect(h.trust).toHaveBeenCalledWith(event);
    expect(h.list).toHaveBeenCalledWith('last-id');
  });
  it('accepts authenticated device-link dispatch without requiring a BrowserWindow', async () => {
    h.remote.mockReturnValue(true);
    await handler()(null);
    expect(h.trust).not.toHaveBeenCalled();
    expect(h.list).toHaveBeenCalledWith(null);
  });
  it('denies an untrusted local sender before reading any data', async () => {
    h.trust.mockImplementation(() => {
      throw createIpcError('PERMISSION_DENIED', 'untrusted');
    });
    await expect(handler()({})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(h.list).not.toHaveBeenCalled();
  });
  it.each([1, {}, '', 'x'.repeat(257)])('rejects an invalid cursor', async (cursor) => {
    await expect(handler()({}, cursor)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(h.list).not.toHaveBeenCalled();
  });
  it('does not expose database paths or error details', async () => {
    h.list.mockRejectedValue(new Error('database /private/data/file.db failed'));
    await expect(handler()({})).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.not.stringContaining('/private/'),
    });
  });
});
