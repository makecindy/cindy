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
    scan: vi.fn(async (input: { archiveAgeMonths: 1 | 3 | 6 }) => ({
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

describe('StorageManagementCard database slimming', () => {
  it('offers only 1, 3, and 6 months, defaults to 3 months, and scans that threshold', async () => {
    render(<StorageManagementCard />);

    const threshold = screen.getByRole('combobox');
    expect(threshold.textContent).toContain(
      'settings.about.storage.dbSlimmingArchiveAgeOption3',
    );
    fireEvent.click(threshold);
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'settings.about.storage.dbSlimmingArchiveAgeOption1',
      'settings.about.storage.dbSlimmingArchiveAgeOption3',
      'settings.about.storage.dbSlimmingArchiveAgeOption6',
    ]);
    fireEvent.click(options[1]!);
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
        archiveAgeMonths: 3,
      });
    });
    await waitFor(() => expect(scanButton.getAttribute('aria-busy')).toBeNull());
  });

  it('shows a disabled busy state while a database scan is running', async () => {
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

    await act(async () => {
      resolveScan({
        scanId: 'scan-busy',
        archiveAgeMonths: 3,
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
  });

  it('passes only main-issued scan and directory grants when scheduling a restart', async () => {
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
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'settings.about.storage.dbSlimmingRestartButton',
      }),
    );

    await waitFor(() => {
      expect(window.electronAPI.localDb.maintenance.schedule).toHaveBeenCalledWith({
        scanId: 'scan-1',
        backupEnabled: true,
        backupDirectoryGrantId: 'directory-grant',
      });
    });
  });
});
