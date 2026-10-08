// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderShareSettledEvent } from '../../../../shared/providerShare';
import { ProviderShareApplyDialog, isProviderShareRequestTrackedByDialog } from '../ProviderShareApplyDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const preview = {
  shareId: 'share-1',
  providerId: 'xd',
  providerLabel: 'Cindy AI',
  deviceName: "Magi's Mac Mini",
  owner: { displayName: 'Magi', avatarUrl: null, region: 'global' as const },
  state: 'unused' as const,
  expiresAt: '2026-10-07T10:05:00Z',
};

const state = vi.hoisted(() => ({
  command: vi.fn(),
  settledListeners: new Set<(event: ProviderShareSettledEvent) => void>(),
}));

function ipcError(code: string): Error {
  return new Error(`Error invoking remote method: Error: [${code}] boom`);
}

beforeEach(() => {
  state.command.mockReset();
  state.settledListeners.clear();
  Object.assign(window, {
    electronAPI: {
      providerShare: {
        command: state.command,
        onSettled: (cb: (event: ProviderShareSettledEvent) => void) => {
          state.settledListeners.add(cb);
          return () => state.settledListeners.delete(cb);
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
});

function renderDialog(onClose = vi.fn(), onNewTask = vi.fn()) {
  render(<ProviderShareApplyDialog link="https://x.test/provider-share/join#abc" onClose={onClose} onNewTask={onNewTask} />);
  return { onClose, onNewTask };
}

function dialogState(): string | null {
  return document.querySelector('[data-apply-state]')?.getAttribute('data-apply-state') ?? null;
}

describe('ProviderShareApplyDialog', () => {
  it('asks first, sends only on confirm, then shows the pairing code and the approval', async () => {
    state.command.mockImplementation(async (command: { action: string }) => {
      if (command.action === 'preview') return preview;
      if (command.action === 'send-request') {
        return { requestId: 'req-1', status: 'pending', pairingCode: '4827', expiresAt: '2026-10-08T10:00:00Z' };
      }
      throw new Error('unexpected');
    });
    const { onNewTask } = renderDialog();

    await waitFor(() => expect(dialogState()).toBe('ask'));
    expect(state.command).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/providerShare\.apply\.askTitle/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'providerShare.apply.send' }));
    await waitFor(() => expect(dialogState()).toBe('wait'));
    expect(state.command).toHaveBeenLastCalledWith({ action: 'send-request', link: 'https://x.test/provider-share/join#abc' });
    expect(screen.getByTestId('provider-share-pairing-code').textContent).toBe('4827');
    expect(isProviderShareRequestTrackedByDialog('req-1')).toBe(true);

    act(() => {
      for (const listener of state.settledListeners) {
        listener({ state: { requestId: 'req-1', status: 'approved', pairingCode: '4827', expiresAt: '2026-10-08T10:00:00Z' }, preview });
      }
    });
    await waitFor(() => expect(dialogState()).toBe('done'));
    expect(screen.getByText(/providerShare\.apply\.doneDescription/)).toBeTruthy();
    expect(isProviderShareRequestTrackedByDialog('req-1')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'providerShare.apply.newTask' }));
    expect(onNewTask).toHaveBeenCalledTimes(1);
  });

  it('cancel closes without sending a request', async () => {
    state.command.mockResolvedValue(preview);
    const { onClose } = renderDialog();
    await waitFor(() => expect(dialogState()).toBe('ask'));
    fireEvent.click(screen.getByRole('button', { name: 'providerShare.apply.cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(state.command).toHaveBeenCalledTimes(1);
  });

  it('shows the invalid-link state for used or expired previews', async () => {
    state.command.mockResolvedValue({ ...preview, state: 'used' });
    renderDialog();
    await waitFor(() => expect(dialogState()).toBe('used'));
    expect(screen.queryByRole('button', { name: 'providerShare.apply.send' })).toBeNull();
  });

  it.each([
    ['PROVIDER_SHARE_LINK_EXPIRED', 'used'],
    ['PROVIDER_SHARE_SELF', 'self'],
    ['PROVIDER_SHARE_ALREADY_MEMBER', 'member'],
    ['REGION_MISMATCH', 'region'],
    ['PROVIDER_SHARE_CROSS_REGION_DISABLED', 'region'],
    ['INVALID_PARAMS', 'invalid'],
    ['DEVICE_LINK_NOT_CONNECTED', 'error'],
  ])('maps %s to the %s state', async (code, expected) => {
    state.command.mockRejectedValue(ipcError(code));
    renderDialog();
    await waitFor(() => expect(dialogState()).toBe(expected));
  });

  it('withdraws a pending request and closes', async () => {
    state.command.mockImplementation(async (command: { action: string }) => {
      if (command.action === 'preview') return preview;
      if (command.action === 'send-request') {
        return { requestId: 'req-2', status: 'pending', pairingCode: '1234', expiresAt: '2026-10-08T10:00:00Z' };
      }
      if (command.action === 'withdraw') return { ok: true };
      throw new Error('unexpected');
    });
    const { onClose } = renderDialog();
    await waitFor(() => expect(dialogState()).toBe('ask'));
    fireEvent.click(screen.getByRole('button', { name: 'providerShare.apply.send' }));
    await waitFor(() => expect(dialogState()).toBe('wait'));
    fireEvent.click(screen.getByRole('button', { name: 'providerShare.apply.withdraw' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(state.command).toHaveBeenLastCalledWith({ action: 'withdraw', requestId: 'req-2' });
    const { toast } = await import('@/lib/toast');
    expect(toast.success).toHaveBeenCalledWith('providerShare.apply.withdrawn');
  });
});
