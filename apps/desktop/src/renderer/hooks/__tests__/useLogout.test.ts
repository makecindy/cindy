// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLogout } from '../useLogout';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  logout: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ logout: mocks.logout }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: mocks.toastError },
}));

describe('useLogout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not log out when confirmation is cancelled', async () => {
    mocks.confirm.mockResolvedValue(false);
    const { result } = renderHook(() => useLogout());

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(mocks.logout).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('logs out after confirmation without showing an error', async () => {
    mocks.confirm.mockResolvedValue(true);
    mocks.logout.mockResolvedValue(undefined);
    const { result } = renderHook(() => useLogout());

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('contains credential-store failures and shows a retryable fallback', async () => {
    mocks.confirm.mockResolvedValue(true);
    mocks.logout.mockRejectedValue(
      new Error('Error invoking remote method: Error: [CREDENTIAL_STORE_UNAVAILABLE] vault locked'),
    );
    const { result } = renderHook(() => useLogout());

    await act(async () => {
      await expect(result.current.handleLogout()).resolves.toBeUndefined();
    });

    expect(mocks.toastError).toHaveBeenCalledWith('ipcError.INTERNAL');
  });
});
