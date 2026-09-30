// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogueDirectorySection } from '../DialogueDirectorySection';

const { t, error, success } = vi.hoisted(() => ({ t: (key: string) => key, error: vi.fn(), success: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));
vi.mock('@/lib/toast', () => ({ toast: { error, success } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function setup() {
  const api = {
    open: vi.fn(async () => ({ success: true })),
    get: vi.fn(async () => ({ directory: 'default-directory', isCustomized: false })),
    choose: vi.fn(async () => ({ directory: 'custom-directory', isCustomized: true })),
    reset: vi.fn(async () => ({ directory: 'default-directory', isCustomized: false })),
  };
  vi.stubGlobal('electronAPI', { dialogueWorkspace: api, platform: 'win32' });
  render(<DialogueDirectorySection />);
  return api;
}

describe('DialogueDirectorySection', () => {
  it('opens the current workspace using the system file manager and reports failures', async () => {
    const api = setup();
    await screen.findByText('default-directory');
    fireEvent.click(screen.getByRole('button', { name: 'settings.about.storage.dialogueDirectoryOpen' }));
    expect(api.open).toHaveBeenLastCalledWith();
    fireEvent.click(screen.getByText('settings.about.storage.dialogueDirectoryChoose'));
    await screen.findByText('custom-directory');
    api.open.mockResolvedValue({ success: false });
    fireEvent.click(screen.getByRole('button', { name: 'settings.about.storage.dialogueDirectoryOpen' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('ccAgent.common.openFolderFailed'));
    expect(api.open).toHaveBeenCalledTimes(2);
    api.open.mockRejectedValue(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: 'settings.about.storage.dialogueDirectoryOpen' }));
    await waitFor(() => expect(error).toHaveBeenCalledTimes(2));
  });

  it('shows the effective path and restores the default after choosing a location', async () => {
    const api = setup();
    await screen.findByText('default-directory');
    expect(screen.queryByText('settings.about.storage.dialogueDirectoryReset')).toBeNull();
    fireEvent.click(screen.getByText('settings.about.storage.dialogueDirectoryChoose'));
    await screen.findByText('custom-directory');
    fireEvent.click(screen.getByRole('button', { name: 'settings.about.storage.dialogueDirectoryReset' }));
    await screen.findByText('default-directory');
    expect(api.choose).toHaveBeenCalledOnce();
    expect(api.reset).toHaveBeenCalledOnce();
  });

  it('keeps the displayed path after a failed selection', async () => {
    const api = setup();
    await screen.findByText('default-directory');
    api.choose.mockRejectedValue(new Error('failed'));
    fireEvent.click(screen.getByText('settings.about.storage.dialogueDirectoryChoose'));
    await waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(screen.getByText('default-directory')).toBeTruthy();
    expect(screen.queryByText('settings.about.storage.dialogueDirectoryReset')).toBeNull();
  });

  it('exposes and copies the exact path without losing spaces or separators', async () => {
    const api = setup();
    const directory = 'D:\\My Files\\Cindy\\dialogues\\49011892028b05fbb1ef';
    api.choose.mockResolvedValue({ directory, isCustomized: true });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await screen.findByText('default-directory');
    fireEvent.click(screen.getByText('settings.about.storage.dialogueDirectoryChoose'));
    await screen.findByText('dialogues');
    expect(screen.queryByText(directory)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'settings.about.storage.dialogueDirectoryFullPath' }));
    await screen.findByText(directory);
    fireEvent.click(screen.getByRole('button', { name: 'settings.about.storage.dialogueDirectoryCopy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(directory));
  });
});
