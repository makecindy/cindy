// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function storageApi() {
  return {
    reportDraftUrls: vi.fn(),
    openLegacyImagesDir: vi.fn(async () => ({ opened: true })),
    clearLegacyImagesDir: vi.fn(async () => ({ cleared: true })),
    openChatAttachmentsDir: vi.fn(async () => ({ opened: true })),
    clearChatAttachmentsDir: vi.fn(async () => ({ cleared: true })),
    stats: vi.fn(async () => ({
      success: true,
      blobs: { totalCount: 0, totalBytes: 0, cacheCount: 0, cacheBytes: 0 },
      legacy: { bytes: 0, fileCount: 0 },
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
    scan: vi.fn(async (input: { archiveAgeMonths: '7-days' | 1 | 3 | 6 }) => ({
      scanId: 'scan-1',
      archiveAgeMonths: input.archiveAgeMonths,
      scannedAt: 1_000,
      archivedBeforeMs: 500,
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

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  toast.info.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { cindyMediaStorage: storageApi(), localDb: { maintenance: maintenanceApi() } },
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

  it('opens the fixed legacy image directory through the dedicated API', async () => {
    render(<StorageManagementCard />);

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.about.storage.legacyImagesOpenButton' }),
    );

    await waitFor(() => {
      expect(window.electronAPI.cindyMediaStorage.openLegacyImagesDir).toHaveBeenCalledWith();
    });
  });

  it('reports a missing legacy directory without creating one', async () => {
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
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByText('settings.about.storage.dbSlimmingBackupLabel'));
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByText('settings.about.storage.dbSlimmingBackupLabel'));
    const scanButton = screen.getByRole('button', {
      name: 'settings.about.storage.dbSlimmingScanButton',
    });
    fireEvent.click(scanButton);

    await waitFor(() => {
      expect(window.electronAPI.localDb.maintenance.scan).toHaveBeenCalledWith({
        archiveAgeMonths: '7-days',
      });
    });
    await waitFor(() => expect(scanButton.getAttribute('aria-busy')).toBeNull());
    expect(
      await screen.findByRole('alertdialog', {
        name: 'settings.about.storage.dbSlimmingScanResultTitle',
      }),
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
        scannedAt: 1_000,
        archivedBeforeMs: 500,
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
