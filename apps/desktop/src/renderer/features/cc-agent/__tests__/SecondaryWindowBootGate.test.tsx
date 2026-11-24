// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBootDeviceId: vi.fn<() => string | null>(),
  getBootSessionId: vi.fn<() => string | null>(),
  getBootMessageClientId: vi.fn<() => string | null>(),
  getVisibleMergedRemoteSessions: vi.fn<() => Array<Record<string, unknown>>>(),
  invoke: vi.fn(),
  navigate: vi.fn(),
  pinSessionOrigin: vi.fn(),
  resolveSessionRoute: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('@/lib/secondaryWindow', () => ({
  getBootDeviceId: mocks.getBootDeviceId,
  getBootSessionId: mocks.getBootSessionId,
  getBootMessageClientId: mocks.getBootMessageClientId,
}));

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId: () => undefined,
  remoteProjectsStore: {
    getMergedRemoteSessions: mocks.getVisibleMergedRemoteSessions,
    getDeviceSessions: () => [],
    getVerifiedPinnedSessionDeviceId: () => undefined,
    getCreationPreview: () => undefined,
    getDeviceName: () => 'Host',
    captureSessionRead: () => Object.assign(() => true, { mergeActivity: (value: unknown) => value }),
    mergeDeviceSessions: vi.fn(),
    pinSessionOrigin: mocks.pinSessionOrigin,
  },
}));

vi.mock('@/lib/orcaSessionIdentity', () => ({
  getSessionRouteOwnerId: (route: string) => /^\/cc-agent\/([^/?#]+)/.exec(route)?.[1] ?? null,
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
    mocks.getBootMessageClientId.mockReturnValue(null);
    mocks.getVisibleMergedRemoteSessions.mockReset();
    mocks.invoke.mockReset().mockImplementation(async (_device: string, _channel: string, [id]: string[]) =>
      ({ id, orcaRole: id === 'worker-remote' ? 'worker' : 'lead' }));
    mocks.navigate.mockReset();
    mocks.pinSessionOrigin.mockReset();
    mocks.resolveSessionRoute.mockReset();
    mocks.getBootSessionId.mockReturnValue('worker-remote');
    mocks.getBootDeviceId.mockReturnValue('device-remote');
    mocks.getVisibleMergedRemoteSessions.mockReturnValue([]);
    vi.stubGlobal('electronAPI', {
      getDeviceId: async () => 'this-mac',
      localDb: { sessions: { get: async () => null } },
      deviceLink: { invoke: mocks.invoke },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // Unit regression: these sidebar targets have no local task row at window boot.
  it.each(['/bots/mate', '/bots/groups/group-1', '/bots/remote/mac/mate'])(
    'opens the dragged conversation %s directly in the secondary window',
    async target => {
      mocks.getBootSessionId.mockReturnValue(target);
      mocks.getBootDeviceId.mockReturnValue(null);
      render(<SecondaryWindowBootGate />);
      await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith(target, { replace: true }));
      expect(mocks.resolveSessionRoute).not.toHaveBeenCalled();
    },
  );

  it('checks both worker and lead on the named host before registering either', async () => {
    mocks.resolveSessionRoute.mockResolvedValue('/cc-agent/lead-remote?worker=worker-remote');

    render(<SecondaryWindowBootGate />);

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/lead-remote?worker=worker-remote', {
        replace: true,
      }),
    );
    expect(mocks.pinSessionOrigin).toHaveBeenCalledWith('device-remote', 'worker-remote');
    expect(mocks.pinSessionOrigin).toHaveBeenCalledWith('device-remote', 'lead-remote');
    expect(mocks.invoke.mock.calls).toEqual([
      ['device-remote', 'local-db:sessions:get', ['worker-remote']],
      ['device-remote', 'local-db:sessions:get', ['lead-remote']],
    ]);
    expect(mocks.invoke.mock.invocationCallOrder[1]).toBeLessThan(mocks.pinSessionOrigin.mock.invocationCallOrder[0]);
  });

  it('retains the message anchor through remote Worker routing and StrictMode effect replay', async () => {
    mocks.getBootMessageClientId.mockReturnValue('message/42');
    mocks.resolveSessionRoute.mockResolvedValue('/cc-agent/lead-remote?worker=worker-remote');
    render(
      <StrictMode>
        <SecondaryWindowBootGate />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(
        '/cc-agent/lead-remote?worker=worker-remote',
        {
          replace: true,
          state: {
            searchJump: {
              kind: 'conversation-search',
              sessionId: 'worker-remote',
              messageId: 'message/42',
              messageIdKind: 'clientId',
              messageClientId: 'message/42',
            },
          },
        },
      ),
    );
  });

  // The boot URL carries the same unchecked hint as the source chip. With
  // no host metadata, the new window exposes the entry failure without binding.
  it('shows an unavailable task without registering the hinted host', async () => {
    mocks.invoke.mockResolvedValue(null);
    render(<SecondaryWindowBootGate />);
    expect(await screen.findByText('ccAgent.sessionEntry.missing')).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.pinSessionOrigin).not.toHaveBeenCalled();
  });
});
