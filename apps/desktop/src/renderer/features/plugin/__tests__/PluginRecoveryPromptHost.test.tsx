// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: {
    canEnterApp: true,
    dataOwnerId: 'owner-a' as string | null,
    mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
  },
  recoveryStatus: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  toastWarning: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/lib/toast', () => ({ toast: { warning: mocks.toastWarning } }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: mocks.warn }) }));

import { PluginRecoveryPromptHost } from '../PluginRecoveryPromptHost';

const proposal = {
  proposalId: 'a'.repeat(64),
  counts: { ready: 1, review: 0, deferred: 0 },
  totalCount: 1,
  truncated: false,
  notificationMuted: false,
  candidates: [
    {
      candidateId: 'b'.repeat(64),
      pluginId: `c${'c'.repeat(24)}`,
      ghostId: 'cindy-test',
      name: 'Test Plugin',
      version: '1.0.0',
      sourceType: 'server' as const,
      readiness: 'ready' as const,
      reason: 'exact-match' as const,
    },
  ],
};

describe('PluginRecoveryPromptHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.canEnterApp = true;
    mocks.auth.dataOwnerId = `owner-${Math.random()}`;
    mocks.auth.mode = 'cloud';
    mocks.recoveryStatus.mockResolvedValue({ state: 'pending', proposal });
    mocks.subscribe.mockReturnValue(mocks.unsubscribe);
    Object.assign(window, {
      electronAPI: {
        pluginMarket: {
          recoveryStatus: mocks.recoveryStatus,
          onRecoveryAvailable: mocks.subscribe,
        },
      },
    });
  });

  afterEach(() => cleanup());

  it('does not query or subscribe before a stable owner can enter the app', () => {
    mocks.auth.canEnterApp = false;
    mocks.auth.dataOwnerId = null;
    mocks.auth.mode = 'signed-out';
    render(<PluginRecoveryPromptHost />);
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(mocks.recoveryStatus).not.toHaveBeenCalled();
  });

  it('shows a non-blocking reminder only once for repeated signals', async () => {
    render(<PluginRecoveryPromptHost />);
    await waitFor(() => expect(mocks.toastWarning).toHaveBeenCalledTimes(1));
    const listener = mocks.subscribe.mock.calls[0]?.[0] as () => void;
    listener();
    listener();
    await waitFor(() => expect(mocks.recoveryStatus).toHaveBeenCalled());
    expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
  });

  it('does not remind when the owner muted recovery notifications', async () => {
    mocks.recoveryStatus.mockResolvedValue({
      state: 'pending',
      proposal: { ...proposal, notificationMuted: true },
    });
    render(<PluginRecoveryPromptHost />);
    await waitFor(() => expect(mocks.recoveryStatus).toHaveBeenCalledTimes(1));
    expect(mocks.toastWarning).not.toHaveBeenCalled();
  });
});
