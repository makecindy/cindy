// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  toast.info.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { cindyMediaStorage: storageApi() },
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
