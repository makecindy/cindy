import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  broadcastCindyMakeHistoryChanged,
  CINDY_MAKE_HISTORY_CHANGED,
} from '../historyBroadcast.js';

const windows = [
  { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
  { isDestroyed: vi.fn(() => true), webContents: { send: vi.fn() } },
];
const ownerStamp = { dataOwnerId: 'owner-a', ownerGeneration: 3 };

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => windows),
  },
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({ ownerStamp }),
}));

describe('Cindy Make history broadcast', () => {
  beforeEach(() => {
    for (const window of windows) {
      window.isDestroyed.mockClear();
      window.webContents.send.mockClear();
    }
  });

  it('invalidates history in every live window for the current owner', () => {
    broadcastCindyMakeHistoryChanged();

    expect(windows[0].webContents.send).toHaveBeenCalledWith(
      CINDY_MAKE_HISTORY_CHANGED,
      ownerStamp,
    );
    expect(windows[1].webContents.send).not.toHaveBeenCalled();
  });
});
