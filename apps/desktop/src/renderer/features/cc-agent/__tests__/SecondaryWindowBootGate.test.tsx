// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBootDeviceId: vi.fn<() => string | null>(),
  getBootSessionId: vi.fn<() => string | null>(),
  getMergedRemoteSessions: vi.fn<() => Array<Record<string, unknown>>>(),
  getSessionFor: vi.fn(),
  navigate: vi.fn(),
  pinSessionOrigin: vi.fn(),
  resolveSessionRoute: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('@/lib/secondaryWindow', () => ({
  getBootDeviceId: mocks.getBootDeviceId,
  getBootSessionId: mocks.getBootSessionId,
}));

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: {
    getMergedRemoteSessions: mocks.getMergedRemoteSessions,
    pinSessionOrigin: mocks.pinSessionOrigin,
  },
}));

vi.mock('@/lib/makerTransport', () => ({
  getSessionFor: mocks.getSessionFor,
}));

vi.mock('@/lib/orcaSessionIdentity', () => ({
  resolveSessionRoute: mocks.resolveSessionRoute,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

import { SecondaryWindowBootGate } from '../SecondaryWindowBootGate';

describe('SecondaryWindowBootGate', () => {
  beforeEach(() => {
    mocks.getBootDeviceId.mockReset();
    mocks.getBootSessionId.mockReset();
    mocks.getMergedRemoteSessions.mockReset();
    mocks.getSessionFor.mockReset();
    mocks.navigate.mockReset();
    mocks.pinSessionOrigin.mockReset();
    mocks.resolveSessionRoute.mockReset();
    mocks.getBootSessionId.mockReturnValue('worker-remote');
    mocks.getBootDeviceId.mockReturnValue('device-remote');
    mocks.getMergedRemoteSessions.mockReturnValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it('reads remote Worker metadata after pinning when the mirror has not hydrated', async () => {
    const workerSession = { id: 'worker-remote', orcaRole: 'worker' };
    mocks.getSessionFor.mockResolvedValue(workerSession);
    mocks.resolveSessionRoute.mockResolvedValue('/cc-agent/lead-remote?worker=worker-remote');

    render(<SecondaryWindowBootGate />);

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/lead-remote?worker=worker-remote', {
        replace: true,
      }),
    );
    expect(mocks.pinSessionOrigin).toHaveBeenCalledWith('device-remote', 'worker-remote');
    expect(mocks.getSessionFor).toHaveBeenCalledWith('worker-remote');
    expect(mocks.resolveSessionRoute).toHaveBeenCalledWith('worker-remote', workerSession);
    expect(mocks.pinSessionOrigin.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getSessionFor.mock.invocationCallOrder[0],
    );
    expect(mocks.getSessionFor.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.resolveSessionRoute.mock.invocationCallOrder[0],
    );
  });
});
