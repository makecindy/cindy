// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import type { SwitcherDevice } from '@/features/device-link/switcherDevices';
import type { QuickSwitcherCatalogPage, QuickSwitcherSession } from '../../shared/quickSwitcher';

const h = vi.hoisted(() => ({
  devices: [] as SwitcherDevice[],
  local: [] as Session[],
  remote: [] as Session[],
  aliases: new Map<string, string>(),
  hidden: new Set<string>(),
  catalog: vi.fn(),
  get: vi.fn(),
  dirs: vi.fn(),
  invoke: vi.fn(),
  reveal: vi.fn(),
  draft: vi.fn(),
  machine: vi.fn(),
  merge: vi.fn(),
  pin: vi.fn(),
  origin: vi.fn(),
  patched: new Set<(payload: { sessionId: string; patch: Partial<Session> }) => void>(),
  browserCommands: new Set<(payload: { command: string }) => void>(),
  t: (key: string) => key,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: h.t }) }));
vi.mock('@/features/device-link/useMachineSwitcher', () => ({
  useSwitcherDevices: () => h.devices,
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  useRemoteProjectSessions: () => h.remote,
  remoteProjectsStore: {
    getSessionDeviceId: h.origin,
    mergeDeviceSessions: h.merge,
    pinSessionOrigin: h.pin,
  },
}));
vi.mock('@/features/device-link/selectedMachineStore', () => ({
  MACHINE_LOCAL: 'local',
  setSelectedMachineIdTransient: h.machine,
}));
vi.mock('@/hooks/useCCSessions', () => ({ useCCSessions: () => ({ sessions: h.local }) }));
vi.mock('@/features/cc-agent/hooks/useProjectAliases', () => ({
  useProjectAliases: () => ({ aliases: h.aliases }),
}));
vi.mock('@/features/cc-agent/hooks/useHiddenProjects', () => ({
  useHiddenProjects: () => ({ hiddenProjectKeys: h.hidden }),
}));
vi.mock('@/state/newMakerDraft', () => ({ patchDraft: h.draft }));

import { QuickSwitcher } from '@/features/cc-agent/QuickSwitcher';
import { catalogSessionForGrouping } from '@/features/cc-agent/lib/quickSwitcher';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { clearQuickSwitcherFocus, useQuickSwitcherFocus } from '@/state/quickSwitcherFocus';
import { acquireAppInteractionLock } from '@/lib/appInteractionLock';

function row(id: string, patch: Partial<QuickSwitcherSession> = {}): QuickSwitcherSession {
  return {
    id,
    title: `Task ${id}`,
    workingDir: '/repo',
    workspaceKind: 'project',
    remoteHostId: null,
    agentKind: 'cc',
    status: 'active',
    pinnedAt: null,
    userSendAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    _count: { messages: 1 },
    ...patch,
  };
}
const page = (...sessions: QuickSwitcherSession[]): QuickSwitcherCatalogPage => ({
  version: 1,
  sessions,
  nextCursor: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function Harness() {
  const location = useLocation();
  const focus = useQuickSwitcherFocus();
  return (
    <>
      <input aria-label="draft" defaultValue="unsent draft" />
      <output data-testid="route">
        {location.pathname}
        {location.search}
      </output>
      <output data-testid="focus">{focus?.session?.id ?? focus?.project?.projectKey ?? ''}</output>
      <QuickSwitcher revealSidebar={h.reveal} />
    </>
  );
}
function setup(initial = '/settings') {
  render(
    <MemoryRouter initialEntries={[initial]}>
      <Harness />
    </MemoryRouter>,
  );
  screen.getByLabelText('draft').focus();
  fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });
  return screen.getByRole('combobox');
}
async function search(query: string) {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: query } });
  await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
}
beforeEach(() => {
  vi.clearAllMocks();
  h.devices = [];
  h.local = [];
  h.remote = [];
  h.aliases.clear();
  h.hidden.clear();
  h.patched.clear();
  h.browserCommands.clear();
  setDataOwnerGeneration('owner', 1);
  h.catalog.mockResolvedValue(page(row('a'), row('b')));
  h.get.mockImplementation(async (id: string) => catalogSessionForGrouping(row(id)));
  h.dirs.mockResolvedValue([]);
  h.origin.mockReturnValue(undefined);
  h.invoke.mockRejectedValue(new Error('legacy peer'));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'win32',
      onRsbBrowserCommand: (listener: (payload: { command: string }) => void) => {
        h.browserCommands.add(listener);
        return () => h.browserCommands.delete(listener);
      },
      appShortcuts: {
        getState: () => ({ platform: 'win32', overrides: {} }),
        onChanged: () => () => {},
      },
      localDb: {
        conversations: { catalog: h.catalog },
        sessions: { get: h.get },
        recentWorkdirs: { list: h.dirs },
        sessionsPush: {
          onCreated: () => () => {},
          onPatched: (
            listener: (payload: { sessionId: string; patch: Partial<Session> }) => void,
          ) => {
            h.patched.add(listener);
            return () => h.patched.delete(listener);
          },
        },
      },
      deviceLink: { invoke: h.invoke, onRemotePush: () => () => {} },
    },
  });
});
afterEach(() => {
  cleanup();
  clearQuickSwitcherFocus();
});

describe('quick switch dialog', () => {
  it('opens and focuses from a forwarded WebView shortcut, then removes its listener on unmount', async () => {
    const view = render(<MemoryRouter><Harness /></MemoryRouter>);
    screen.getByLabelText('draft').focus();
    act(() => h.browserCommands.forEach((listener) => listener({ command: 'reload' })));
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () =>
      h.browserCommands.forEach((listener) => listener({ command: 'open-quick-switcher' })),
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('combobox'));
    act(() => h.browserCommands.forEach((listener) => listener({ command: 'open-quick-switcher' })));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('draft')));
    view.unmount();
    expect(h.browserCommands.size).toBe(0);
  });

  it('ignores forwarded shortcuts during recording or an interaction lock', async () => {
    render(<MemoryRouter><Harness /></MemoryRouter>);
    const forward = () =>
      h.browserCommands.forEach((listener) => listener({ command: 'open-quick-switcher' }));
    document.body.dataset.appShortcutRecording = '1';
    try {
      act(forward);
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      delete document.body.dataset.appShortcutRecording;
    }
    const release = acquireAppInteractionLock();
    try {
      act(forward);
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      release();
    }
    await act(async () => forward());
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('opens the latest keyboard choice when arrow and Enter arrive before the next paint', async () => {
    const input = setup();
    await search('Task');
    act(() => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    await waitFor(() => expect(screen.getByTestId('route').textContent).toBe('/cc-agent/b'));
  });

  it('does not open a result from the previous query before the new query is painted', async () => {
    const input = setup();
    await search('Task');
    act(() => {
      fireEvent.change(input, { target: { value: 'unmatched' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(h.get).not.toHaveBeenCalled();
    expect(screen.getByTestId('route').textContent).toBe('/settings');
  });

  it('opens from settings with focus and no recommendations, navigates with arrows, and preserves the draft', async () => {
    const input = setup();
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole('option')).toBeNull();
    await search('Task');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('route').textContent).toBe('/cc-agent/b'));
    expect(screen.getByTestId('focus').textContent).toBe('b');
    expect(h.reveal).toHaveBeenCalledOnce();
    expect(h.draft).not.toHaveBeenCalled();
    expect((screen.getByLabelText('draft') as HTMLInputElement).value).toBe('unsent draft');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each(['escape', 'cancel', 'shortcut'] as const)(
    'restores focus on %s and clears only its own query on reopening',
    async (method) => {
      const input = setup();
      await search('Task');
      if (method === 'escape') fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
      else if (method === 'cancel')
        fireEvent.click(screen.getByText('ccAgent.quickSwitcher.cancel'));
      else fireEvent.keyDown(input, { key: 'k', code: 'KeyK', ctrlKey: true });
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('draft')));
      expect(h.get).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });
      });
      expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('');
      expect(screen.queryByRole('option')).toBeNull();
    },
  );

  it('does not navigate or dismiss while confirming IME input', async () => {
    const input = setup();
    await search('Task');
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(h.get).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('route').textContent).toBe('/cc-agent/a'));
  });

  it('dismisses on an outside pointer action and ignores a late directory result after reopening', async () => {
    const pending = deferred<QuickSwitcherCatalogPage>();
    h.catalog.mockReturnValueOnce(pending.promise);
    setup();
    // Radix installs its outside-pointer listener after the opening event.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const overlay = document.querySelector('[data-state="open"].fixed.inset-0');
    expect(overlay).not.toBeNull();
    fireEvent.pointerDown(overlay!, { button: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(overlay!, { button: 0, pointerType: 'mouse' });
    fireEvent.click(overlay!, { button: 0 });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });
    });
    await act(async () => pending.resolve(page(row('obsolete', { title: 'Obsolete' }))));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Obsolete' } });
    expect(screen.queryByRole('option')).toBeNull();
    expect(h.get).not.toHaveBeenCalled();
  });

  it.each(['/cc-agent/b', '/cc-agent/files/b'])(
    'keeps the current task from %s when selecting its project',
    async (route) => {
      setup(route);
      await search('repo');
      fireEvent.click(screen.getByRole('option'));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(h.get).toHaveBeenCalledWith('b');
      expect(screen.getByTestId('route').textContent).toBe('/cc-agent/b');
    },
  );

  it('never redirects a local result through an ambiguous remote task id', async () => {
    h.origin.mockReturnValue('other-device');
    setup();
    await search('Task a');
    fireEvent.click(screen.getByRole('option'));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('ccAgent.quickSwitcher.unavailable'),
    );
    expect(screen.getByTestId('route').textContent).toBe('/settings');
    expect(h.machine).not.toHaveBeenCalled();
  });

  it.each(['close', 'query', 'owner'] as const)(
    'discards a pending selection after %s changes',
    async (change) => {
      const pending = deferred<Session>();
      h.get.mockReturnValue(pending.promise);
      const input = setup();
      await search('Task');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(h.get).toHaveBeenCalledOnce();
      if (change === 'close') fireEvent.keyDown(input, { key: 'Escape' });
      if (change === 'query') fireEvent.change(input, { target: { value: 'different query' } });
      if (change === 'owner') setDataOwnerGeneration('other', 2);
      await act(async () => pending.resolve(catalogSessionForGrouping(row('a'))));
      expect(screen.getByTestId('route').textContent).toBe('/settings');
      expect(h.machine).not.toHaveBeenCalled();
      expect(h.draft).not.toHaveBeenCalled();
    },
  );

  it('shows local matches while a peer is pending and marks a legacy peer as partial', async () => {
    h.devices = [{ deviceId: 'peer', name: 'Peer', status: 'connected' }];
    const pending = deferred<QuickSwitcherCatalogPage>();
    h.invoke.mockReturnValue(pending.promise);
    setup();
    await search('Task');
    expect(screen.getByRole('status').textContent).toBe('ccAgent.quickSwitcher.incomplete');
    await act(async () => pending.resolve({ version: 0 } as unknown as QuickSwitcherCatalogPage));
    expect(screen.getByRole('status').textContent).toBe('ccAgent.quickSwitcher.incomplete');
    expect(h.invoke).toHaveBeenCalledWith('peer', 'local-db:conversations:catalog', [null]);
  });

  it('preserves the selected identity when a better-ranked remote match arrives', async () => {
    h.catalog.mockResolvedValue(page(row('local', { title: 'Match local' })));
    h.devices = [{ deviceId: 'peer', name: 'Peer', status: 'connected' }];
    const pending = deferred<QuickSwitcherCatalogPage>();
    h.invoke.mockReturnValue(pending.promise);
    const input = setup();
    await search('Match');
    await act(async () => pending.resolve(page(row('remote', { title: 'Match' }))));
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('false');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('route').textContent).toBe('/cc-agent/local'));
    expect(h.get).toHaveBeenCalledWith('local');
  });

  it('opens an archived remote task using its explicit origin, without a search jump', async () => {
    const task = row('archived', { title: 'Remote Only', status: 'archived' });
    h.devices = [{ deviceId: 'peer', name: 'Peer', status: 'connected' }];
    h.invoke.mockImplementation(async (_device: string, channel: string) =>
      channel.endsWith(':catalog') ? page(task) : catalogSessionForGrouping(task),
    );
    setup();
    await search('Remote Only');
    fireEvent.click(screen.getByRole('option'));
    await waitFor(() => expect(screen.getByTestId('route').textContent).toBe('/cc-agent/archived'));
    expect(h.get).not.toHaveBeenCalled();
    expect(h.invoke).toHaveBeenCalledWith('peer', 'local-db:sessions:get', ['archived']);
    expect(h.pin).toHaveBeenCalledWith('peer', 'archived');
    expect(h.merge).toHaveBeenCalledWith(
      'peer',
      'Peer',
      [expect.objectContaining({ status: 'archived', deviceLinkDeviceId: 'peer' })],
      'archived',
    );
  });

  it('explains a missing target and refuses a project whose task moved', async () => {
    setup();
    await search('Task');
    h.get.mockResolvedValueOnce(null);
    fireEvent.click(screen.getAllByRole('option')[0]);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('ccAgent.quickSwitcher.missing'),
    );
    await search('repo');
    h.get.mockResolvedValueOnce(catalogSessionForGrouping(row('a', { workingDir: '/moved' })));
    fireEvent.click(screen.getByRole('option'));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('ccAgent.quickSwitcher.changed'),
    );
    expect(screen.getByTestId('route').textContent).toBe('/settings');
  });

  it('opens an empty project as a draft without creating a task', async () => {
    h.dirs.mockResolvedValue([
      { path: '/empty', exists: true, lastUsedAt: '2026-01-01T00:00:00Z' },
    ]);
    setup();
    await search('empty');
    fireEvent.click(screen.getByRole('option'));
    await waitFor(() => expect(screen.getByTestId('route').textContent).toBe('/cc-agent/new'));
    expect(h.get).not.toHaveBeenCalled();
    expect(h.draft).toHaveBeenCalledWith({
      workingDir: '/empty',
      remoteHostId: null,
      deviceLinkDeviceId: null,
      deviceLinkDeviceName: null,
    });
    expect((screen.getByLabelText('draft') as HTMLInputElement).value).toBe('unsent draft');
  });

  it('clears an injected historical row when a later authoritative delete arrives', async () => {
    setup();
    await search('Task a');
    fireEvent.click(screen.getByRole('option'));
    await waitFor(() => expect(screen.getByTestId('focus').textContent).toBe('a'));
    act(() =>
      h.patched.forEach((listener) => listener({ sessionId: 'a', patch: { status: 'deleted' } })),
    );
    expect(screen.getByTestId('focus').textContent).toBe('');
  });
});
