import { beforeEach, describe, expect, it, vi } from 'vitest';

import { broadcastCindyMakeSourceStatus } from '../sourceStatusBroadcast.js';
import type { MakeSourceStatus } from '../../../shared/cindyMakeDoctor.js';

const windows = [
  { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
  { isDestroyed: vi.fn(() => true), webContents: { send: vi.fn() } },
];

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => windows),
  },
}));

describe('Cindy Make source status broadcast', () => {
  beforeEach(() => {
    for (const window of windows) {
      window.isDestroyed.mockClear();
      window.webContents.send.mockClear();
    }
  });

  it('sends status to every live window', () => {
    const status: MakeSourceStatus = {
      status: 'preparing',
      path: 'C:\\Cindy\\source',
      phase: 'cloning',
    };

    broadcastCindyMakeSourceStatus(status);

    expect(windows[0].webContents.send).toHaveBeenCalledWith('cindy-make:source-status', status);
    expect(windows[1].webContents.send).not.toHaveBeenCalled();
  });
});
