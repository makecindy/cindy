// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/toast', () => ({ toast }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useUpdateStatus', () => ({ useUpdateStatus: () => ({ status: 'idle' }) }));
vi.mock('@/hooks/useUpdateBannerDismiss', () => ({
  useUpdateBannerDismiss: () => ({ dismissed: false }),
}));

import { DatabaseSizeWarningBanner } from '../DatabaseSizeWarningBanner';

beforeEach(() => {
  toast.error.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      localDb: {
        databaseSizeWarning: {
          getSettings: vi.fn(async () => ({ thresholdGiB: 10, disabled: false })),
          getStatus: vi.fn(async () => ({ databaseBytes: 11 * 1024 ** 3 })),
          onChanged: vi.fn(() => vi.fn()),
          setSettings: vi.fn(async () => ({ thresholdGiB: 10, disabled: true })),
        },
      },
    },
  });
});
afterEach(cleanup);

describe('DatabaseSizeWarningBanner save errors', () => {
  it.each([
    [new Error('[INTERNAL] failed to save database size warning settings'), 'settings.about.storage.dbSizeWarningSaveFailed'],
    [new Error('IPC disconnected'), 'settings.about.storage.dbSizeWarningSaveFailed'],
    [new Error('[INVALID_PARAMS] invalid payload'), 'ipcError.INVALID_PARAMS'],
  ])('keeps the banner visible and maps %s to the right error', async (error, messageKey) => {
    const api = window.electronAPI.localDb.databaseSizeWarning;
    vi.mocked(api.setSettings).mockRejectedValueOnce(error);
    render(<DatabaseSizeWarningBanner isCollapsed={false} />);
    const disable = await screen.findByRole('button', { name: 'sidebar.databaseSizeWarning.disable' });
    fireEvent.click(disable);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(messageKey));
    expect(screen.getByRole('status')).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalledWith('settings.about.storage.statsFailed');

    fireEvent.click(disable);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});
