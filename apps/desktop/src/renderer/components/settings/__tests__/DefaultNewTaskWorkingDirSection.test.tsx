// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { getDefaultNewTaskWorkingDir } from '@/state/defaultNewTaskWorkingDir';
import { DefaultNewTaskWorkingDirSection } from '../DefaultNewTaskWorkingDirSection';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

beforeEach(() => {
  localStorage.clear();
  setDataOwnerGeneration('owner-a');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setDataOwnerGeneration(null);
});

describe('default working directory setting', () => {
  it('cancels without saving, then selects and clears a local directory', async () => {
    const choose = vi
      .fn()
      .mockResolvedValueOnce({ canceled: true })
      .mockResolvedValueOnce({ canceled: false, path: '/projects/cindy' });
    vi.stubGlobal('electronAPI', { showOpenDirectoryDialog: choose });
    render(<DefaultNewTaskWorkingDirSection ownerId="owner-a" />);

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.defaultNewTaskWorkingDir.choose' }),
    );
    await waitFor(() => expect(choose).toHaveBeenCalledOnce());
    expect(getDefaultNewTaskWorkingDir('owner-a')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.defaultNewTaskWorkingDir.choose' }),
    );
    await screen.findByText('/projects/cindy');
    expect(getDefaultNewTaskWorkingDir('owner-a')).toBe('/projects/cindy');

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.defaultNewTaskWorkingDir.clear' }),
    );
    await waitFor(() => expect(getDefaultNewTaskWorkingDir('owner-a')).toBeNull());
  });

  it('discards a directory selection completed after switching accounts', async () => {
    let finish!: (value: { canceled: boolean; path: string }) => void;
    vi.stubGlobal('electronAPI', {
      showOpenDirectoryDialog: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    render(<DefaultNewTaskWorkingDirSection ownerId="owner-a" />);
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.defaultNewTaskWorkingDir.choose' }),
    );
    setDataOwnerGeneration('owner-b');
    finish({ canceled: false, path: '/projects/private-a' });
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', {
            name: 'settings.defaultNewTaskWorkingDir.choose',
          })
          .hasAttribute('disabled'),
      ).toBe(false),
    );
    expect(getDefaultNewTaskWorkingDir('owner-a')).toBeNull();
    expect(getDefaultNewTaskWorkingDir('owner-b')).toBeNull();
  });
});
