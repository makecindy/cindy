import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ handle: vi.fn(), guard: vi.fn(), read: vi.fn(), set: vi.fn() }));
vi.mock('electron', () => ({ app: {}, ipcMain: { handle: mocks.handle } }));
vi.mock('../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: mocks.guard,
}));
vi.mock('../login-item-settings.js', () => ({
  createLoginItemSettings: () => ({ read: mocks.read, set: mocks.set }),
}));

import { registerLoginItemIpc } from '../login-item-ipc.js';

describe('login startup IPC authorization', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    registerLoginItemIpc();
  });

  it.each(['login-item:get', 'login-item:set'])(
    'rejects untrusted senders before OS access on %s',
    (channel) => {
      const handler = mocks.handle.mock.calls.find(([name]) => name === channel)![1];
      mocks.guard.mockImplementation(() => {
        throw new Error('[PERMISSION_DENIED]');
      });
      expect(() => handler({}, true)).toThrow('[PERMISSION_DENIED]');
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.set).not.toHaveBeenCalled();
    },
  );

  it('passes the event through the guard and the uncoerced payload through validation', () => {
    const event = {};
    const handler = mocks.handle.mock.calls.find(([name]) => name === 'login-item:set')![1];
    handler(event, 'false');
    expect(mocks.guard).toHaveBeenCalledWith(event);
    expect(mocks.set).toHaveBeenCalledWith('false');
  });
});
