// @vitest-environment jsdom
/**
 * 回归:群设置侧边栏里给群内伙伴配置技能(「工具与授权设置」)打开的伙伴设置抽屉
 * 必须关得掉 —— 包括宿主拒绝这次保存、草稿一直判脏的情况(issue #5676)。
 * 这条链路横跨群设置抽屉、路由与真实设置页,所以用真实路由 + 真实组件渲染。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom';
import { transferableAbortController } from 'node:util';
import type { BotCapabilities, BotModelRoute, BotProfile } from '../botStore';
import type { CustomMcpListContext, CustomMcpListResult } from '../../../../shared/customMcp';
import type { BotGroupSummary } from '../../../../shared/botGroupChat';

const mocks = vi.hoisted(() => {
  const sessionGet = vi.fn();
  return {
    confirm: vi.fn(),
    readSession: sessionGet,
    listCustomMcpServers: vi.fn<(context?: CustomMcpListContext) => Promise<CustomMcpListResult>>(),
    onSessionPatched: vi.fn(),
    onMcpChanged: vi.fn(),
    listAgentSkills: vi.fn(),
    listToolsets: vi.fn(),
    profiles: [] as BotProfile[],
    availableVendors: new Set(['cc', 'codex', 'pi']),
    defaultModelChain: [] as BotModelRoute[],
    modelListeners: new Set<() => void>(),
    runtimeListeners: new Set<() => void>(),
    updateBotProfile: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({
      id: 'bot-1',
      currentVersion: 1,
      ...patch,
    })),
    groups: [] as BotGroupSummary[],
  };
});

vi.mock('@/state/modelVisibilityPrefs', () => ({ migrateModelVisibilityDefaults: vi.fn() }));
vi.mock('@/hooks/useProviderOnboarding', () => ({ useProviderOnboarding: () => ({ visible: false }) }));
vi.mock('@/components/onboarding/ConnectProviderCard', () => ({ ConnectProviderCard: () => null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'fixture-owner' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/sessionService', () => ({ get: mocks.readSession }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));
vi.mock('@/components/settings/ProfileEditDialog', () => ({ ProfileEditDialog: () => null }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => 1,
  isDataOwnerGenerationCurrent: () => true,
  isDataOwnerPushCurrent: () => true,
}));
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: ({ modelId }: { modelId: string }) => <div data-testid="current-model">{modelId}</div>,
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('@/state/newMakerDraft', () => ({
  getDraft: () => ({ lastByVendor: {}, fastModeByModel: {} }),
}));
vi.mock('@/hooks/useAvailableAgents', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useAvailableAgents: () => ({
      availableVendors: useSyncExternalStore(
        (listener: () => void) => {
          mocks.runtimeListeners.add(listener);
          return () => mocks.runtimeListeners.delete(listener);
        },
        () => mocks.availableVendors,
      ),
      loaded: true,
    }),
  };
});
vi.mock('../feature-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../feature-context')>();
  return { ...actual, useRegisterContentHeader: () => undefined };
});
vi.mock('../BotLifecycleSettings', () => ({ BotLifecycleSettings: () => null }));
vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => [] }));
vi.mock('../botPronounContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../botPronounContext')>();
  return { ...actual, useBotTranslation: () => ({ t: (key: string) => key }) };
});
vi.mock('../botStore', () => ({
  updateBotProfile: mocks.updateBotProfile,
  chooseBotAvatar: vi.fn(),
  retryBotInvitation: vi.fn(),
  setCanonicalBotSession: vi.fn(),
  useBotProfiles: () => mocks.profiles,
  hasLoadedBotProfiles: () => true,
  canonicalBotSessionId: (bot: BotProfile) => bot.canonicalSessionId,
  getEffectiveBotModelChain: () => mocks.defaultModelChain,
  subscribeBotGlobalModel: (listener: () => void) => {
    mocks.modelListeners.add(listener);
    return () => mocks.modelListeners.delete(listener);
  },
}));
vi.mock('../botGroupStore', () => ({
  useBotGroupList: () => ({ groups: mocks.groups, loaded: true }),
  botGroupApi: () => ({}),
  refreshBotGroups: vi.fn(),
}));

import { BotSettingsDrawer } from '../BotSettingsDrawer';
import { BotGroupSettingsDrawer } from '../BotGroupSettingsDrawer';

function capabilities(overrides: Partial<BotCapabilities> = {}): BotCapabilities {
  return {
    model: 'claude-x',
    providerId: null,
    effort: 'medium',
    fastMode: false,
    harness: 'claude',
    modelChain: [{ harness: 'claude', model: 'claude-x', providerId: null, effort: 'medium', fastMode: false }],
    modelChainOverride: null,
    skillMode: 'inherit',
    skillsExcluded: [],
    toolsetMode: 'inherit',
    toolsets: [],
    mcpMode: 'inherit',
    mcpServers: [],
    memory: true,
    permissions: 'ask',
    ...overrides,
  };
}

function profile(): BotProfile {
  return {
    id: 'bot-1',
    name: 'Filo',
    description: 'Delivery steward',
    identitySource: '',
    userContextSource: '',
    avatar: '🧭',
    avatarColor: 'violet',
    enabled: true,
    status: 'active',
    currentVersion: 1,
    skills: [],
    capabilities: capabilities(),
    canonicalSessionId: 'bot-1-chat',
    homeDir: '/managed/bots/bot-1',
    createdAt: Date.now(),
    sessions: [],
  };
}

function group(): BotGroupSummary {
  return {
    id: 'g1',
    name: '官网介绍页',
    serverBacked: true,
    revision: 3,
    replyMode: 'all',
    speakingMode: 'auto',
    members: [
      { actorId: 'me', botId: 'me', actorKind: 'human', isSelf: true, isOwned: true, name: '我', role: 'owner',
        avatar: '', avatarColor: 'blue', status: 'active' },
      {
        actorId: 'actor-bot', botId: 'bot-1', actorKind: 'bot', isOwned: true, name: 'Filo', displayName: 'Filo',
        ownerName: '我', role: 'member', guestAccess: 'chat', accessRevision: 1,
        avatar: '', avatarColor: 'violet', status: 'active',
      },
    ],
    organizerBotId: null,
    projectDir: null,
    lastMessage: null,
    speakingBotIds: [],
    planningBotId: null,
    openPlan: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function Layout() {
  const location = useLocation();
  return (
    <>
      <output data-testid="location">{location.pathname + location.search}</output>
      <BotSettingsDrawer />
      <BotGroupSettingsDrawer />
    </>
  );
}

function renderFlow() {
  const router = createMemoryRouter(
    [
      { path: '/bots/groups/:groupId', element: <Layout /> },
      { path: '/bots/:botId', element: <Layout /> },
      { path: '/bots/:botId/session/:sessionId', element: <Layout /> },
      { path: '/bots/list', element: <Layout /> },
    ],
    { initialEntries: ['/bots/groups/g1?groupSettings=1'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

/** 群设置里点「工具与授权设置」,等伙伴设置抽屉打开在能力页。 */
async function openCapabilityDrawerFromGroup(router: ReturnType<typeof renderFlow>) {
  await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: /configureCapabilities/ }));
  await waitFor(() =>
    expect(screen.getByTestId('location').textContent).toBe('/bots/bot-1?settings=1&settingsPage=capabilities'),
  );
  await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
  expect(router.state.location.search).toContain('settingsPage=capabilities');
}

beforeEach(() => {
  const native = transferableAbortController();
  vi.stubGlobal('AbortController', native.constructor);
  vi.stubGlobal('AbortSignal', native.signal.constructor);
  mocks.profiles = [profile()];
  mocks.groups = [group()];
  mocks.defaultModelChain = capabilities().modelChain;
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.updateBotProfile.mockReset().mockImplementation(async (_id, patch) => ({
    id: 'bot-1',
    currentVersion: 1,
    ...patch,
  }));
  mocks.readSession.mockReset().mockResolvedValue({
    id: 'bot-1-chat', status: 'active', source: 'bot', title: 'Chat',
    updatedAt: new Date().toISOString(), workingDir: '/bot/workspace', agentKind: 'cc',
  });
  mocks.listAgentSkills.mockReset().mockResolvedValue({ success: true, skills: [{ name: 'release-check' }] });
  mocks.listToolsets.mockReset().mockResolvedValue([]);
  mocks.listCustomMcpServers.mockReset().mockResolvedValue({ agentKind: 'claude-code', servers: [] });
  mocks.onSessionPatched.mockReset().mockReturnValue(vi.fn());
  mocks.onMcpChanged.mockReset().mockReturnValue(vi.fn());
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      openPath: vi.fn(async () => ({ success: true })),
      localDb: { sessionsPush: { onPatched: mocks.onSessionPatched }, bots: { listSkills: vi.fn().mockResolvedValue([]) } },
      maker: {
        onMcpChanged: mocks.onMcpChanged,
        listAgentSkills: mocks.listAgentSkills,
        listCustomMcpServers: mocks.listCustomMcpServers,
        plugins: { list: mocks.listToolsets },
        chatServer: {
          ownedBots: vi.fn(async () => ({ ok: true, bots: [{ actorId: 'actor-bot', name: 'Filo' }] })),
          manage: vi.fn(async () => ({ ok: true })),
          refreshProfile: vi.fn(async () => ({ ok: true })),
        },
        updateBotGroup: vi.fn(async () => ({ ok: true })),
      },
      dialog: { showOpenDirectory: vi.fn(async () => ({ success: false })) },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('closes the capability drawer opened from the group sidebar', async () => {
  const router = renderFlow();
  await openCapabilityDrawerFromGroup(router);
  fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(router.state.location.pathname + router.state.location.search).toBe('/bots/bot-1');
});

it('asks before discarding a draft the host refused, then closes the sidebar', async () => {
  mocks.updateBotProfile.mockRejectedValue(new Error('PRECONDITION_FAILED'));
  const router = renderFlow();
  await openCapabilityDrawerFromGroup(router);
  const toggle = await screen.findByRole('switch', { name: 'release-check' });
  fireEvent.click(toggle);
  await screen.findByRole('button', { name: 'bots.autosave.retry' });

  // 取消:留在抽屉里,草稿还在。
  mocks.confirm.mockResolvedValueOnce(false);
  fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('switch', { name: 'release-check' }).getAttribute('aria-checked')).toBe('true');

  // 确认放弃:关掉抽屉,回到伙伴页,不再补写这份草稿。
  const writesBeforeLeave = mocks.updateBotProfile.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByTestId('location').textContent).toBe('/bots/bot-1');
  await act(async () => {});
  // 唯一一次写入是弹确认之前的 flush 尝试;用户放弃之后(含卸载补写)不得再发第二次。
  expect(mocks.updateBotProfile.mock.calls.length).toBe(writesBeforeLeave + 1);
});

