import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const trusted = {
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() },
  };
  const navigated = {
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() },
  };
  const destroyed = {
    isDestroyed: vi.fn(() => true),
    webContents: { send: vi.fn() },
  };
  return {
    trusted,
    navigated,
    destroyed,
    scopeCurrent: true,
    activeStamp: { dataOwnerId: 'active-owner', ownerGeneration: 2 },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [h.trusted, h.navigated, h.destroyed],
  },
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../../../appSessionState.js', () => ({
  getActiveDataOwnerPushStamp: () => h.activeStamp,
}));
vi.mock('../../../device-link/broadcast-tap.js', () => ({
  isDataOwnerBroadcastScopeCurrent: () => h.scopeCurrent,
}));
vi.mock('../../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
  isTrustedAppRendererWindow: (window: unknown) => window === h.trusted,
}));
vi.mock('../../client/current.js', () => ({
  getDbClient: vi.fn(),
}));

import { SUBAGENT_RUNS_CHANGED_CHANNEL } from '@cindy/maker-shared/subagent-workspace';
import { broadcastSubagentRunsChanged } from '../subagentRuns.js';

describe('Subagent runs broadcast boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.scopeCurrent = true;
  });

  it('sends only to a currently trusted Cindy renderer window', () => {
    const payload = {
      sessionId: 'session-1',
      runId: 'run-1',
      created: true,
      firstForSession: true,
    };

    broadcastSubagentRunsChanged(payload);

    expect(h.trusted.webContents.send).toHaveBeenCalledWith(
      SUBAGENT_RUNS_CHANGED_CHANNEL,
      payload,
      h.activeStamp,
    );
    expect(h.navigated.webContents.send).not.toHaveBeenCalled();
    expect(h.destroyed.webContents.send).not.toHaveBeenCalled();
  });

  it('drops a late old-owner broadcast instead of relabeling it', () => {
    h.scopeCurrent = false;

    broadcastSubagentRunsChanged(
      { sessionId: 'session-1', runId: 'run-1', created: false, firstForSession: false },
      {
        ownerScopeKey: 'old-owner',
        ownerStamp: { dataOwnerId: 'old-owner', ownerGeneration: 1 },
      },
    );

    expect(h.trusted.webContents.send).not.toHaveBeenCalled();
  });

  it('uses the captured owner stamp when the scope is still current', () => {
    const captured = { dataOwnerId: 'captured-owner', ownerGeneration: 7 };
    const payload = {
      sessionId: 'session-1',
      runId: 'run-1',
      created: false,
      firstForSession: false,
    };

    broadcastSubagentRunsChanged(payload, {
      ownerScopeKey: 'captured-owner',
      ownerStamp: captured,
    });

    expect(h.trusted.webContents.send).toHaveBeenCalledWith(
      SUBAGENT_RUNS_CHANGED_CHANNEL,
      payload,
      captured,
    );
  });
});
