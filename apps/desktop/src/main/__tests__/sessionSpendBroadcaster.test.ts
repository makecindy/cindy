/**
 * sessionSpendBroadcaster tests for session-level context snapshot persistence.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const runMock = vi.fn();
const getMock = vi.fn();
const setMock = vi.fn();

vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({
    drizzle: {
      update: vi.fn(() => ({
        set: setMock,
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: getMock,
          })),
        })),
      })),
    },
  }),
}));

import { recordSessionContextSnapshot } from '../sessionSpendBroadcaster.js';

beforeEach(() => {
  vi.clearAllMocks();
  runMock.mockResolvedValue(undefined);
  getMock.mockResolvedValue({ contextTokens: 0, contextWindow: 200000 });
  setMock.mockReturnValue({
    where: vi.fn(() => ({
      run: runMock,
    })),
  });
});

describe('recordSessionContextSnapshot', () => {
  it('does not certify an old catalog window when a status only supplies tokens', async () => {
    await recordSessionContextSnapshot('s1', 42, 0);
    expect(setMock).toHaveBeenCalledWith({ contextTokens: 42 });
  });

  it('skips 0/0 placeholder snapshots from interrupted compact turns', async () => {
    await recordSessionContextSnapshot('s1', 0, 0);

    expect(setMock).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('persists zero context tokens when the context window is authoritative', async () => {
    await recordSessionContextSnapshot('s1', 0, 200000);

    expect(setMock).toHaveBeenCalledWith({ contextTokens: 0, contextWindow: 200000, contextWindowRuntime: 200000 });
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});
