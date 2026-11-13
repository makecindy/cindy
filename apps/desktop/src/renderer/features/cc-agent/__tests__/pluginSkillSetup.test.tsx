// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../../shared/ghost';
import { installedGhostStoragePart } from '../../../../shared/pluginIdentity';
import { clearDraft, getDraft, plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import {
  cancelPendingPluginSuggestion,
  getPendingPluginSuggestion,
  readyPendingPluginSuggestion,
} from '../pendingPluginSuggestion';
import {
  pluginSetupRoute,
  pluginSkillSetupStates,
  prependSlashSkill,
  usePluginSkillSetup,
} from '../pluginSkillSetup';

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
const installed = vi.hoisted(() => ({ ghosts: [] as unknown[] }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast }));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({
  useInstalledGhosts: (enabled = true) => (enabled ? installed.ghosts : []),
}));

const OWNER = 'owner-a';
const SESSION_TARGET = JSON.stringify(['session', 's1']);
const github = (enabled: boolean) =>
  ({
    manifest: { id: 'cindy-github', name: 'GitHub', version: '1.0.0' },
    enabled,
    dir: '/plugins/cindy-github',
    namespace: null,
  }) as unknown as InstalledGhost;
const marketItem = (pluginId: string, installState = 'not-installed') => ({
  pluginId,
  ghostId: 'cindy-github',
  installState,
});
let marketItems: unknown[] = [];
let disabledInWorkdir: string[] = [];

function text(doc: unknown): string {
  return JSON.stringify(doc).match(/"text":"([^"]*)"/g)?.map((m) => m.slice(8, -1)).join('|') ?? '';
}

type Setup = ReturnType<typeof usePluginSkillSetup>;
const latest: { setup?: Setup; path?: string } = {};
function Harness(props: { targetKey?: string; enabled?: boolean; draftKey?: string; workingDir?: string }) {
  latest.setup = usePluginSkillSetup({
    enabled: props.enabled ?? true,
    ownerId: OWNER,
    workingDir: props.workingDir ?? '/repo',
    targetKey: props.targetKey ?? SESSION_TARGET,
    draftKey: props.draftKey ?? 's1',
  });
  return null;
}
function LocationProbe() {
  const location = useLocation();
  latest.path = `${location.pathname}${location.search}`;
  return null;
}
function renderAt(entry: string | { pathname: string; state: unknown }, harness = <Harness />) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <LocationProbe />
      <Routes>
        <Route path="/cc-agent/:id" element={harness} />
        <Route path="/plugins" element={null} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  installed.ghosts = [];
  marketItems = [marketItem('market-github')];
  disabledInWorkdir = [];
  latest.setup = undefined;
  latest.path = undefined;
  toast.info.mockReset();
  toast.error.mockReset();
  cancelPendingPluginSuggestion();
  vi.stubGlobal('electronAPI', {
    ghosts: {
      listSync: () => ({ ghosts: installed.ghosts }),
      workdirPrefsSync: () => ({ disabled: disabledInWorkdir }),
      workdirPrefs: async () => ({ disabled: disabledInWorkdir, workdirKey: '/repo' }),
      recommendationsSync: () => ({ ownerId: OWNER, sources: [], recentIds: [], newlyInstalledId: null }),
    },
    pluginMarket: { lookup: async () => ({ items: marketItems }) },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clearDraft('s1');
  clearDraft('s2');
  cancelPendingPluginSuggestion();
  vi.unstubAllGlobals();
});

describe('plugin Skill setup state', () => {
  it('offers install, then enable, and nothing once the plugin is usable here', () => {
    expect(installedGhostStoragePart(github(true))).toBe('cindy-github');
    expect(pluginSkillSetupStates([], null).map((x) => [x.skillName, x.state])).toEqual([
      ['pr', 'install'],
    ]);
    expect(pluginSkillSetupStates([github(false)], null)[0].state).toBe('enable');
    expect(pluginSkillSetupStates([github(true)], null)).toEqual([]);
    disabledInWorkdir = ['cindy-github'];
    expect(pluginSkillSetupStates([github(true)], '/repo')[0].state).toBe('enable');
  });

  it('routes to the installed page or exactly one market listing', async () => {
    expect(await pluginSetupRoute(github(false), 'cindy-github')).toBe('/plugins?ghost=cindy-github');
    expect(await pluginSetupRoute(undefined, 'cindy-github')).toBe('/plugins?market=market-github');
    marketItems = [marketItem('a'), marketItem('b')];
    expect(await pluginSetupRoute(undefined, 'cindy-github')).toBeNull();
    marketItems = [marketItem('a', 'conflict')];
    expect(await pluginSetupRoute(undefined, 'cindy-github')).toBeNull();
  });

  // Unit, #4540881698: a stamped organization install keeps its physical route;
  // the existing route test only covered root and could not detect source mixups.
  it('keeps the exact installed route only for the expected logical identity', async () => {
    const stamped = { ...github(false), namespace: 'acme', instanceKey: 'cindy-github' };
    expect(await pluginSetupRoute(stamped, 'cindy-github', { namespace: 'acme', ghostId: 'cindy-github' }))
      .toBe('/plugins?ghost=cindy-github');
    expect(await pluginSetupRoute(stamped, 'cindy-github', { namespace: null, ghostId: 'cindy-github' }))
      .toBeNull();
  });

  it('prepends the Skill and keeps what the user wrote', () => {
    expect(text(prependSlashSkill(null, 'pr'))).toBe('/pr ');
    expect(text(prependSlashSkill(plainTextToTiptapDoc('fix the login bug'), 'pr'))).toBe(
      '/pr |fix the login bug',
    );
    const already = plainTextToTiptapDoc('/pr fix it');
    expect(prependSlashSkill(already, 'pr')).toBe(already);
  });
});

describe('usePluginSkillSetup', () => {
  // PB97: task switching must render without waiting synchronously for main.
  // Unit: a delayed directory policy must neither leak an old setup row nor
  // lose the existing enable action once that policy arrives.
  it('renders without synchronous IPC and ignores the previous directory response', async () => {
    installed.ghosts = [github(true)];
    const pending = new Map<string, (value: { disabled: string[]; workdirKey: string }) => void>();
    const sync = vi.spyOn(window.electronAPI.ghosts, 'workdirPrefsSync');
    vi.spyOn(window.electronAPI.ghosts, 'workdirPrefs').mockImplementation((dir) => new Promise((resolve) => pending.set(dir, resolve)));
    const view = render(<MemoryRouter><Harness workingDir="/a" /></MemoryRouter>);
    expect(latest.setup).toBeUndefined();
    expect(sync).not.toHaveBeenCalled();
    await act(async () => {});
    view.rerender(<MemoryRouter><Harness workingDir="/b" /></MemoryRouter>);
    await act(async () => {});
    await act(async () => pending.get('/a')!({ disabled: ['cindy-github'], workdirKey: '/a' }));
    expect(latest.setup).toBeUndefined();
    await act(async () => pending.get('/b')!({ disabled: ['cindy-github'], workdirKey: '/b' }));
    expect(latest.setup?.entries[0].replacesInstalled).toBe(true);
    expect(sync).not.toHaveBeenCalled();
    // Selection still checks the current policy and keeps the existing draft.
    saveDraft('s1', { text: plainTextToTiptapDoc('keep this'), attachments: [] });
    act(() => latest.setup!.onSelect('pr'));
    expect(sync).toHaveBeenCalledWith('/b');
    expect(text(getDraft('s1')?.text)).toBe('/pr |keep this');
  });
  it('sends a missing plugin to its market page and fills the task composer on return', async () => {
    saveDraft('s1', { text: plainTextToTiptapDoc('fix the login bug'), attachments: [] });
    const first = renderAt('/cc-agent/s1');
    expect(latest.setup?.entries).toEqual([
      {
        skillName: 'pr',
        description: 'commandPalette.pluginSkills.pr.install',
        meta: 'commandPalette.pluginSkillSetup.install',
        replacesInstalled: false,
      },
    ]);
    act(() => latest.setup!.onSelect('pr'));
    await waitFor(() => expect(latest.path).toMatch(/^\/plugins\?market=market-github&recommendation=/));
    const pending = getPendingPluginSuggestion()!;
    expect(pending).toMatchObject({ ownerId: OWNER, targetKey: SESSION_TARGET, returnTo: '/cc-agent/s1', skillName: 'pr' });
    first.unmount();

    // GhostPluginPage marks it ready after a successful install, then navigates back.
    installed.ghosts = [github(true)];
    expect(readyPendingPluginSuggestion(pending.nonce, OWNER, 'cindy-github')).toBe(pending.nonce);
    // Another task's composer on the same screen leaves the request alone.
    await act(async () => renderAt(
      { pathname: '/cc-agent/s1', state: { pluginSuggestionNonce: pending.nonce } },
      <Harness targetKey={JSON.stringify(['session', 's2'])} draftKey="s2" />,
    ));
    expect(getPendingPluginSuggestion()?.nonce).toBe(pending.nonce);
    cleanup();
    await act(async () => renderAt({ pathname: '/cc-agent/s1', state: { pluginSuggestionNonce: pending.nonce } }));
    expect(text(getDraft('s1')?.text)).toBe('/pr |fix the login bug');
    expect(getDraft('s2')).toBeUndefined();
    expect(getPendingPluginSuggestion()).toBeNull();
    expect(latest.setup).toBeUndefined();
  });

  it('opens the installed page for a disabled plugin', async () => {
    installed.ghosts = [github(false)];
    renderAt('/cc-agent/s1');
    await waitFor(() => expect(latest.setup?.entries[0].meta).toBe('commandPalette.pluginSkillSetup.enable'));
    expect(latest.setup?.entries[0].replacesInstalled).toBe(true);
    act(() => latest.setup!.onSelect('pr'));
    await waitFor(() => expect(latest.path).toMatch(/^\/plugins\?ghost=cindy-github&recommendation=/));
  });

  it('explains instead of guessing when the market has no single listing', async () => {
    marketItems = [];
    renderAt('/cc-agent/s1');
    act(() => latest.setup!.onSelect('pr'));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('newChat.pluginSuggestions.unavailable'));
    expect(getPendingPluginSuggestion()).toBeNull();
    expect(latest.path).toBe('/cc-agent/s1');
  });

  it('offers nothing where the flow is excluded', () => {
    renderAt('/cc-agent/s1', <Harness enabled={false} />);
    expect(latest.setup).toBeUndefined();
  });
});
