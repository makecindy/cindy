/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PluginProjectMenu } from '../PluginScopePicker';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openProjects(
  projectOptions?: Array<{ id: string; name: string; path?: string }>,
  recentPaths: string[] = [],
  onBrowse?: () => void,
) {
  const onPick = vi.fn();
  render(
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>Computer</DropdownMenuTrigger>
      <DropdownMenuContent>
        <PluginProjectMenu
          scopeDir={null}
          activeSessionWorkingDir={undefined}
          recentWorkdirs={recentPaths.map((path) => ({
            path,
            lastUsedAt: '2026-10-15T00:00:00.000Z',
            exists: true,
          }))}
          onPick={onPick}
          projectOptions={projectOptions}
          onBrowse={onBrowse}
        />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  fireEvent.keyDown(
    await screen.findByRole('menuitem', {
      name: 'settings.ghosts.scopePicker.ariaLabel',
    }),
    { key: 'ArrowRight' },
  );
  const global = await screen.findByRole('menuitem', {
    name: 'settings.ghosts.scopePicker.global',
  });
  return { menu: within(global.closest('[role=menu]') as HTMLElement), onPick };
}

it('separates Global from folder browsing once when this computer has no projects', async () => {
  const { menu } = await openProjects();
  expect(menu.getAllByRole('menuitem')).toHaveLength(2);
  expect(menu.getAllByRole('separator')).toHaveLength(1);
});

it('keeps recent projects between Global and folder browsing', async () => {
  const { menu, onPick } = await openProjects(undefined, ['/fixture/Cindy']);
  expect(menu.getAllByRole('separator')).toHaveLength(2);
  fireEvent.click(menu.getByRole('menuitem', { name: /^Cindy/ }));
  expect(onPick).toHaveBeenCalledWith('/fixture/Cindy');
});

it('shows the remote empty state without local folder browsing', async () => {
  const { menu } = await openProjects([]);
  expect(menu.getByText('settings.ghosts.remote.noProjects')).toBeTruthy();
  expect(menu.getAllByRole('menuitem')).toHaveLength(1);
  expect(menu.getAllByRole('separator')).toHaveLength(1);
});

it('selects a remote project by its Host id without showing local folders', async () => {
  const { menu, onPick } = await openProjects(
    [{ id: 'host-project', name: 'Remote Project' }],
    ['/fixture/local'],
  );
  expect(menu.getAllByRole('menuitem')).toHaveLength(2);
  expect(menu.getAllByRole('separator')).toHaveLength(1);
  fireEvent.click(menu.getByRole('menuitem', { name: 'Remote Project' }));
  expect(onPick).toHaveBeenCalledWith('host-project');
});

it('keeps target paths visible for same-name projects and browses the selected Host only', async () => {
  const browse = vi.fn();
  const localBrowse = vi.fn();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { showOpenDirectoryDialog: localBrowse } });
  const { menu, onPick } = await openProjects([
    { id: 'target-a', name: 'Cindy', path: '/target/first/Cindy' },
    { id: 'target-b', name: 'Cindy', path: 'D:\\Projects\\Cindy' },
  ], ['/controller/local'], browse);
  expect(menu.getByText('/target/first/Cindy')).toBeTruthy();
  expect(menu.queryByText('/controller/local')).toBeNull();
  fireEvent.click(menu.getByRole('menuitem', { name: /D:.*Projects/ }));
  expect(onPick).toHaveBeenCalledWith('target-b');
  cleanup();
  const next = await openProjects([], [], browse);
  fireEvent.click(next.menu.getByRole('menuitem', { name: 'settings.ghosts.scopePicker.browse' }));
  expect(browse).toHaveBeenCalledOnce();
  expect(localBrowse).not.toHaveBeenCalled();
});

it('retains the main local folder picker and cancellation behavior', async () => {
  const localBrowse = vi.fn(async () => ({ canceled: true }));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { showOpenDirectoryDialog: localBrowse } });
  const { menu, onPick } = await openProjects();
  fireEvent.click(menu.getByRole('menuitem', { name: 'settings.ghosts.scopePicker.browse' }));
  await Promise.resolve();
  expect(localBrowse).toHaveBeenCalledOnce();
  expect(onPick).not.toHaveBeenCalled();
});
