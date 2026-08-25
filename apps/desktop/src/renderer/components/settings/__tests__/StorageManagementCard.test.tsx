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

describe('StorageManagementCard legacy images', () => {
  it('renders the directory action without scanning legacy images', async () => {
    render(<StorageManagementCard />);

    await waitFor(() => {
      expect(window.electronAPI.cindyMediaStorage.stats).toHaveBeenCalledWith();
    });
    expect(
      screen.getByRole('button', { name: 'settings.about.storage.legacyImagesOpenButton' }),
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
});
