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
  pluginSkillSetupStates,
  prependSlashSkill,
  usePluginSkillSetup,
} from '../pluginSkillSetup';

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));
const install = vi.hoisted(() => vi.fn());
const setEnabled = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const installed = vi.hoisted(() => ({ ghosts: [] as unknown[] }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast }));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({
  useInstalledGhosts: (enabled = true) => (enabled ? installed.ghosts : []),
}));

const OWNER = 'owner-a';
const SESSION_TARGET = JSON.stringify(['session', 's1']);
const github = (enabled: boolean, approval: 'approved' | 'invalid' = 'approved') =>
  ({
    manifest: { id: 'cindy-github', name: 'GitHub', version: '1.0.0' },
    enabled,
    approval: { state: approval, revision: 'r' },
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
  toast.success.mockReset();
  install.mockReset();
  install.mockImplementation(async () => {
    installed.ghosts = [github(true)];
    return { ghost: github(true) };
  });
  setEnabled.mockReset();
  setEnabled.mockResolvedValue({ ok: true });
  cancelPendingPluginSuggestion();
  vi.stubGlobal('electronAPI', {
    ghosts: {
      listSync: () => ({ ghosts: installed.ghosts }),
      workdirPrefsSync: () => ({ disabled: disabledInWorkdir }),
      workdirPrefs: async () => ({ disabled: disabledInWorkdir, workdirKey: '/repo' }),
      recommendationsSync: () => ({ ownerId: OWNER, sources: [], recentIds: [], newlyInstalledId: null }),
      setEnabled,
    },
    pluginMarket: {
      lookup: async () => ({ items: marketItems }),
      detail: async (pluginId: string) => ({
        ...(marketItems as { pluginId: string }[]).find((item) => item.pluginId === pluginId),
        releaseId: 'release-1',
        manifest: { id: 'cindy-github' },
      }),
      install,
    },
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
  // 2026-11-17: picking the row installs the plugin here instead of opening its page.
  it('installs a missing plugin right here and fills the task composer', async () => {
    saveDraft('s1', { text: plainTextToTiptapDoc('fix the login bug'), attachments: [] });
    renderAt('/cc-agent/s1');
    expect(latest.setup?.entries).toEqual([
      {
        skillName: 'pr',
        description: 'commandPalette.pluginSkills.pr.install',
        meta: 'commandPalette.pluginSkillSetup.install',
        replacesInstalled: false,
      },
    ]);
    act(() => latest.setup!.onSelect('pr'));
    await waitFor(() => expect(text(getDraft('s1')?.text)).toBe('/pr |fix the login bug'));
    expect(install).toHaveBeenCalledExactlyOnceWith('market-github', {
      expectedReleaseId: 'release-1',
      expectedManifest: { id: 'cindy-github' },
      allowSourceReplacement: false,
    });
    expect(latest.path).toBe('/cc-agent/s1');
    expect(getPendingPluginSuggestion()).toBeNull();
  });

  it('turns a disabled plugin on right here, also in this project', async () => {
    installed.ghosts = [github(false)];
    disabledInWorkdir = ['cindy-github'];
    const setWorkdirDisabled = vi.fn(async () => {
      disabledInWorkdir = [];
      return { disabled: [] };
    });
    Object.assign(window.electronAPI.ghosts, { setWorkdirDisabled });
    setEnabled.mockImplementation(async () => {
      installed.ghosts = [github(true)];
      return { ok: true };
    });
    renderAt('/cc-agent/s1');
    await waitFor(() => expect(latest.setup?.entries[0].meta).toBe('commandPalette.pluginSkillSetup.enable'));
    expect(latest.setup?.entries[0].replacesInstalled).toBe(true);
    act(() => latest.setup!.onSelect('pr'));
    await waitFor(() => expect(text(getDraft('s1')?.text)).toBe('/pr '));
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith('cindy-github', true, 'approved:r');
    expect(setWorkdirDisabled).toHaveBeenCalledExactlyOnceWith('/repo', 'cindy-github', false);
    expect(latest.path).toBe('/cc-agent/s1');
  });

  // What cannot be settled here (an install record to recover) keeps the plugin page and its way back.
  it('sends an unverified install to its page and fills the task composer on return', async () => {
    installed.ghosts = [github(false, 'invalid')];
    saveDraft('s1', { text: plainTextToTiptapDoc('fix the login bug'), attachments: [] });
    const first = renderAt('/cc-agent/s1');
    await waitFor(() => expect(latest.setup?.entries[0].meta).toBe('commandPalette.pluginSkillSetup.enable'));
    act(() => latest.setup!.onSelect('pr'));
    await waitFor(() => expect(latest.path).toMatch(/^\/plugins\?ghost=cindy-github&recommendation=/));
    expect(setEnabled).not.toHaveBeenCalled();
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

  it('explains instead of guessing when the market has no single listing', async () => {
    marketItems = [];
    renderAt('/cc-agent/s1');
    act(() => latest.setup!.onSelect('pr'));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('newChat.pluginSuggestions.unavailable'));
    expect(install).not.toHaveBeenCalled();
    expect(getPendingPluginSuggestion()).toBeNull();
    expect(latest.path).toBe('/cc-agent/s1');
  });

  it('offers nothing where the flow is excluded', () => {
    renderAt('/cc-agent/s1', <Harness enabled={false} />);
    expect(latest.setup).toBeUndefined();
  });
});
