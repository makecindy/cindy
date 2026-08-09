// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: {
    canEnterApp: true,
    dataOwnerId: 'owner-a' as string | null,
    mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
  },
  confirm: vi.fn(),
  recoveryStatus: vi.fn(),
  resolveRecovery: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));
vi.mock('@/lib/toast', () => ({
  toast: { info: mocks.toastInfo, error: mocks.toastError },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: mocks.warn }),
}));

import { PluginRecoveryPromptHost } from '../PluginRecoveryPromptHost';

const proposal = {
  proposalId: 'a'.repeat(64),
  candidates: [
    {
      candidateId: 'b'.repeat(64),
      pluginId: `c${'c'.repeat(24)}`,
      ghostId: 'cindy-test',
      name: 'Test Plugin',
      version: '1.0.0',
      sourceType: 'server' as const,
    },
  ],
};

describe('PluginRecoveryPromptHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.canEnterApp = true;
    mocks.auth.dataOwnerId = 'owner-a';
    mocks.auth.mode = 'cloud';
    mocks.recoveryStatus.mockResolvedValue({ state: 'pending', proposal });
    mocks.confirm.mockResolvedValue(true);
    mocks.resolveRecovery.mockResolvedValue({
      status: { state: 'none', proposal: null },
      restoredCount: 1,
      reviewCount: 0,
    });
    mocks.subscribe.mockReturnValue(mocks.unsubscribe);
    (
      window as unknown as {
        electronAPI: {
          pluginMarket: {
            recoveryStatus: typeof mocks.recoveryStatus;
            resolveRecovery: typeof mocks.resolveRecovery;
            onRecoveryAvailable: typeof mocks.subscribe;
          };
        };
      }
    ).electronAPI = {
      pluginMarket: {
        recoveryStatus: mocks.recoveryStatus,
        resolveRecovery: mocks.resolveRecovery,
        onRecoveryAvailable: mocks.subscribe,
      },
    };
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

  it('requires an explicit choice and resolves only the opaque Main proposal', async () => {
    const resolvedEvent = vi.fn();
    window.addEventListener('plugin-market:recovery-resolved', resolvedEvent);
    render(<PluginRecoveryPromptHost />);

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    const options = mocks.confirm.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      requireExplicitChoice: true,
      confirmText: 'settings.ghosts.recovery.prompt.restore',
      cancelText: 'settings.ghosts.recovery.prompt.keep',
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    await waitFor(() =>
      expect(mocks.resolveRecovery).toHaveBeenCalledWith(proposal.proposalId, 'restore'),
    );
    expect(resolvedEvent).toHaveBeenCalledTimes(1);
    window.removeEventListener('plugin-market:recovery-resolved', resolvedEvent);
  });

  it('aborts an open owner-scoped decision when the active owner changes', async () => {
    mocks.confirm.mockImplementation(() => new Promise<boolean>(() => undefined));
    const view = render(<PluginRecoveryPromptHost />);
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    const signal = mocks.confirm.mock.calls[0]?.[0].signal as AbortSignal;

    mocks.auth.dataOwnerId = 'owner-b';
    mocks.recoveryStatus.mockResolvedValueOnce({ state: 'none', proposal: null });
    view.rerender(<PluginRecoveryPromptHost />);

    expect(signal.aborted).toBe(true);
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
