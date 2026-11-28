// @vitest-environment jsdom
/**
 * Test value (#10568): verifies BuddyWorkspaceDirectorySection in Settings > Storage renders
 * default/customized states, invokes choose/reset/open IPC handlers, and surfaces validation errors.
 * Unit tier; jsdom, no Electron window.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuddyWorkspaceSettingsState } from '../../../../shared/buddyWorkspaceSettings';

const stableT = (key: string) => key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: stableT }),
}));

vi.mock('@/contexts/SettingsSearchContext', () => ({
  useSettingsSearchHighlight: () => ({ highlightedTargetId: null }),
  useSettingsSearchOptional: () => null,
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: toastMocks }));

import { BuddyWorkspaceDirectorySection } from '../BuddyWorkspaceDirectorySection';

function installApi(initial: BuddyWorkspaceSettingsState) {
  const api = {
    get: vi.fn(async () => initial),
    choose: vi.fn(async () => ({
      directory: 'D:\\CindyData\\buddy-workspaces\\owner1',
      isCustomized: true,
    })),
    reset: vi.fn(async () => ({
      directory: 'C:\\Users\\Alice\\AppData\\Roaming\\Cindy\\owners\\owner1\\bots',
      isCustomized: false,
    })),
    open: vi.fn(async () => ({ success: true })),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    buddyWorkspace: api,
  };
  return api;
}

beforeEach(() => {
  toastMocks.success.mockReset();
  toastMocks.error.mockReset();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('BuddyWorkspaceDirectorySection', () => {
  it('loads default directory, switches to a customized folder, and resets back to default', async () => {
    const api = installApi({
      directory: 'C:\\Users\\Alice\\AppData\\Roaming\\Cindy\\owners\\owner1\\bots',
      isCustomized: false,
    });
    render(<BuddyWorkspaceDirectorySection />);

    expect(
      await screen.findByText('settings.about.storage.dialogueDirectoryDefault'),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', {
        name: /settings\.about\.storage\.buddyWorkspaceDirectoryChoose/,
      }),
    );
    await waitFor(() => expect(api.choose).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('settings.defaults.customizedBadge')).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.about.storage.dialogueDirectoryReset',
      }),
    );
    await waitFor(() => expect(api.reset).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText('settings.about.storage.dialogueDirectoryDefault'),
    ).toBeTruthy();
  });

  it('surfaces overlap validation errors via toast', async () => {
    const api = installApi({
      directory: 'C:\\Users\\Alice\\AppData\\Roaming\\Cindy\\owners\\owner1\\bots',
      isCustomized: false,
    });
    api.choose.mockRejectedValueOnce(new Error('[PRECONDITION_FAILED] TARGET_OVERLAPS_CINDY_DATA'));
    render(<BuddyWorkspaceDirectorySection />);

    await screen.findByText('settings.about.storage.dialogueDirectoryDefault');
    fireEvent.click(
      screen.getByRole('button', {
        name: /settings\.about\.storage\.buddyWorkspaceDirectoryChoose/,
      }),
    );
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        'bots.homeFolder.workspaceLocation.errors.overlapsCindyData',
      ),
    );
  });
});
