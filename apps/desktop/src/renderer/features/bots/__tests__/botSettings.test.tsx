// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotCapabilities, BotChannelConnection, BotProfile } from '../botStore';

// jsdom doesn't implement Element.scrollTo / scrollIntoView (real browsers/Electron
// do); the settings page calls them to jump to a block on deep link, or reset scroll
// on a top-of-page landing.
const scrollToSpy = vi.fn();
const scrollIntoViewSpy = vi.fn();
Element.prototype.scrollTo = scrollToSpy;
Element.prototype.scrollIntoView = scrollIntoViewSpy;

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  initialSearch: '' as string,
  /** Mirrors whatever the page last wrote, so tests can assert on the deep-link value. */
  currentSearch: '' as string,
  updateBotProfile: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({
    id: 'bot-1',
    currentVersion: 1,
    ...patch,
  })),
  listBotChannelConnections: vi.fn(async () => [] as BotChannelConnection[]),
  upsertBotProjectBinding: vi.fn(
    async (
      _botId: string,
      _input: {
        id?: string;
        workingDir: string;
        remoteHostId?: string | null;
        defaultBranch?: string | null;
        workspacePolicy: string;
        isDefault: boolean;
        allowedPaths?: string[];
      },
    ) => undefined,
  ),
  archiveBotProjectBinding: vi.fn(async (_botId: string, _bindingId: string) => undefined),
}));

// The Bot settings page owns its own URL state via useSearchParams. A real
// Router is unnecessary here: this stub keeps genuine React state (so the
// functional `setSearchParams((current) => ...)` form used by the page
// actually re-renders the consumer, same as react-router-dom does) while
// letting each test seed the starting `?settings=1&tab=<id>` deep link and
// read back whatever the page wrote via `mocks.currentSearch`.
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  const { useCallback, useState } = await import('react');
  return {
    ...actual,
    useParams: () => ({}),
    useNavigate: () => mocks.navigate,
    useSearchParams: () => {
      const [params, setParams] = useState(() => new URLSearchParams(mocks.initialSearch));
      const setSearchParams = useCallback(
        (
          next:
            | URLSearchParams
            | Record<string, string>
            | ((current: URLSearchParams) => URLSearchParams),
        ) => {
          setParams((current) => {
            const resolved = typeof next === 'function' ? next(new URLSearchParams(current)) : next;
            const resolvedParams =
              resolved instanceof URLSearchParams ? resolved : new URLSearchParams(resolved);
            mocks.currentSearch = resolvedParams.toString();
            return resolvedParams;
          });
        },
        [],
      );
      return [params, setSearchParams] as const;
    },
  };
});

vi.mock('../botStore', () => ({
  updateBotProfile: mocks.updateBotProfile,
  listBotChannelConnections: mocks.listBotChannelConnections,
  listBotImMigrations: vi.fn(async () => []),
  planBotImMigration: vi.fn(),
  rollbackBotImMigration: vi.fn(),
  applyBotImMigration: vi.fn(),
  setCanonicalBotSession: vi.fn(),
  upsertBotChannel: vi.fn(),
  exportBotBundle: vi.fn(async () => ({ canceled: true })),
  importBotBundle: vi.fn(async () => ({ canceled: true })),
  useBotProfiles: () => [],
  upsertBotProjectBinding: mocks.upsertBotProjectBinding,
  archiveBotProjectBinding: mocks.archiveBotProjectBinding,
}));

// The real growth lists call useConfirmDialog() unconditionally, and they are now
// reachable by default (capabilities.memory defaults to true) — same pattern
// botAutomationSettings.test.tsx already uses for RunHistory's retry flow.
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }),
}));


vi.mock('../BotAvatar', () => ({
  BotAvatar: () => <div data-testid="bot-avatar" />,
  BotAvatarPicker: () => <div data-testid="bot-avatar-picker" />,
}));
vi.mock('../BotCapabilitySettings', () => ({
  BotCapabilitySettings: () => <div data-testid="bot-capability-settings" />,
}));
vi.mock('../BotProjectSettings', () => ({
  BotProjectSettings: () => <div data-testid="bot-project-settings" />,
}));
// 日程区块整体嵌入,没有任何前置开关,所以这里只需要确认它**被挂上了**;
// BotAutomationSettings 自己的内部行为另有单测。
vi.mock('../BotAutomationSettings', () => ({
  BotAutomationSettings: () => <div data-testid="bot-automation-settings" />,
}));
vi.mock('../BotRouteSettings', () => ({
  BotRouteSettings: () => <div data-testid="bot-route-settings" />,
}));
vi.mock('../BotLifecycleSettings', () => ({
  BotLifecycleSettings: () => <div data-testid="bot-lifecycle-settings" />,
}));
vi.mock('../BotEventInboxSettings', () => ({
  BotEventInboxSettings: () => <div data-testid="bot-event-inbox-settings" />,
}));
// The wizard's own compile/decompile/roundtrip behavior is covered exhaustively
// by botPersona.test.ts; here we only need a fixture that proves BotsHomeView
// wires `identitySource`/`onSave` through to the autosave pipeline correctly.
vi.mock('../BotPersonaWizard', () => ({
  BotPersonaWizard: ({
    open,
    onSave,
  }: {
    open: boolean;
    identitySource: string;
    onOpenChange: (open: boolean) => void;
    onSave: (next: string) => void;
  }) =>
    open ? (
      <div role="dialog" aria-label="persona-wizard-fixture">
        <button
          type="button"
          onClick={() =>
            onSave(
              '<!--persona:v1:{"style":"lively","proactivity":"proactive","call":"boss"}-->\nzh\nen',
            )
          }
        >
          persona-wizard-save
        </button>
      </div>
    ) : null,
  personaSummaryText: (t: (key: string, opts?: Record<string, unknown>) => string, selection: unknown) =>
    selection ? 'persona-summary-fixture' : t('bots.persona.summaryUnset'),
}));
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));
vi.mock('@/components/new-chat/VendorSegmentedSwitcher', () => ({
  VendorSegmentedSwitcher: () => <div data-testid="vendor-switcher" />,
}));
vi.mock('@/hooks/useAvailableAgents', () => ({
  useAvailableAgents: () => ({ availableVendors: new Set(['cc', 'codex', 'pi']), loaded: true }),
}));
vi.mock('@/state/newMakerDraft', () => ({
  getDraft: () => ({
    lastByVendor: {
      cc: { model: 'claude-x', providerId: null, effort: 'medium' },
      codex: { model: 'codex-x', providerId: null, effort: 'medium' },
      pi: { model: 'pi-x', providerId: null, effort: 'medium' },
    },
    fastModeByModel: {},
  }),
}));

import { BotSettings } from '../BotsHomeView';
import {
  peekPendingBotPersonaAck,
  resetPendingBotPersonaAckForTests,
} from '../botPersonaAck';

function capabilities(overrides: Partial<BotCapabilities> = {}): BotCapabilities {
  return {
    model: 'claude-x',
    providerId: null,
    effort: 'medium',
    fastMode: false,
    harness: 'claude',
    skillMode: 'inherit',
    toolsetMode: 'inherit',
    toolsets: [],
    mcpMode: 'inherit',
    mcpServers: [],
    memory: true,
    automation: false,
    permissions: 'ask',
    sessionControlMode: 'none',
    ...overrides,
  };
}

function bot(overrides: Partial<BotProfile> = {}): BotProfile {
  return {
    id: 'bot-1',
    name: 'PR steward',
    channel: 'local',
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
    createdAt: 0,
    sessions: [
      {
        id: 'bot-1-chat',
        title: 'Chat',
        kind: 'chat',
        channel: 'local',
        updatedAt: 0,
        profileVersion: 1,
      },
    ],
    channels: [],
    projectBindings: [],
    routes: [],
    ...overrides,
  };
}

function connection(overrides: Partial<BotChannelConnection> = {}): BotChannelConnection {
  return {
    id: 'conn-1',
    kind: 'feishu',
    ownership: 'local-adapter',
    status: 'connected',
    connected: true,
    accountKey: 'acct-1',
    accountName: 'Work Feishu',
    scopeKey: null,
    routable: true,
    features: [],
    ...overrides,
  };
}

function renderSettings(overrides: Partial<BotProfile> = {}, initialSearch = 'settings=1') {
  mocks.initialSearch = initialSearch;
  const onBack = vi.fn();
  const view = render(
    <BotSettings
      bot={bot(overrides)}
      onBack={onBack}
      onRenew={vi.fn(async () => false)}
      onOpenSession={vi.fn()}
      renewing={false}
    />,
  );
  return { ...view, onBack };
}

const defaultUpdateBotProfile = async (_id: string, patch: Record<string, unknown>) => ({
  id: 'bot-1',
  currentVersion: 1,
  ...patch,
});

const emptyMemoryApi = {
  list: vi.fn(async () => []),
  delete: vi.fn(async () => ({ ok: true as const })),
  clear: vi.fn(async () => ({ removedCount: 0 })),
};

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.updateBotProfile.mockReset();
  // mockImplementation(Once) in the autosave suite must not leak into other tests.
  mocks.updateBotProfile.mockImplementation(defaultUpdateBotProfile as never);
  mocks.listBotChannelConnections.mockReset();
  mocks.listBotChannelConnections.mockResolvedValue([]);
  mocks.upsertBotProjectBinding.mockReset();
  mocks.upsertBotProjectBinding.mockResolvedValue(undefined as never);
  mocks.archiveBotProjectBinding.mockReset();
  mocks.archiveBotProjectBinding.mockResolvedValue(undefined as never);
  mocks.initialSearch = '';
  mocks.currentSearch = '';
  scrollToSpy.mockClear();
  scrollIntoViewSpy.mockClear();
  emptyMemoryApi.list.mockReset();
  emptyMemoryApi.list.mockResolvedValue([]);
  emptyMemoryApi.delete.mockReset();
  emptyMemoryApi.clear.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    showOpenDirectoryDialog: vi.fn(async () => ({ canceled: true, path: null })),
    maker: { botMemory: emptyMemoryApi },
  };
});

afterEach(() => {
  cleanup();
});

describe('Bot settings page structure', () => {
  it('shows all four blocks plus a collapsed Advanced link on one page, with no tab list', () => {
    renderSettings();

    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByText('bots.settingsBlocks.who')).toBeTruthy();
    expect(screen.getByText('bots.settingsBlocks.can')).toBeTruthy();
    expect(screen.getByText('bots.settingsBlocks.understand')).toBeTruthy();
    // "TA 的日程" has no block heading of its own — BotAutomationSettings owns it.
    expect(screen.getByTestId('bot-automation-settings')).toBeTruthy();
    expect(screen.getByText('bots.advancedLinkLabel')).toBeTruthy();

    // Advanced starts collapsed: its heavy/technical content is not mounted.
    expect(screen.queryByTestId('bot-lifecycle-settings')).toBeNull();
    expect(screen.queryByTestId('bot-route-settings')).toBeNull();
    expect(screen.queryByTestId('bot-project-settings')).toBeNull();
    expect(screen.queryByTestId('bot-event-inbox-settings')).toBeNull();
    expect(screen.queryByTestId('model-selector')).toBeNull();
    expect(screen.queryByTestId('vendor-switcher')).toBeNull();
    expect(screen.queryByTestId('bot-capability-settings')).toBeNull();
  });

  it('lists the blocks top-to-bottom in canonical order', () => {
    renderSettings();
    const container = screen.getByRole('main');
    const order = [
      'bots.settingsBlocks.who',
      'bots.settingsBlocks.can',
      'bots.settingsBlocks.understand',
      'bots.advancedLinkLabel',
    ].map((text) => container.textContent!.indexOf(text));
    expect(order.every((index) => index !== -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('expands Advanced in place on click, alongside (not instead of) the rest of the page', () => {
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'bots.advancedLinkLabel' }));

    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
    expect(screen.getByTestId('bot-route-settings')).toBeTruthy();
    expect(screen.getByTestId('bot-project-settings')).toBeTruthy();
    expect(screen.getByTestId('bot-event-inbox-settings')).toBeTruthy();
    expect(screen.getByTestId('model-selector')).toBeTruthy();
    expect(screen.getByTestId('vendor-switcher')).toBeTruthy();
    expect(screen.getByTestId('bot-capability-settings')).toBeTruthy();
    // The other blocks are still on the page — this is one page, not a tab swap.
    expect(screen.getByText('bots.settingsBlocks.who')).toBeTruthy();
    expect(screen.getByText('bots.settingsBlocks.can')).toBeTruthy();
    expect(screen.getByText('bots.settingsBlocks.understand')).toBeTruthy();
    expect(screen.getByTestId('bot-automation-settings')).toBeTruthy();
  });

  it('has no bottom save bar at all, collapsed or expanded — settings persist on their own', () => {
    renderSettings();
    expect(screen.queryByRole('button', { name: 'bots.save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.cancel' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'bots.advancedLinkLabel' }));
    expect(screen.queryByRole('button', { name: 'bots.save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.cancel' })).toBeNull();
  });

  it('says what each block is for, in one plain line under its title', () => {
    renderSettings();

    // 四个标题都是「TA 怎样怎样」;不说清楚这一块要用户做什么,人会以为四块都得填。
    expect(screen.getByText('bots.settingsBlocks.whoDescription')).toBeTruthy();
    expect(screen.getByText('bots.settingsBlocks.canDescription')).toBeTruthy();
    expect(screen.getByText('bots.settingsBlocks.understandDescription')).toBeTruthy();
  });

  it('carries the memory / know-how footnotes so the lists explain themselves', async () => {
    renderSettings();

    expect(await screen.findByText('bots.memoryList.footnote')).toBeTruthy();
    expect(screen.getByText('bots.learned.footnote')).toBeTruthy();
    expect(screen.getByText('bots.abilityWall.footnote')).toBeTruthy();
    expect(screen.getByText('bots.folders.footnote')).toBeTruthy();
  });

  it('answers "who is this and how long have they been around" right under the name', () => {
    renderSettings({ createdAt: Date.now() });

    // kicker 是「设置」——旁边就是伙伴名,再说一遍「伙伴」是冗余。
    expect(screen.getByText('bots.settings')).toBeTruthy();
    // 「{定位} · 今天加入」,口语相对时长,不是「加入 N 天」。
    expect(screen.getByText('Delivery steward · bots.joined.today:{"n":0}')).toBeTruthy();
  });

  it('keeps the joined line honest when the teammate has been around a while', () => {
    renderSettings({ createdAt: Date.now() - 3 * 24 * 60 * 60 * 1_000 });
    expect(screen.getByText('Delivery steward · bots.joined.days:{"n":3}')).toBeTruthy();
  });

  it('drops "Local Bot" out of the identity card — it is a delivery detail, not who they are', () => {
    renderSettings();
    expect(screen.queryByText(/bots\.channelLabel/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'bots.advancedLinkLabel' }));
    expect(screen.getByText(/bots\.channelLabel/)).toBeTruthy();
  });

  it('never marks the settings header, trusted or not', () => {
    /*
      产品裁决 2026-08-18:设置页头部不再挂 ⚠。伙伴不是需要被常年警告的对象。
      2026-08-19 起连 BotTrustedBadge 组件与 bots.trustedBadge.* 文案都删掉了
      (零引用的幽灵物),所以这里不能再按那个 i18n key 断言 —— key 没了,断言
      永远成立,等于失去守卫。改查 ⚠ 图标本身(lucide 的稳定类名),这样谁把
      徽标以任何形式重新画回来都会红。
    */
    renderSettings();
    expect(document.querySelector('.lucide-triangle-alert')).toBeNull();

    cleanup();
    renderSettings({ capabilities: capabilities({ permissions: 'trusted' }) });
    expect(document.querySelector('.lucide-triangle-alert')).toBeNull();
  });
});

describe('Bot settings deep links (legacy ?tab= and new ?anchor=)', () => {
  it('lands at the top of the page with Advanced collapsed when there is no ?tab= param', () => {
    renderSettings({}, 'settings=1');
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0 });
    expect(screen.queryByTestId('bot-lifecycle-settings')).toBeNull();
  });

  it('scrolls to the matching block for a current anchor id instead of switching panels', () => {
    renderSettings({}, 'settings=1&anchor=understand');
    expect(scrollIntoViewSpy).toHaveBeenCalled();
    expect(scrollToSpy).not.toHaveBeenCalledWith({ top: 0 });
    // The rest of the page is still mounted — an anchor is a scroll target, not a filter.
    expect(screen.getByText('bots.settingsBlocks.who')).toBeTruthy();
  });

  it('auto-expands Advanced for legacy ?tab=capabilities, ?tab=notifications and ?tab=advanced', () => {
    for (const legacyTab of ['capabilities', 'notifications', 'advanced']) {
      cleanup();
      renderSettings({}, `settings=1&tab=${legacyTab}`);
      expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
    }
  });

  it('keeps Advanced collapsed for legacy tabs that map to a top-level block', () => {
    for (const legacyTab of ['identity', 'channels', 'automation', 'projects']) {
      cleanup();
      renderSettings({}, `settings=1&tab=${legacyTab}`);
      expect(screen.queryByTestId('bot-lifecycle-settings')).toBeNull();
      expect(scrollIntoViewSpy).toHaveBeenCalled();
    }
  });

  it('falls back to the top of the page for an unknown ?tab= value instead of a blank panel', () => {
    renderSettings({}, 'settings=1&tab=not-a-real-tab');
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0 });
    expect(screen.queryByTestId('bot-lifecycle-settings')).toBeNull();
    expect(screen.getByText('bots.settingsBlocks.who')).toBeTruthy();
  });
});

describe('TA 是谁 — persona summary and adjust wizard', () => {
  it('shows the unset summary and opens the wizard from the adjust button', () => {
    renderSettings();
    expect(screen.getByText('bots.persona.summaryUnset')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'bots.persona.adjustButton' }));
    expect(screen.getByRole('dialog', { name: 'persona-wizard-fixture' })).toBeTruthy();
  });

  it('shows a compiled summary once identitySource carries a persona marker', () => {
    renderSettings({
      identitySource:
        '<!--persona:v1:{"style":"concise","proactivity":"reactive","call":"name"}-->\nzh\nen',
    });
    expect(screen.getByText('persona-summary-fixture')).toBeTruthy();
    expect(screen.queryByText('bots.persona.summaryUnset')).toBeNull();
  });
});

describe('TA 记得的 — memory list', () => {
  it('renders the real, engine-backed memory list when capabilities.memory is on (the default)', async () => {
    emptyMemoryApi.list.mockResolvedValue([
      {
        filename: 'a.md',
        slug: 'a',
        frontmatter: {
          title: 'Likes short replies',
          description: 'Noted from chat',
          type: 'note',
          updatedAt: '2026-01-01',
        },
        body: '',
        sizeBytes: 12,
      },
    ] as never);
    renderSettings();

    expect(await screen.findByText('Likes short replies')).toBeTruthy();
    expect(screen.queryByText('bots.memoryRecovery.title')).toBeNull();
  });

  it('shows an honest empty state rather than fabricated memories', async () => {
    emptyMemoryApi.list.mockResolvedValue([]);
    renderSettings();
    expect(await screen.findByText('bots.memoryList.empty')).toBeTruthy();
  });

  it('offers a recovery affordance instead of the list when memory is off, and turns it back on', async () => {
    renderSettings({ capabilities: capabilities({ memory: false }) });
    expect(screen.getByText('bots.memoryRecovery.title')).toBeTruthy();
    expect(screen.queryByText('bots.memoryList.title')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'bots.memoryRecovery.action' }));
    await waitFor(() => expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1));
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      capabilities: expect.objectContaining({ memory: true }),
    });
  });

  it('keeps an honest "TA 学会的" empty state when nothing carries the learned- convention', async () => {
    emptyMemoryApi.list.mockResolvedValue([]);
    renderSettings();
    expect(screen.getByText('bots.learned.title')).toBeTruthy();
    expect(await screen.findByText('bots.learned.empty')).toBeTruthy();
  });
});

/**
 * 批次 ε:「TA 学会的」不再是占位——它和「TA 记得的」是同一份伙伴记忆分域的两个
 * 切片,按 `learned-` slug 前缀切开(见 botGrowth.partitionBotMemoryRecords)。
 */
describe('TA 学会的 — learned list', () => {
  const record = (slug: string, title: string, type = 'user') => ({
    filename: `${type}_${slug}.md`,
    slug,
    frontmatter: {
      title,
      description: 'from a real task',
      type,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    body: '',
    sizeBytes: 12,
  });

  it('splits one memory fetch into 记得的 / 学会的 instead of showing a memory twice', async () => {
    emptyMemoryApi.list.mockResolvedValue([
      record('reply-style', 'Likes short replies'),
      record('learned-shrink-email', 'Shrinks long mail to three lines', 'reference'),
    ] as never);
    renderSettings();

    const learned = await screen.findByTestId('bot-learned-list');
    expect(within(learned).getByText('Shrinks long mail to three lines')).toBeTruthy();
    expect(within(learned).queryByText('Likes short replies')).toBeNull();

    const memory = screen.getByTestId('bot-memory-list');
    expect(within(memory).getByText('Likes short replies')).toBeTruthy();
    expect(within(memory).queryByText('Shrinks long mail to three lines')).toBeNull();
    // 一次 IPC 供两个列表,删除后两边同步刷新。
    expect(emptyMemoryApi.list).toHaveBeenCalledTimes(1);
  });

  it('hides the digest shard from both lists — it is a system compaction artifact', async () => {
    emptyMemoryApi.list.mockResolvedValue([
      record('auto-1', 'Internal digest', 'digest'),
      record('learned-auto', 'Internal learned digest', 'digest'),
    ] as never);
    renderSettings();

    expect(await screen.findByText('bots.memoryList.empty')).toBeTruthy();
    expect(screen.getByText('bots.learned.empty')).toBeTruthy();
    expect(screen.queryByText('Internal digest')).toBeNull();
    expect(screen.queryByText('Internal learned digest')).toBeNull();
  });

  it('highlights the list the growth footnote pointed at, then lets the highlight fade', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      emptyMemoryApi.list.mockResolvedValue([]);
      renderSettings({}, 'settings=1&anchor=who&highlight=learned');

      await waitFor(() =>
        expect(screen.getByTestId('bot-learned-list').className).toContain('ring-2'),
      );
      expect(screen.getByTestId('bot-memory-list').className).not.toContain('ring-2');

      act(() => {
        vi.advanceTimersByTime(3000);
      });
      await waitFor(() =>
        expect(screen.getByTestId('bot-learned-list').className).not.toContain('ring-2'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('highlights 记得的 when the footnote was about a plain memory', async () => {
    emptyMemoryApi.list.mockResolvedValue([]);
    renderSettings({}, 'settings=1&anchor=who&highlight=memory');
    await waitFor(() => expect(screen.getByTestId('bot-memory-list').className).toContain('ring-2'));
    expect(screen.getByTestId('bot-learned-list').className).not.toContain('ring-2');
  });

  it('does not highlight anything on an ordinary settings visit', async () => {
    emptyMemoryApi.list.mockResolvedValue([]);
    renderSettings();
    await screen.findByText('bots.memoryList.empty');
    expect(screen.getByTestId('bot-memory-list').className).not.toContain('ring-2');
    expect(screen.getByTestId('bot-learned-list').className).not.toContain('ring-2');
  });
});

describe('TA 会的 — ability wall and single-IM mutual exclusion', () => {
  it('shows built-in abilities as plain statements — no toggle for any of them', () => {
    renderSettings();
    expect(screen.getByText('bots.abilityWall.abilities.writing')).toBeTruthy();
    expect(screen.getByText('bots.abilityWall.abilities.research')).toBeTruthy();
    expect(screen.getByText('bots.abilityWall.abilities.doing')).toBeTruthy();
    expect(screen.getByText('bots.abilityWall.abilities.schedule')).toBeTruthy();
    expect(screen.getByText('bots.abilityWall.abilities.collab')).toBeTruthy();
    // No permission/automation switches leak into the collapsed top-level page.
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
  });

  it('greys out the other IM channels once one is connected, with a disconnect hint', async () => {
    mocks.listBotChannelConnections.mockResolvedValue([
      connection({ id: 'feishu-conn', kind: 'feishu', accountKey: 'a' }),
      connection({ id: 'telegram-conn', kind: 'telegram', accountKey: 'b', accountName: 'Ops TG' }),
    ]);
    renderSettings({
      channels: [
        {
          id: 'ch-feishu',
          kind: 'feishu',
          enabled: true,
          config: { accountKey: 'a', ownership: 'local-adapter' },
        },
      ] as never,
    });

    // Every other IM kind (including ones with no connected account at all) is
    // also gated — applyImMutualExclusion blocks any non-mounted IM chip, not
    // just ones with a live account. Scope the assertion to Telegram's own row.
    const telegramLabel = await screen.findByText('Telegram · Ops TG');
    const telegramRow = telegramLabel.closest('.min-w-0')!.parentElement as HTMLElement;
    const telegramButton = within(telegramRow).getByRole('button');
    expect((telegramButton as HTMLButtonElement).disabled).toBe(true);
    expect(
      within(telegramRow).getByText('bots.abilityWall.imBlocked:{"channel":"Feishu"}'),
    ).toBeTruthy();
  });

  it('never blocks a channel that is itself mounted — a pre-existing multi-IM bot keeps every connection', async () => {
    mocks.listBotChannelConnections.mockResolvedValue([
      connection({ id: 'feishu-conn', kind: 'feishu', accountKey: 'a' }),
      connection({ id: 'telegram-conn', kind: 'telegram', accountKey: 'b', accountName: 'Ops TG' }),
    ]);
    renderSettings({
      channels: [
        { id: 'ch-feishu', kind: 'feishu', enabled: true, config: { accountKey: 'a', ownership: 'local-adapter' } },
        { id: 'ch-telegram', kind: 'telegram', enabled: true, config: { accountKey: 'b', ownership: 'local-adapter' } },
      ] as never,
    });

    // 已连的行给的是「断开」——它是这个按钮真会做的事;「已挂载」既是实现词,
    // 又把一个动作说成了状态,用户看不出点下去会发生什么。
    const mountedButtons = await screen.findAllByRole('button', {
      name: 'bots.channelDisconnect',
    });
    expect(mountedButtons).toHaveLength(2);
    for (const button of mountedButtons) {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    }
    const feishuRow = screen.getByText('Feishu · Work Feishu').closest('.min-w-0')!
      .parentElement as HTMLElement;
    const telegramRow = screen.getByText('Telegram · Ops TG').closest('.min-w-0')!
      .parentElement as HTMLElement;
    expect(within(feishuRow).queryByText(/bots\.abilityWall\.imBlocked/)).toBeNull();
    expect(within(telegramRow).queryByText(/bots\.abilityWall\.imBlocked/)).toBeNull();
  });

  /*
    裁决 2026-08-19:没有账号的渠道行不再是「置灰 + 先去设置里连」的死路。
    它现在可点,直接落到该渠道**真实**的连接界面(设置 › IM 机器人 的对应
    分区,个人分区还会把那张手风琴卡展开)。
  */
  it('takes an account-less channel row straight to that channel\'s real connect UI', async () => {
    mocks.listBotChannelConnections.mockResolvedValue([]);
    renderSettings();

    // 占位行的标题只有渠道名(没有 ` · 账号`)。
    const wecomRow = (await screen.findByText('Wecom')).closest('.min-w-0')!
      .parentElement as HTMLElement;
    const connectButton = within(wecomRow).getByRole('button', {
      name: 'bots.abilityWall.connectAccount',
    });
    expect((connectButton as HTMLButtonElement).disabled).toBe(false);
    // 「先在设置里连接 X 账号」那句死路话术连同它的 i18n key 一起没了;整个
    // capabilityChips 命名空间的回归守卫在下面「一颗 Switch 都不剩」那条里。

    fireEvent.click(connectButton);
    expect(mocks.navigate).toHaveBeenCalledWith(
      '/settings?tab=im-bot&imGroup=personal&imChannel=wecom',
    );
  });

  it('sends Slack to the Cindy relay group, not the personal one', async () => {
    mocks.listBotChannelConnections.mockResolvedValue([]);
    renderSettings();

    const slackRow = (await screen.findByText('Slack')).closest('.min-w-0')!
      .parentElement as HTMLElement;
    fireEvent.click(
      within(slackRow).getByRole('button', { name: 'bots.abilityWall.connectAccount' }),
    );
    expect(mocks.navigate).toHaveBeenCalledWith('/settings?tab=im-bot&imGroup=cindy');
  });
});

describe('TA 懂的 — folder cards', () => {
  it('shows bound folders and adds another via the directory picker', async () => {
    renderSettings({
      projectBindings: [
        {
          id: 'binding-1',
          workingDir: '/Users/chris/Code/cindy',
          defaultBranch: null,
          workspacePolicy: 'none',
          isDefault: true,
          allowedPaths: [],
          status: 'active',
        } as never,
      ],
    });
    expect(screen.getByText('cindy')).toBeTruthy();

    (window.electronAPI.showOpenDirectoryDialog as ReturnType<typeof vi.fn>).mockResolvedValue({
      canceled: false,
      path: '/Users/chris/Code/other-repo',
    });
    fireEvent.click(screen.getByRole('button', { name: 'bots.folders.addButton' }));

    await waitFor(() => expect(mocks.upsertBotProjectBinding).toHaveBeenCalledTimes(1));
    expect(mocks.upsertBotProjectBinding.mock.calls[0]?.[1]).toMatchObject({
      workingDir: '/Users/chris/Code/other-repo',
    });
  });
});

describe('TA 的日程 — schedule embedded without an automation precondition', () => {
  it('embeds automation settings directly, with no capability gate in front of it', () => {
    renderSettings({ capabilities: capabilities({ automation: false }) });
    expect(screen.getByTestId('bot-automation-settings')).toBeTruthy();
  });

  /*
    「它会做什么」那张芯片墙整块下线了(裁决 2026-08-19)。

     - 「定时干活」:自动化是标配,chip 却常年显示「关」而 Routine 建了就会跑;
     - 「动手做事」:和对话输入框里的权限 chip 是同一个 capabilities.permissions,
       两个入口管一件事迟早再长出一对矛盾说法 —— 唯一控制点收敛到输入框;
     - 渠道行:与「TA 会的 › 可以连上」重复,而且只有这份带踢皮球话术。

    所以这条锁的是**整页展开后一颗 Switch 都不剩**:芯片墙如果被谁重新装回来,
    不管装的是哪一颗,这里都会红。
  */
  it('has no capability switches left anywhere on the page, advanced included', () => {
    renderSettings({ capabilities: capabilities({ automation: false, permissions: 'ask' }) });
    fireEvent.click(screen.getByRole('button', { name: 'bots.advancedLinkLabel' }));
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    // 连 i18n key 都不该再被任何组件引用。
    expect(screen.queryByText(/bots\.capabilityChips\./)).toBeNull();
  });

  /*
    芯片墙拆掉时,它身上两条与开关无关的信息不能跟着消失 —— 它们讲的是
    「Profile 版本 vs 正在跑的任务」,和 Renew 按钮同属一件事,所以搬到了
    「任务生命周期」。
  */
  it('keeps the runtime-state pill and the "Renew to apply" note next to the Renew button', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.advancedLinkLabel' }));
    const lifecycle = screen.getByText('bots.sessionLifecycleTitle').closest('section')!;
    expect(within(lifecycle).getByText(/bots\.runtimeState\./)).toBeTruthy();
    expect(within(lifecycle).getByText('bots.capabilitiesDeferred')).toBeTruthy();
    expect(within(lifecycle).getByRole('button', { name: /bots\.renew/ })).toBeTruthy();
  });
});

describe('Bot settings archived-bot reachability', () => {
  it('keeps the pre-existing archived-bot settings page untouched by the one-page rework', () => {
    renderSettings({ status: 'archived' });

    // The archived branch renders its own minimal page and never mounts the settings page.
    expect(screen.queryByText('bots.settingsBlocks.who')).toBeNull();
    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
    expect(screen.getByTestId('bot-event-inbox-settings')).toBeTruthy();
  });

  it('never writes a profile update for an archived (read-only) Bot', () => {
    const view = renderSettings({ status: 'archived' });
    view.unmount();

    // Autosave must not turn a read-only surface into a writer.
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
  });
});

describe('Bot settings autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it('merges a typing burst into one profile update after the debounce window', async () => {
    renderSettings();
    const input = screen.getByDisplayValue('PR steward');

    for (const value of ['PR stewar', 'PR stewa', 'PR stew', 'PR crew']) {
      fireEvent.change(input, { target: { value } });
      await advance(300);
      expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    }

    await advance(1300);
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({ name: 'PR crew' });
  });

  it('saves an instant edit (turning memory back on) without waiting out the text debounce', async () => {
    renderSettings({ capabilities: capabilities({ memory: false }) });

    fireEvent.click(screen.getByRole('button', { name: 'bots.memoryRecovery.action' }));
    await advance(0);

    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      capabilities: expect.objectContaining({ memory: true }),
    });
  });

  it('compiles a persona wizard save into identitySource and autosaves it instantly', async () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.persona.adjustButton' }));
    fireEvent.click(screen.getByRole('button', { name: 'persona-wizard-save' }));
    await advance(0);

    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      identitySource: expect.stringContaining('<!--persona:v1:'),
    });
    expect(screen.getByText('persona-summary-fixture')).toBeTruthy();
  });

  it('takes the user back to the conversation after saving a persona', async () => {
    // 「调整性格」是从对话里点进来的。改完停在设置页,用户得自己再点一次返回
    // 才听得到新口气 —— 保存即回对话。
    const { onBack } = renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.persona.adjustButton' }));
    fireEvent.click(screen.getByRole('button', { name: 'persona-wizard-save' }));
    await advance(0);

    expect(onBack).toHaveBeenCalledTimes(1);
    // 回对话之前必须先把新性格存下去,而且存的是**新**值不是旧值。
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      identitySource: expect.stringContaining('"style":"lively"'),
    });
  });

  it('parks a persona confirmation for the conversation to deliver', async () => {
    resetPendingBotPersonaAckForTests();
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.persona.adjustButton' }));
    fireEvent.click(screen.getByRole('button', { name: 'persona-wizard-save' }));
    await advance(0);

    expect(peekPendingBotPersonaAck('bot-1')).toMatchObject({
      style: 'lively',
      proactivity: 'proactive',
      call: 'boss',
    });
  });

  it('parks nothing when the wizard is saved without changing the persona', async () => {
    resetPendingBotPersonaAckForTests();
    // 已经就是向导那份选择了:再保存一次不该让 TA 又说一遍「以后就这么说话」。
    renderSettings({
      identitySource:
        '<!--persona:v1:{"style":"lively","proactivity":"proactive","call":"boss"}-->\nzh\nen',
    });
    fireEvent.click(screen.getByRole('button', { name: 'bots.persona.adjustButton' }));
    fireEvent.click(screen.getByRole('button', { name: 'persona-wizard-save' }));
    await advance(0);

    expect(peekPendingBotPersonaAck('bot-1')).toBeNull();
    // 但「回对话」照做 —— 用户点的是保存,不是取消。
  });

  it('sends nothing when the page is only opened, or when an edit is reverted', async () => {
    renderSettings();
    await advance(3000);
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();

    const input = screen.getByDisplayValue('PR steward');
    fireEvent.change(input, { target: { value: 'PR stewardz' } });
    fireEvent.change(input, { target: { value: 'PR steward' } });
    await advance(3000);
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
  });

  it('flushes a still-pending edit when the settings view unmounts', async () => {
    const view = renderSettings({}, 'settings=1&tab=advanced');
    fireEvent.change(screen.getByDisplayValue('Delivery steward'), {
      target: { value: 'Reviews and merges' },
    });

    // Well inside the debounce window — the old UI would have dropped this.
    view.unmount();

    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      description: 'Reviews and merges',
    });
  });

  it('flushes on blur so long user-profile prompts do not wait for the debounce', async () => {
    renderSettings({}, 'settings=1&tab=advanced');
    const textarea = screen.getByPlaceholderText('bots.userContextSourcePlaceholder');
    fireEvent.change(textarea, { target: { value: 'Call me Chris, keep replies short.' } });
    fireEvent.blur(textarea);
    await advance(0);

    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      userContextSource: 'Call me Chris, keep replies short.',
    });
  });

  it('shows a saving indicator and then a transient saved mark', async () => {
    let release: (() => void) | null = null;
    mocks.updateBotProfile.mockImplementationOnce(async (_id, patch) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { id: 'bot-1', currentVersion: 1, ...patch } as never;
    });

    renderSettings();
    fireEvent.change(screen.getByDisplayValue('PR steward'), { target: { value: 'PR crew' } });
    await advance(1300);
    expect(screen.getByText('bots.autosave.saving')).toBeTruthy();

    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('bots.autosave.saved')).toBeTruthy();

    // "Saved" is a confirmation, not a permanent badge.
    await advance(2500);
    expect(screen.queryByText('bots.autosave.saved')).toBeNull();
  });

  it('surfaces a failure with a retry that re-sends the same change', async () => {
    mocks.updateBotProfile.mockRejectedValueOnce(new Error('ipc down'));

    renderSettings();
    fireEvent.change(screen.getByDisplayValue('PR steward'), { target: { value: 'PR crew' } });
    await advance(1300);

    expect(screen.getByRole('alert').textContent).toContain('bots.profileApply.saveFailed');
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'bots.autosave.retry' }));
    await advance(0);

    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(2);
    expect(mocks.updateBotProfile.mock.calls[1]?.[1]).toMatchObject({ name: 'PR crew' });
    expect(screen.queryByRole('button', { name: 'bots.autosave.retry' })).toBeNull();
  });

  it('flushes before leaving for the chat, and stays put when that save fails', async () => {
    mocks.updateBotProfile.mockRejectedValueOnce(new Error('ipc down'));
    const view = renderSettings();
    fireEvent.change(screen.getByDisplayValue('PR steward'), { target: { value: 'PR crew' } });

    fireEvent.click(screen.getByRole('button', { name: 'bots.backToChat' }));
    await advance(0);

    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(view.onBack).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('bots.profileApply.saveFailed');

    fireEvent.click(screen.getByRole('button', { name: 'bots.backToChat' }));
    await advance(0);
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(2);
    expect(view.onBack).toHaveBeenCalledTimes(1);
  });

  it('defers the "apply to current task" prompt to the moment the user leaves', async () => {
    // The canonical chat is on v1 while the save produces v2: the pre-existing
    // renew prompt still fires — but only at the exit boundary, so a background
    // autosave never throws a modal over someone who is mid-sentence.
    mocks.updateBotProfile.mockImplementationOnce(async (_id, patch) => ({
      id: 'bot-1',
      currentVersion: 2,
      ...patch,
    }));

    const view = renderSettings();
    fireEvent.change(screen.getByDisplayValue('PR steward'), { target: { value: 'PR crew' } });
    await advance(1300);

    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('bots.profileApply.title')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'bots.backToChat' }));
    await advance(0);

    expect(screen.getByText('bots.profileApply.title')).toBeTruthy();
    expect(view.onBack).not.toHaveBeenCalled();
  });
});
