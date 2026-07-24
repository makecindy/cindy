import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAllWindows, tapWindowBroadcast } = vi.hoisted(() => ({
  getAllWindows: vi.fn(),
  tapWindowBroadcast: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows },
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  tapWindowBroadcast,
}));

import {
  CONTENT_MODERATION_INPUT_BLOCKED_CHANNEL,
  broadcastModerationInputBlocked,
} from '../notifications.js';

describe('broadcastModerationInputBlocked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAllWindows.mockReturnValue([]);
  });

  it('同时通知本机 renderer 和 device-link 控制端', () => {
    const send = vi.fn();
    getAllWindows.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: { send },
      },
    ]);

    broadcastModerationInputBlocked({
      sessionId: 'session-1',
      item: {
        clientId: 'client-1',
        text: 'blocked input',
        files: [],
      } as never,
      reason: 'rejected',
    });

    const payload = {
      sessionId: 'session-1',
      clientId: 'client-1',
      text: 'blocked input',
      files: [],
      reason: 'rejected',
    };
    expect(tapWindowBroadcast).toHaveBeenCalledWith(
      CONTENT_MODERATION_INPUT_BLOCKED_CHANNEL,
      payload,
    );
    expect(send).toHaveBeenCalledWith(CONTENT_MODERATION_INPUT_BLOCKED_CHANNEL, payload);
  });
});
