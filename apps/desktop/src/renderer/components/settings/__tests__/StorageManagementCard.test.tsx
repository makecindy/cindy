// @vitest-environment jsdom

import type { ReactElement } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render as testingLibraryRender,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({ toast }));
vi.mock('@/lib/composerDraftStore', () => ({ getAllDraftAttachmentUrls: () => [] }));

import { StorageManagementCard } from '../StorageManagementCard';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';

function render(ui: ReactElement) {
  return testingLibraryRender(
    <ConfirmDialogProvider>
      {ui}
    </ConfirmDialogProvider>,
  );
}

type StorageStatsResult = Awaited<ReturnType<typeof window.electronAPI.cindyMediaStorage.stats>>;

function storageApi() {
  return {
    reportDraftUrls: vi.fn(),
    openLegacyImagesDir: vi.fn(async () => ({ opened: true })),
    clearLegacyImagesDir: vi.fn(async () => ({ cleared: true })),
    openChatAttachmentsDir: vi.fn(async () => ({ opened: true })),
    clearChatAttachmentsDir: vi.fn(async () => ({ cleared: true })),
    stats: vi.fn(async (): Promise<StorageStatsResult> => ({
      success: true,
      blobs: { totalCount: 0, totalBytes: 0, cacheCount: 0, cacheBytes: 0 },
      legacy: { bytes: 0, fileCount: 0 },
      fixedCaches: {
        legacyImages: { bytes: 0, fileCount: 0 },
        chatAttachments: { bytes: 0, fileCount: 0 },
      },
      deadDirs: [],
    })),
    scan: vi.fn(),
    cleanup: vi.fn(),
    reconcile: vi.fn(),
  };
}

function maintenanceApi() {
  return {
    getLastResult: vi.fn(async () => null),
    scan: vi.fn(async (input: {
      archiveAgeMonths: '7-days' | 1 | 3 | 6;
      includeActiveTasks?: boolean;
    }) => ({
      scanId: 'scan-1',
      archiveAgeMonths: input.archiveAgeMonths,
      includeActiveTasks: input.includeActiveTasks === true,
      scannedAt: 1_000,
      archivedBeforeMs: 500,
      activeTaskCount: input.includeActiveTasks ? 4 : 0,
      deletedTaskCount: 1,
      archivedTaskCount: 2,
      messageCount: 3,
      estimatedMessageBytes: 100,
      databaseBytes: 1_000,
      temporaryBytesRequired: 2_000,
      databaseVolumeFreeBytes: 10_000,
    })),
    chooseBackupDirectory: vi.fn(async () => ({
      selected: true as const,
      grantId: 'directory-grant',
      displayPath: 'D:\\Backups',
    })),
    schedule: vi.fn(async () => ({ scheduled: true as const })),
    openLastBackupDirectory: vi.fn(async () => ({ opened: true })),
  };
}

function databaseSizeWarningApi() {
  return {
    getStatus: vi.fn(async () => ({ databaseBytes: 0 })),
    measure: vi.fn(async () => ({ databaseBytes: 0 })),
    getSettings: vi.fn(async () => ({
      thresholdGiB: 10,
      disabled: false,
      isCustomized: false,
      defaultThresholdGiB: 10,
    })),
    setSettings: vi.fn(async (patch: { thresholdGiB?: number; disabled?: boolean }) => ({
      thresholdGiB: patch.thresholdGiB ?? 10,
      disabled: patch.disabled ?? false,
      isCustomized: true,
      defaultThresholdGiB: 10,
    })),
    resetSettings: vi.fn(async () => ({
      thresholdGiB: 10,
      disabled: false,
      isCustomized: false,
      defaultThresholdGiB: 10,
    })),
    onChanged: vi.fn(() => () => undefined),
  };
}

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  toast.info.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      cindyMediaStorage: storageApi(),
      localDb: { maintenance: maintenanceApi(), databaseSizeWarning: databaseSizeWarningApi() },
    },
  });
});

afterEach(cleanup);

describe('StorageManagementCard fixed cache directories', () => {
  it('renders both directory actions without scanning either directory', async () => {
    render(<StorageManagementCard />);

    await waitFor(() => {
      expect(window.electronAPI.cindyMediaStorage.stats).toHaveBeenCalledWith();
    });
    expect(
      screen.getByRole('button', { name: 'settings.about.storage.legacyImagesOpenButton' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'settings.about.storage.legacyImagesClearButton' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'settings.about.storage.chatAttachmentsOpenButton' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'settings.about.storage.chatAttachmentsClearButton' }),
    ).toBeTruthy();
    expect(window.electronAPI.cindyMediaStorage.scan).not.toHaveBeenCalled();
    expect(window.electronAPI.cindyMediaStorage.cleanup).not.toHaveBeenCalled();
  });

  it('refreshes storage stats only when the refresh button is requested', async () => {
    render(<StorageManagementCard />);

    await waitFor(() => {
      expect(window.electronAPI.cindyMediaStorage.stats).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.refreshStatsButton' }),
    );

    await waitFor(() => {
      expect(window.electronAPI.cindyMediaStorage.stats).toHaveBeenCalledTimes(2);
    });
  });

  it('shows unknown storage values when a manual refresh fails', async () => {
    const api = storageApi();
    vi.mocked(api.stats).mockRejectedValueOnce(new Error('stats unavailable'));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        cindyMediaStorage: api,
        localDb: { maintenance: maintenanceApi(), databaseSizeWarning: databaseSizeWarningApi() },
      },
    });
    render(<StorageManagementCard />);

    await waitFor(() => {
      expect(screen.getByText('settings.about.storage.unknown')).toBeTruthy();
      expect(screen.getByText('settings.about.storage.statsFailed')).toBeTruthy();
    });
  });

  it('queues a refresh requested while the current refresh is running', async () => {
    let resolveStats!: (value: StorageStatsResult) => void;
    const api = storageApi();
    vi.mocked(api.stats).mockImplementationOnce(
      () => new Promise((resolve) => { resolveStats = resolve; }),
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        cindyMediaStorage: api,
        localDb: { maintenance: maintenanceApi(), databaseSizeWarning: databaseSizeWarningApi() },
      },
    });
    render(<StorageManagementCard />);

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.legacyImagesClearButton' }),
    );
    expect(api.stats).toHaveBeenCalledTimes(1);
    resolveStats({
      success: true,
      blobs: { totalCount: 0, totalBytes: 0, cacheCount: 0, cacheBytes: 0 },
      legacy: { bytes: 0, fileCount: 0 },
      fixedCaches: {
        legacyImages: { bytes: 0, fileCount: 0 },
        chatAttachments: { bytes: 0, fileCount: 0 },
      },
      deadDirs: [],
    });
    await waitFor(() => expect(api.stats).toHaveBeenCalledTimes(2));
  });

  it('shows unknown storage values when stats returns a business failure', async () => {
    const api = storageApi();
    vi.mocked(api.stats).mockResolvedValueOnce({
      success: false,
      blobs: { totalCount: 0, totalBytes: 0, cacheCount: 0, cacheBytes: 0 },
      legacy: { bytes: 0, fileCount: 0 },
      fixedCaches: {
        legacyImages: { bytes: 0, fileCount: 0 },
        chatAttachments: { bytes: 0, fileCount: 0 },
      },
      deadDirs: [],
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        cindyMediaStorage: api,
        localDb: { maintenance: maintenanceApi(), databaseSizeWarning: databaseSizeWarningApi() },
      },
    });
    render(<StorageManagementCard />);

    await waitFor(() => {
      expect(screen.getByText('settings.about.storage.unknown')).toBeTruthy();
      expect(screen.getByText('settings.about.storage.statsFailed')).toBeTruthy();
    });
  });

  it('treats a null database measurement as a failed statistic', async () => {
    vi.mocked(window.electronAPI.localDb.databaseSizeWarning.measure).mockResolvedValue({
      databaseBytes: null,
    });
    render(<StorageManagementCard />);

    await waitFor(() => {
      expect(screen.getByText('settings.about.storage.statsFailed')).toBeTruthy();
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();
    });
  });

  it('restores the persisted threshold when saving a new threshold fails', async () => {
    const warningApi = databaseSizeWarningApi();
    vi.mocked(warningApi.setSettings).mockRejectedValueOnce(new Error('write failed'));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        cindyMediaStorage: storageApi(),
        localDb: { maintenance: maintenanceApi(), databaseSizeWarning: warningApi },
      },
    });
    render(<StorageManagementCard />);

    const input = await screen.findByRole('spinbutton', {
      name: 'settings.about.storage.dbSizeWarningThresholdLabel',
    });
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('10');
    });
  });

  it('compares only database bytes with the reminder threshold', async () => {
    vi.mocked(window.electronAPI.localDb.databaseSizeWarning.measure).mockResolvedValue({
      databaseBytes: 1024 ** 3,
    });
    vi.mocked(window.electronAPI.cindyMediaStorage.stats).mockResolvedValue({
      success: true,
      blobs: { totalCount: 1, totalBytes: 20 * 1024 ** 3, cacheCount: 1, cacheBytes: 20 * 1024 ** 3 },
      legacy: { bytes: 0, fileCount: 0 },
      fixedCaches: {
        legacyImages: { bytes: 2 * 1024 ** 3, fileCount: 2 },
        chatAttachments: { bytes: 3 * 1024 ** 3, fileCount: 3 },
      },
      deadDirs: [],
    });
    render(<StorageManagementCard />);

    await waitFor(() => {
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('10');
      expect(screen.getByText('26.00 GB')).toBeTruthy();
    });
  });

  it('keeps database usage known when media statistics fail', async () => {
    vi.mocked(window.electronAPI.localDb.databaseSizeWarning.measure).mockResolvedValue({
      databaseBytes: 2 * 1024 ** 3,
    });
    vi.mocked(window.electronAPI.cindyMediaStorage.stats).mockRejectedValue(new Error('unavailable'));
    render(<StorageManagementCard />);

    await waitFor(() => {
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('20');
      expect(screen.getByText('settings.about.storage.statsFailed')).toBeTruthy();
    });
  });

  it('does not save on Enter, but persists when the threshold field loses focus', async () => {
    render(<StorageManagementCard />);
    await waitFor(() => {
      expect(window.electronAPI.localDb.databaseSizeWarning.getSettings).toHaveBeenCalled();
    });
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(window.electronAPI.localDb.databaseSizeWarning.setSettings).not.toHaveBeenCalled();

    fireEvent.blur(input);
    await waitFor(() => {
      expect(window.electronAPI.localDb.databaseSizeWarning.setSettings).toHaveBeenCalledWith({
        thresholdGiB: 20,
      });
    });
  });

  it('keeps reset clickable after a threshold blur queues persistence', async () => {
    const api = window.electronAPI.localDb.databaseSizeWarning;
    vi.mocked(api.getSettings).mockResolvedValue({
      thresholdGiB: 25, disabled: false, isCustomized: true, defaultThresholdGiB: 10,
    });
    render(<StorageManagementCard />);
    const input = await screen.findByRole('spinbutton');
    const reset = await screen.findByRole('button', { name: 'settings.defaults.restore' });
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.blur(input);
    fireEvent.click(reset);

    await waitFor(() => expect(api.resetSettings).toHaveBeenCalledOnce());
  });

  it('restores warning overrides using the defaults returned by Main', async () => {
    const api = window.electronAPI.localDb.databaseSizeWarning;
    vi.mocked(api.getSettings).mockResolvedValue({
      thresholdGiB: 25, disabled: true, isCustomized: true, defaultThresholdGiB: 12,
    });
    vi.mocked(api.resetSettings).mockResolvedValue({
      thresholdGiB: 12, disabled: false, isCustomized: false, defaultThresholdGiB: 12,
    });
    render(<StorageManagementCard />);
    const reset = screen.getByRole('button', { name: 'settings.defaults.restore' });
    await waitFor(() => expect((reset as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(reset);

    await waitFor(() => {
      expect(api.resetSettings).toHaveBeenCalledOnce();
      expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('12');
      expect(screen.getByRole('switch', {
        name: 'settings.about.storage.dbSizeWarningDisableLabel',
      }).getAttribute('aria-checked')).toBe('false');
      expect((reset as HTMLButtonElement).disabled).toBe(true);
    });
    expect(api.setSettings).not.toHaveBeenCalled();
  });

  it('preserves warning settings and shows a localized error when reset fails', async () => {
    const api = window.electronAPI.localDb.databaseSizeWarning;
    vi.mocked(api.getSettings).mockResolvedValue({
      thresholdGiB: 25, disabled: true, isCustomized: true, defaultThresholdGiB: 10,
    });
    vi.mocked(api.resetSettings).mockRejectedValue(new Error('[INTERNAL] failed to reset settings'));
    render(<StorageManagementCard />);
    const reset = screen.getByRole('button', { name: 'settings.defaults.restore' });
    await waitFor(() => expect((reset as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(reset);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('ipcError.INTERNAL'));
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('25');
    expect((reset as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens the fixed legacy image directory through the dedicated API', async () => {
    render(<StorageManagementCard />);

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.legacyImagesOpenButton' }),
    );

    await waitFor(() => {
      expect(window.electronAPI.cindyMediaStorage.openLegacyImagesDir).toHaveBeenCalledWith();
    });
  });

  it('reports when Main cannot open the fixed legacy directory', async () => {
    vi.mocked(window.electronAPI.cindyMediaStorage.openLegacyImagesDir).mockResolvedValue({
      opened: false,
    });
    render(<StorageManagementCard />);

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.legacyImagesOpenButton' }),
    );

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith(
        'settings.about.storage.legacyImagesDirectoryMissing',
      );
    });
  });

  it('opens the fixed chat attachment directory through the dedicated API', async () => {
    render(<StorageManagementCard />);

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.chatAttachmentsOpenButton' }),
    );

    await waitFor(() => {
      expect(window.electronAPI.cindyMediaStorage.openChatAttachmentsDir).toHaveBeenCalledWith();
    });
  });

  it('requests image cache cleanup through the privileged API', async () => {
    render(<StorageManagementCard />);

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.legacyImagesClearButton' }),
    );

    await waitFor(() => {
      expect(window.electronAPI.cindyMediaStorage.clearLegacyImagesDir).toHaveBeenCalledWith();
      expect(toast.success).toHaveBeenCalledWith('settings.about.storage.legacyImagesCleared');
    });
  });

  it('does not report success when native confirmation is cancelled', async () => {
    vi.mocked(window.electronAPI.cindyMediaStorage.clearChatAttachmentsDir).mockResolvedValue({
      cleared: false,
    });
    render(<StorageManagementCard />);

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.chatAttachmentsClearButton' }),
    );

    await waitFor(() => {
      expect(window.electronAPI.cindyMediaStorage.clearChatAttachmentsDir).toHaveBeenCalledWith();
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('clears the chat attachment cache without passing a path', async () => {
    render(<StorageManagementCard />);

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.chatAttachmentsClearButton' }),
    );

    await waitFor(() => {
      expect(window.electronAPI.cindyMediaStorage.clearChatAttachmentsDir).toHaveBeenCalledWith();
      expect(toast.success).toHaveBeenCalledWith('settings.about.storage.chatAttachmentsCleared');
    });
  });
});

describe('StorageManagementCard database cleanup', () => {
  it('maps serialized IPC scan failures to localized messages', async () => {
    vi.mocked(window.electronAPI.localDb.maintenance.scan).mockRejectedValueOnce(
      new Error(
        'Error invoking remote method: Error: [PRECONDITION_FAILED] active database owner changed',
      ),
    );
    render(<StorageManagementCard />);

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.dbSlimmingScanButton' }),
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('ipcError.PRECONDITION_FAILED');
    });
    expect(toast.error).not.toHaveBeenCalledWith(
      expect.stringContaining('active database owner changed'),
    );
  });

  it('maps serialized IPC scheduling failures to localized messages', async () => {
    vi.mocked(window.electronAPI.localDb.maintenance.schedule).mockRejectedValueOnce(
      new Error(
        'Error invoking remote method: Error: [PRECONDITION_FAILED] active database owner changed',
      ),
    );
    render(<StorageManagementCard />);

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.dbSlimmingScanButton' }),
    );
    await screen.findByRole('alertdialog', {
      name: 'settings.about.storage.dbSlimmingScanResultTitle',
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.dbSlimmingConfirmButton' }),
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('ipcError.PRECONDITION_FAILED');
    });
    expect(toast.error).not.toHaveBeenCalledWith(
      expect.stringContaining('active database owner changed'),
    );
  });

  it('offers only 7 days, 1 month, 3 months, and 6 months, defaulting to 7 days', async () => {
    render(<StorageManagementCard />);

    const threshold = screen.getByRole('combobox');
    expect(threshold.textContent).toContain(
      'settings.about.storage.dbSlimmingArchiveAgeOption7Days',
    );
    fireEvent.click(threshold);
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'settings.about.storage.dbSlimmingArchiveAgeOption7Days',
      'settings.about.storage.dbSlimmingArchiveAgeOption1',
      'settings.about.storage.dbSlimmingArchiveAgeOption3',
      'settings.about.storage.dbSlimmingArchiveAgeOption6',
    ]);
    fireEvent.click(options[0]!);
    expect(
      screen
        .getByRole('switch', { name: 'settings.about.storage.dbSlimmingBackupLabel' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(screen.getByText('settings.about.storage.dbSlimmingBackupLabel'));
    expect(
      screen
        .getByRole('switch', { name: 'settings.about.storage.dbSlimmingBackupLabel' })
        .getAttribute('aria-checked'),
    ).toBe('false');
    fireEvent.click(screen.getByText('settings.about.storage.dbSlimmingBackupLabel'));
    const scanButton = screen.getByRole('button', {
      name: 'settings.about.storage.dbSlimmingScanButton',
    });
    fireEvent.click(scanButton);

    await waitFor(() => {
      expect(window.electronAPI.localDb.maintenance.scan).toHaveBeenCalledWith({
        archiveAgeMonths: '7-days',
        includeActiveTasks: false,
      });
    });
    await waitFor(() => expect(scanButton.getAttribute('aria-busy')).toBeNull());
    expect(
      await screen.findByRole('alertdialog', {
        name: 'settings.about.storage.dbSlimmingScanResultTitle',
      }),
    ).toBeTruthy();
  });

  it('keeps active-task cleanup off until the warning is confirmed', async () => {
    render(<StorageManagementCard />);

    const activeSwitch = screen.getByRole('switch', {
      name: 'settings.about.storage.dbSlimmingIncludeActiveLabel',
    });
    expect(activeSwitch.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(activeSwitch);
    const warning = await screen.findByRole('alertdialog', {
      name: 'settings.about.storage.dbSlimmingIncludeActiveConfirmTitle',
    });
    expect(activeSwitch.getAttribute('aria-checked')).toBe('false');
    const confirmButton = screen.getByRole('button', {
      name: 'settings.about.storage.dbSlimmingIncludeActiveConfirmButton',
    });
    await waitFor(() => expect(document.activeElement).toBe(confirmButton));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.about.storage.dbSlimmingIncludeActiveCancelButton',
      }),
    );
    await waitFor(() => expect(warning.getAttribute('data-state')).toBe('closed'));
    expect(activeSwitch.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(activeSwitch);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.about.storage.dbSlimmingIncludeActiveConfirmButton',
      }),
    );
    await waitFor(() => expect(activeSwitch.getAttribute('aria-checked')).toBe('true'));

    fireEvent.click(activeSwitch);
    expect(activeSwitch.getAttribute('aria-checked')).toBe('false');
    expect(
      screen.queryByRole('alertdialog', {
        name: 'settings.about.storage.dbSlimmingIncludeActiveConfirmTitle',
      }),
    ).toBeNull();

    fireEvent.click(activeSwitch);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.about.storage.dbSlimmingIncludeActiveConfirmButton',
      }),
    );
    await waitFor(() => expect(activeSwitch.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.dbSlimmingScanButton' }),
    );

    await waitFor(() => {
      expect(window.electronAPI.localDb.maintenance.scan).toHaveBeenCalledWith({
        archiveAgeMonths: '7-days',
        includeActiveTasks: true,
      });
    });
    expect(
      await screen.findByText('settings.about.storage.dbSlimmingReportTasksWithActive'),
    ).toBeTruthy();
  });

  it('locks the full window while a database scan is running, then shows results in a dialog', async () => {
    let resolveScan!: (value: Awaited<ReturnType<ReturnType<typeof maintenanceApi>['scan']>>) => void;
    vi.mocked(window.electronAPI.localDb.maintenance.scan).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve;
        }),
    );
    render(<StorageManagementCard />);

    const scanButton = screen.getByRole('button', {
      name: 'settings.about.storage.dbSlimmingScanButton',
    });
    fireEvent.click(scanButton);

    await waitFor(() => {
      expect(scanButton.getAttribute('aria-busy')).toBe('true');
      expect((scanButton as HTMLButtonElement).disabled).toBe(true);
    });
    const persistentDialog = screen.getByRole('alertdialog', {
      name: 'settings.about.storage.dbSlimmingScanLoading',
    });
    expect(persistentDialog.className).not.toContain('animate-confirm');
    expect(persistentDialog.parentElement?.className ?? '').not.toContain('animate-confirm');
    expect(document.body.dataset.appInteractionLocked).toBe('1');

    await act(async () => {
      resolveScan({
        scanId: 'scan-busy',
        archiveAgeMonths: '7-days',
        includeActiveTasks: false,
        scannedAt: 1_000,
        archivedBeforeMs: 500,
        activeTaskCount: 0,
        deletedTaskCount: 1,
        archivedTaskCount: 2,
        messageCount: 3,
        estimatedMessageBytes: 100,
        databaseBytes: 1_000,
        temporaryBytesRequired: 2_000,
        databaseVolumeFreeBytes: 10_000,
      });
    });
    await waitFor(() => expect((scanButton as HTMLButtonElement).disabled).toBe(false));
    const report = await screen.findByText('settings.about.storage.dbSlimmingReportTasks');
    const resultDialog = report.closest('[role="alertdialog"]');
    expect(resultDialog).toBe(persistentDialog);
    const confirmButton = screen.getByRole('button', {
      name: 'settings.about.storage.dbSlimmingConfirmButton',
    });
    await waitFor(() => expect(document.activeElement).toBe(confirmButton));
    expect(
      screen.queryByRole('alertdialog', {
        name: 'settings.about.storage.dbSlimmingScanLoading',
      }),
    ).toBeNull();
    expect(document.body.dataset.appInteractionLocked).toBe('1');
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.cancelButton' }),
    );
    await waitFor(() => expect(document.body.dataset.appInteractionLocked).toBeUndefined());
  });

  it('passes only main-issued scan and directory grants and stays locked while restarting', async () => {
    render(<StorageManagementCard />);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.about.storage.dbSlimmingChooseDirectoryButton',
      }),
    );
    await waitFor(() => {
      expect(window.electronAPI.localDb.maintenance.chooseBackupDirectory).toHaveBeenCalledWith();
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.dbSlimmingScanButton' }),
    );
    await screen.findByText('settings.about.storage.dbSlimmingReportTasks');
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.dbSlimmingConfirmButton' }),
    );

    await waitFor(() => {
      expect(window.electronAPI.localDb.maintenance.schedule).toHaveBeenCalledWith({
        scanId: 'scan-1',
        backupEnabled: true,
        backupDirectoryGrantId: 'directory-grant',
      });
    });
    expect(
      await screen.findByRole('alertdialog', {
        name: 'settings.about.storage.dbSlimmingExecutionLoading',
      }),
    ).toBeTruthy();
    expect(document.body.dataset.appInteractionLocked).toBe('1');
  });

  it('restores the locked scan result when restart scheduling is cancelled', async () => {
    vi.mocked(window.electronAPI.localDb.maintenance.schedule).mockResolvedValueOnce({
      scheduled: false,
    });
    render(<StorageManagementCard />);

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.dbSlimmingScanButton' }),
    );
    await screen.findByRole('alertdialog', {
      name: 'settings.about.storage.dbSlimmingScanResultTitle',
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.dbSlimmingConfirmButton' }),
    );

    await waitFor(() => {
      expect(window.electronAPI.localDb.maintenance.schedule).toHaveBeenCalledWith({
        scanId: 'scan-1',
        backupEnabled: true,
      });
      expect(
        screen.queryByRole('alertdialog', {
          name: 'settings.about.storage.dbSlimmingExecutionLoading',
        }),
      ).toBeNull();
    });
    expect(
      await screen.findByRole('alertdialog', {
        name: 'settings.about.storage.dbSlimmingScanResultTitle',
      }),
    ).toBeTruthy();
    expect(document.body.dataset.appInteractionLocked).toBe('1');
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.cancelButton' }),
    );
    await waitFor(() => expect(document.body.dataset.appInteractionLocked).toBeUndefined());
  });
});
