// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

// Keep the route, its target migration, router and both draft stores real.
// Replace external catalogs, desktop services and unrelated visual children.
const fixtures = vi.hoisted(() => ({
  empty: [],
  agents: new Set(['cc', 'codex', 'pi']),
  caps: { availableModels: [], hasFastMode: false, permissionModes: [], effortLevels: [] },
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'shortcut-test' }) }));
vi.mock('@/themes/theme-service', () => ({
  themeService: { getCurrentTheme: () => null, onDidChangeTheme: () => () => {} },
}));
vi.mock('@/hooks/useCCSessions', () => ({ useCCSessions: () => ({ createSession: vi.fn() }) }));
vi.mock('@/hooks/useVendorAuthGate', () => ({
  useVendorAuthGate: () => ({ checkAndConfirm: vi.fn() }),
}));
vi.mock('@/contexts/WorktreeContext', () => ({ useRefreshWorktreeForSession: () => vi.fn() }));
vi.mock('@/hooks/useHasAnyReadyRemoteHost', () => ({ useHasAnyRemoteTarget: () => false }));
vi.mock('@/hooks/useControllableDevices', () => ({
  useSelectableDevices: () => ({ devices: fixtures.empty, loaded: false }),
}));
vi.mock('@/features/provider-share/useProviderShareAgentDevices', () => ({
  useProviderShareAgentDevices: () => ({ devices: fixtures.empty }),
}));
vi.mock('@/hooks/useAvailableAgents', () => ({
  useAvailableAgents: () => ({ availableVendors: fixtures.agents, loaded: true }),
}));
vi.mock('@/hooks/useProviderOnboarding', () => ({
  useProviderOnboarding: () => ({ visible: false }),
}));
vi.mock('@/hooks/useProviders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useProviders')>()),
  useProviders: () => ({ providers: fixtures.empty, loading: false, loadFailed: false }),
}));
vi.mock('@/hooks/useDeviceProviders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useDeviceProviders')>()),
  useDeviceProviders: () => ({ providers: fixtures.empty, loading: false }),
}));
vi.mock('@/hooks/useAgentCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAgentCapabilities')>()),
  useAgentCapabilities: () => ({ capabilities: fixtures.caps, loading: false }),
}));
vi.mock('@/hooks/useProjectPickerOptions', () => ({
  useProjectPickerOptions: () => fixtures.empty,
  getProjectPickerDisplayName: (dir: string | null) => dir,
}));
vi.mock('@/hooks/useDeviceLinkProjects', () => ({
  useDeviceLinkProjects: () => ({ projects: fixtures.empty, status: 'ready' }),
}));
vi.mock('@/features/cc-agent/hooks/useCollabProjectPolicy', () => ({
  useCollabProjectPolicy: () => ({ enabled: true, loading: false, unavailable: false }),
}));
vi.mock('@/hooks/useCrossAgentConvertPrompt', () => ({
  useCrossAgentMigrationDialog: () => ({ open: false }),
}));
vi.mock('@/hooks/useProportionalWidth', () => ({
  useProportionalWidth: () => ({ containerRef: null, inputWidth: 934, inputWidthBand: 2 }),
}));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({ useInstalledGhosts: () => fixtures.empty }));
vi.mock('@/features/right-sidebar/store', () => ({ closeAllTabs: async () => {} }));
vi.mock('@/features/right-sidebar/plugins/orca-workers/actions', () => ({
  revealOrcaWorkersTab: vi.fn(),
}));
vi.mock('@/components/new-chat/ChatInput', () => ({ ChatInput: () => null }));
vi.mock('@/components/new-chat/WorktreeChipsRow', () => ({ WorktreeChipsRow: () => null }));
vi.mock('@/components/new-chat/FolderPickerPopover', () => ({
  FolderPickerPopover: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect: (path: string, source: 'project') => Promise<void>;
  }) => (
    <>
      {children}
      <button onClick={() => void onSelect('/project-b', 'project')}>Choose project B</button>
    </>
  ),
}));
vi.mock('@/components/new-chat/DeviceSwitcherPill', () => ({ DeviceSwitcherPill: () => null }));
vi.mock('@/components/new-chat/AddRemoteProjectDialog', () => ({
  AddRemoteProjectDialog: () => null,
}));
vi.mock('@/components/new-chat/AgentSelect', () => ({ AgentSelect: () => null }));
vi.mock('@/components/new-chat/NewGoalDialog', () => ({ NewGoalDialog: () => null }));
vi.mock('@/components/ui/cross-agent-convert-dialog', () => ({
  CrossAgentConvertDialog: () => null,
}));
vi.mock('@/components/branding/ThemeBrandLockup', () => ({ ThemeBrandLockup: () => null }));
vi.mock('@/features/cc-agent/CreateWorkerPopover', () => ({ CreateWorkerPopover: () => null }));
vi.mock('@/features/cc-agent/HomeSuggestionList', () => ({ HomeSuggestionList: () => null }));

import { NewMakerDraftRoute } from '@/features/cc-agent/NewMakerDraftRoute';
import { __resetForTest, getDraft, patchCollab, patchDraft, setWorktreePreference } from '@/state/newMakerDraft';
import {
  clearDraft,
  getDraft as getComposerDraft,
  plainTextToTiptapDoc,
  saveDraft,
} from '@/lib/composerDraftStore';
import { sessionsStore } from '@/lib/sessionsStore';
import type { Session } from '@/lib/ccAgent.types';
import { makeGenericNewMakerRouteState } from '@/features/cc-agent/lib/genericNewMakerRouteState';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';

function shortcut(projectWorkingDir: string | null) {
  return {
    workspacePrompt: 'generic',
    dialogueTargetRequest: {
      requestId: crypto.randomUUID(),
      deviceId: null,
      deviceName: null,
      preserveWorkspaceIfSameDevice: true,
      projectWorkingDir,
    },
  };
}
function mount(state: unknown) {
  const router = createMemoryRouter([{ path: '/cc-agent/new', element: <NewMakerDraftRoute /> }], {
    initialEntries: [{ pathname: '/cc-agent/new', state }],
  });
  render(<RouterProvider router={router} />);
  return router;
}
beforeEach(() => {
  __resetForTest();
  clearDraft(NEW_MAKER_DRAFT_KEY);
  window.electronAPI = {
    platform: 'darwin',
    deviceLink: { onRemotePush: () => () => {} },
    onNewMakerWorktreeBranchChanged: () => () => {},
    getNewMakerWorktreeEnabled: async () => false,
  } as unknown as typeof window.electronAPI;
  patchDraft({ workingDir: '/project-b' });
  saveDraft(NEW_MAKER_DRAFT_KEY, {
    text: plainTextToTiptapDoc('Keep this unfinished message'),
    attachments: [],
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('shortcut target consumption in the mounted new-task route', () => {
  it('moves project B draft to A, keeps text and consumes the target before a later manual choice', async () => {
    const router = mount(shortcut('/project-a'));
    await waitFor(() => expect(getDraft().workingDir).toBe('/project-a'));
    expect(screen.getByTestId('create-agent-mode-pill').textContent).toBe('/project-a');
    expect(getComposerDraft(NEW_MAKER_DRAFT_KEY)?.text).toEqual(
      plainTextToTiptapDoc('Keep this unfinished message'),
    );
    expect(router.state.location.state).toEqual({ workspacePrompt: 'generic' });
    fireEvent.click(screen.getByRole('button', { name: 'Choose project B' }));
    await waitFor(() =>
      expect(screen.getByTestId('create-agent-mode-pill').textContent).toBe('/project-b'),
    );
    expect(getDraft().workingDir).toBe('/project-b');
    await act(() => router.navigate('/cc-agent/new', { state: shortcut('/project-a') }));
    expect(getDraft().workingDir).toBe('/project-a');
    expect(getComposerDraft(NEW_MAKER_DRAFT_KEY)?.text).toEqual(
      plainTextToTiptapDoc('Keep this unfinished message'),
    );
  });

  it('keeps a same-device generic entry on the saved draft project', async () => {
    patchCollab({ enabled: true });
    const state = shortcut('/project-a');
    const request: Partial<typeof state.dialogueTargetRequest> = { ...state.dialogueTargetRequest };
    delete request.projectWorkingDir;
    const router = mount({ ...state, dialogueTargetRequest: request });
    await waitFor(() =>
      expect(router.state.location.state).toEqual({ workspacePrompt: 'generic' }),
    );
    expect(getDraft().workingDir).toBe('/project-b');
    expect(getDraft().collab.enabled).toBe(true);
  });

  it('clears the old project for a global shortcut and keeps the composer text', async () => {
    patchCollab({ enabled: true });
    const router = mount(shortcut(null));
    await waitFor(() =>
      expect(router.state.location.state).toEqual({ workspacePrompt: 'generic' }),
    );
    expect(getDraft().workingDir).toBeNull();
    expect(getDraft().collab.enabled).toBe(false);
    expect(getComposerDraft(NEW_MAKER_DRAFT_KEY)?.text).toEqual(
      plainTextToTiptapDoc('Keep this unfinished message'),
    );
  });

  it.each(['.cindy-worktrees', '.xdt-worktrees'])(
    'does not reuse the source %s checkout when worktree creation is off', async (managedDir) => {
      const sourceCwd = '/project-a/' + managedDir + '/source-task';
      vi.spyOn(sessionsStore, 'findById').mockReturnValue({
        id: 'source-task', workingDir: sourceCwd, workspaceKind: 'project', remoteHostId: null,
      } as Session);
      setWorktreePreference(false);
      const router = mount(makeGenericNewMakerRouteState('/cc-agent/source-task', {
        inheritCurrentProject: true,
      }));
      await waitFor(() => expect(router.state.location.state).toEqual({ workspacePrompt: 'generic' }));
      expect(getDraft().workingDir).toBe('/project-a');
      expect(getDraft().workingDir).not.toBe(sourceCwd);
      expect(getDraft().worktreeEnabled).toBe(false);
    },
  );

  it.each([
    '/project-a/.cindy-worktrees/source-task',
    '/project-a/.xdt-worktrees/source-task/src',
    '/project-a/',
  ])('keeps mentions and collaboration for the equivalent project at %s', async (sourceCwd) => {
    patchDraft({ workingDir: '/project-a' });
    patchCollab({ enabled: true });
    const text = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'Keep this unfinished message ' },
        ...['file', 'dir', 'agent'].map((kind) => ({
          type: 'mentionChip', attrs: { kind, path: kind === 'agent' ? '.claude/agents/reviewer.md' : 'src' },
        })),
      ] }],
    };
    saveDraft(NEW_MAKER_DRAFT_KEY, { text, attachments: [] });
    vi.spyOn(sessionsStore, 'findById').mockReturnValue({
      id: 'source-task', workingDir: sourceCwd, workspaceKind: 'project', remoteHostId: null,
    } as Session);
    const router = mount(makeGenericNewMakerRouteState('/cc-agent/source-task', {
      inheritCurrentProject: true,
    }));
    await waitFor(() => expect(router.state.location.state).toEqual({ workspacePrompt: 'generic' }));
    expect.soft(getComposerDraft(NEW_MAKER_DRAFT_KEY)?.text).toEqual(text);
    expect.soft(getDraft().collab.enabled).toBe(true);
    expect(getDraft().workingDir).toBe('/project-a');
  });

  it('preserves enabled collaboration when shortcut targets the same device and project', async () => {
    patchDraft({ workingDir: '/project-a' });
    patchCollab({ enabled: true });
    const router = mount(shortcut('/project-a'));
    await waitFor(() =>
      expect(router.state.location.state).toEqual({ workspacePrompt: 'generic' }),
    );
    expect(getDraft().collab.enabled).toBe(true);
  });
});
