// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GeneratedPluginPackage } from '../GeneratedPluginPackage';
import { __resetInstalledGhostsStoreForTest } from '@/cindy-brain/useInstalledGhosts';
import * as placement from '@/features/right-sidebar/pluginPlacement';
import { installInspectedGhostFromFile } from '@/cindy-brain/installFlow';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/cindy-brain/installFlow', () => ({ installInspectedGhostFromFile: vi.fn() }));
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

it('checks only one generated package at a time and skips cards removed from the queue', async () => {
  let finishFirst!: () => void;
  const first = new Promise<void>((resolve) => { finishFirst = resolve; });
  const inspect = vi.fn(async (path: string) => {
    if (path === 'first.cindy') await first;
    throw new Error('unreadable package');
  });
  vi.stubGlobal('electronAPI', { ghosts: { inspect } });
  const root = createRoot(document.createElement('div'));
  const render = (paths: string[]) => root.render(
    <MemoryRouter>
      {paths.map((path) => (
        <GeneratedPluginPackage key={path} path={path} sessionId="test">{path}</GeneratedPluginPackage>
      ))}
    </MemoryRouter>,
  );
  try {
    await act(async () => render(['first.cindy', 'removed.cindy', 'last.cindy']));
    expect(inspect.mock.calls.flat()).toEqual(['first.cindy']);
    await act(async () => render(['first.cindy', 'last.cindy']));
    await act(async () => finishFirst());
    expect(inspect.mock.calls.flat()).toEqual(['first.cindy', 'last.cindy']);
  } finally {
    finishFirst();
    await act(async () => root.unmount());
  }
});

it('reads the replacement package after its displayed digest is rejected', async () => {
  const pkg = (name: string) => ({ manifest: { id: 'quiet', name, version: '1' }, packageSha256: name });
  const inspect = vi.fn().mockResolvedValueOnce(pkg('first')).mockResolvedValue(pkg('replacement'));
  vi.stubGlobal('electronAPI', { ghosts: { inspect, listSync: () => ({ ghosts: [] }), onChanged: () => () => {} } });
  vi.mocked(installInspectedGhostFromFile).mockResolvedValueOnce(false);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <MemoryRouter>
        <GeneratedPluginPackage path="same.cindy" sessionId="test">same.cindy</GeneratedPluginPackage>
      </MemoryRouter>,
    ));
    expect(container.textContent).toContain('first');
    await act(async () => container.querySelector('button')!.click());
    expect(installInspectedGhostFromFile).toHaveBeenCalledWith('same.cindy', pkg('first'), expect.anything());
    expect(container.textContent).toContain('replacement');
    expect(inspect).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});

function CurrentPath() {
  return <output>{useLocation().pathname}</output>;
}

it.each(['existing', 'sidebar', 'window', 'page'] as const)(
  'opens an installed main view in the expected place (%s)', async (target) => {
    const manifest = { id: 'quiet', name: 'Quiet', version: '1', mainView: { html: 'main.html' } };
    const ghost = {
      manifest, namespace: 'local', namespaceState: 'confirmed', enabled: true,
      approval: { state: 'approved' }, installedPackageSha256: 'digest',
    };
    __resetInstalledGhostsStoreForTest();
    vi.stubGlobal('electronAPI', { ghosts: {
      inspect: async () => ({ manifest, packageSha256: 'digest' }),
      listSync: () => ({ ghosts: [ghost] }), onChanged: () => () => {},
    } });
    const focus = vi.spyOn(placement, 'focusExistingPluginTab').mockReturnValue(target === 'existing');
    const resolve = vi.spyOn(placement, 'resolvePluginOpenTarget').mockReturnValue(target === 'existing' ? 'page' : target);
    const sidebar = vi.spyOn(placement, 'openPluginInSidebar').mockResolvedValue();
    const popout = vi.spyOn(placement, 'openPluginInWindow').mockImplementation(() => {});
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(
        <MemoryRouter initialEntries={['/task']}>
          <CurrentPath />
          <GeneratedPluginPackage path="quiet.cindy" sessionId="test">quiet.cindy</GeneratedPluginPackage>
        </MemoryRouter>,
      ));
      await act(async () => container.querySelector('button')!.click());
      expect(focus).toHaveBeenCalledWith(ghost);
      expect(resolve).toHaveBeenCalledTimes(target === 'existing' ? 0 : 1);
      expect(sidebar).toHaveBeenCalledTimes(target === 'sidebar' ? 1 : 0);
      expect(popout).toHaveBeenCalledTimes(target === 'window' ? 1 : 0);
      expect(container.querySelector('output')?.textContent).toBe(target === 'page' ? '/apps/_ns__local__quiet' : '/task');
    } finally {
      await act(async () => root.unmount());
      __resetInstalledGhostsStoreForTest();
      vi.restoreAllMocks();
    }
  },
);
