// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotCapabilities, BotProfile } from '../botStore';

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
  setCanonicalBotSession: vi.fn(),
  useBotProfiles: () => [],
}));

// The real growth lists call useConfirmDialog() unconditionally, and they are now
// reachable by default (capabilities.memory defaults to true) — same pattern
// botAutomationSettings.test.tsx already uses for RunHistory's retry flow.
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }),
}));

vi.mock('../BotAvatar', () => ({
  BotAvatar: () => <div data-testid="bot-avatar" />,
}));
vi.mock('../BotLifecycleSettings', () => ({
  BotLifecycleSettings: () => <div data-testid="bot-lifecycle-settings" />,
}));
// The wizard's own compile/decompile/roundtrip behavior is covered exhaustively
// by botPersona.test.ts; here we only need a fixture that proves BotsHomeView
// wires `identitySource`/`onSave` through to the autosave pipeline correctly.
vi.mock('../BotPersonaWizard', () => ({
  DEFAULT_PERSONA_SELECTION: {
    style: 'concise',
    proactivity: 'reactive',
    call: 'name',
  },
  PersonaEditorFields: () => <div data-testid="persona-editor-fields" />,
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
  personaSummaryText: (
    t: (key: string, opts?: Record<string, unknown>) => string,
    selection: unknown,
  ) => (selection ? 'persona-summary-fixture' : t('bots.persona.summaryUnset')),
}));
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: (props: {
    unifiedPanel?: boolean;
    unifiedSelectionPolicy?: string;
    unifiedLayout?: string;
    unifiedLayoutControls?: boolean;
  }) => (
    <div
      data-testid="model-selector"
      data-unified-panel={String(props.unifiedPanel === true)}
      data-selection-policy={props.unifiedSelectionPolicy}
      data-layout={props.unifiedLayout}
      data-layout-controls={String(props.unifiedLayoutControls !== false)}
    />
  ),
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
import { peekPendingBotPersonaAck, resetPendingBotPersonaAckForTests } from '../botPersonaAck';

function capabilities(overrides: Partial<BotCapabilities> = {}): BotCapabilities {
  return {
    model: 'claude-x',
    providerId: null,
    effort: 'medium',
    fastMode: false,
    harness: 'claude',
    modelChain: [{ harness: 'claude', model: 'claude-x', providerId: null, effort: 'medium', fastMode: false }],
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
    ...overrides,
  };
}

function renderSettings(overrides: Partial<BotProfile> = {}, initialSearch = 'settings=1') {
  mocks.initialSearch = initialSearch;
  const onBack = vi.fn();
  const onOpenSession = vi.fn();
  const view = render(
    <BotSettings
      bot={bot(overrides)}
      onBack={onBack}
      onOpenSession={onOpenSession}
    />,
  );
  return { ...view, onBack, onOpenSession };
}

function openTab(tab: string): void {
  fireEvent.click(screen.getByRole('tab', { name: `bots.settingsTabs.${tab}` }));
}

function openProfileEditor(): void {
  fireEvent.click(screen.getByRole('button', { name: 'bots.editProfile' }));
}

function renderTabSettings(
  tab: 'growth' | 'model' | 'maintenance',
  overrides: Partial<BotProfile> = {},
  initialSearch = 'settings=1',
) {
  const view = renderSettings(overrides, initialSearch);
  openTab(tab);
  return view;
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
  it('shows the two-column identity sidebar, primary actions, and three category tabs', () => {
    renderSettings();

    expect(screen.getByTestId('bot-avatar')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'PR steward' })).toBeTruthy();
    const responsibilities = screen
      .getByRole('button', { name: 'bots.background.edit' })
      .querySelector('[title]') as HTMLElement;
    expect(responsibilities).toBeTruthy();
    expect(responsibilities.className).toContain('line-clamp-5');
    expect(responsibilities.className).not.toContain('block');
    expect(screen.getByRole('button', { name: 'bots.persona.adjustButton' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'bots.actions.message' })).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('keeps Bot-owned growth visible without exposing global capability catalogs', () => {
    renderSettings();
    expect(screen.queryByText(/bots\.abilityWall\.abilities\./)).toBeNull();
    expect(screen.queryByText('bots.abilityWall.connectableTitle')).toBeNull();
    expect(screen.getByRole('switch', { name: 'bots.memoryLabel' })).toBeTruthy();
    expect(screen.getByText('bots.advancedIdentity.title')).toBeTruthy();
    expect(screen.queryByText('bots.skillsLabel')).toBeNull();
    expect(screen.queryByText('bots.toolsetsLabel')).toBeNull();
    expect(screen.queryByText('bots.mcpLabel')).toBeNull();
  });

  it('switches between the three categories without duplicating their content', () => {
    renderSettings();
    openTab('growth');
    expect(screen.getByRole('switch', { name: 'bots.memoryLabel' })).toBeTruthy();
    expect(screen.getByText('bots.advancedIdentity.title')).toBeTruthy();
    openTab('model');
    const selector = screen.getByTestId('model-selector');
    expect(selector.getAttribute('data-unified-panel')).toBe('true');
    expect(selector.getAttribute('data-selection-policy')).toBe('official');
    expect(selector.getAttribute('data-layout')).toBe('badge');
    expect(selector.getAttribute('data-layout-controls')).toBe('false');
    expect(screen.getByTestId('bot-model-controls').className).toContain('flex-col');
    expect(screen.queryByRole('switch', { name: 'bots.memoryLabel' })).toBeNull();
    openTab('maintenance');
    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
    expect(screen.queryByText('bots.advancedIdentity.title')).toBeNull();
    expect(screen.queryByTestId('model-selector')).toBeNull();
  });

  it('opens the canonical task from the Message action', () => {
    const { onOpenSession } = renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.actions.message' }));
    expect(onOpenSession).toHaveBeenCalledWith('bot-1-chat');
  });

  it('opens the Model category directly from its canonical deep link', () => {
    renderSettings({}, 'settings=1&tab=model');
    expect(
      screen.getByRole('tab', { name: 'bots.settingsTabs.model' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByTestId('model-selector')).toBeTruthy();
  });

  it('shows the teammate > settings lockup in the global content header without a second back row', () => {
    renderSettings();
    expect(screen.getByRole('button', { name: 'bots.backToChat' }).className).toContain('sr-only');
  });

  it('has no persistent bottom save bar; profile editing uses its own dialog', () => {
    renderSettings();
    expect(screen.queryByRole('button', { name: 'bots.save' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'bots.editProfile' }));
    expect(screen.getByRole('dialog', { name: 'bots.editProfile' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'bots.save' })).toBeTruthy();
  });

  it('shows the joined time in the identity sidebar', () => {
    renderSettings({ createdAt: Date.now() });
    expect(screen.getByText('bots.joined.today:{"n":0}')).toBeTruthy();
  });

  it('keeps the joined line honest when the teammate has been around a while', () => {
    renderSettings({ createdAt: Date.now() - 3 * 24 * 60 * 60 * 1_000 });
    expect(screen.getByText('bots.joined.days:{"n":3}')).toBeTruthy();
  });

  it('never marks the settings header, trusted or not', () => {
    renderSettings();
    expect(document.querySelector('.lucide-triangle-alert')).toBeNull();
    cleanup();
    renderSettings({ capabilities: capabilities({ permissions: 'trusted' }) });
    expect(document.querySelector('.lucide-triangle-alert')).toBeNull();
  });
});

describe('Bot settings deep links (legacy ?tab= and new ?anchor=)', () => {
  it('lands on Growth when there is no category param', () => {
    renderSettings({}, 'settings=1');
    expect(
      screen
        .getByRole('tab', { name: 'bots.settingsTabs.growth' })
        .getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByRole('switch', { name: 'bots.memoryLabel' })).toBeTruthy();
    expect(screen.getByText('bots.advancedIdentity.title')).toBeTruthy();
    expect(screen.queryByTestId('bot-lifecycle-settings')).toBeNull();
  });

  it('falls back to Growth for a retired project anchor that no longer has its own tab', () => {
    renderSettings({}, 'settings=1&anchor=understand');
    expect(screen.getByRole('switch', { name: 'bots.memoryLabel' })).toBeTruthy();

    cleanup();
    renderSettings({}, 'settings=1&anchor=grew');
    expect(screen.getByRole('switch', { name: 'bots.memoryLabel' })).toBeTruthy();
  });

  it('maps legacy capability, notification, and advanced links to their current tabs', () => {
    renderSettings({}, 'settings=1&tab=capabilities');
    expect(screen.getByRole('switch', { name: 'bots.memoryLabel' })).toBeTruthy();
    expect(screen.queryByText('bots.skillsLabel')).toBeNull();

    cleanup();
    renderSettings({}, 'settings=1&tab=notifications');
    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();

    cleanup();
    renderSettings({}, 'settings=1&tab=advanced');
    expect(
      screen.getByRole('tab', { name: 'bots.settingsTabs.growth' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByText('bots.advancedIdentity.title')).toBeTruthy();
  });

  it('keeps legacy identity, channels, and projects links reachable on Growth', () => {
    renderSettings({}, 'settings=1&tab=identity');
    expect(screen.getByRole('switch', { name: 'bots.memoryLabel' })).toBeTruthy();

    cleanup();
    renderSettings({}, 'settings=1&tab=channels');
    expect(screen.getByRole('switch', { name: 'bots.memoryLabel' })).toBeTruthy();

    cleanup();
    renderSettings({}, 'settings=1&tab=projects');
    expect(screen.getByRole('switch', { name: 'bots.memoryLabel' })).toBeTruthy();
  });

  it('falls back to the top of the page for an unknown ?tab= value instead of a blank panel', () => {
    renderSettings({}, 'settings=1&tab=not-a-real-tab');
    expect(screen.queryByTestId('bot-lifecycle-settings')).toBeNull();
    expect(screen.getByRole('switch', { name: 'bots.memoryLabel' })).toBeTruthy();
  });
});

describe('profile persona summary and editor', () => {
  it('shows the unset summary and opens the wizard from the adjust button', () => {
    renderSettings();
    expect(screen.getByRole('button', { name: 'bots.persona.addButton' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'bots.persona.adjustButton' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'bots.persona.addButton' }));
    expect(screen.getByRole('dialog', { name: 'bots.editProfile' })).toBeTruthy();
    expect(screen.getByTestId('persona-editor-fields')).toBeTruthy();
  });

  it('opens the same complete profile editor from Responsibilities', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.background.edit' }));
    expect(screen.getByRole('dialog', { name: 'bots.editProfile' })).toBeTruthy();
    expect(screen.getByTestId('persona-editor-fields')).toBeTruthy();
  });

  it('shows a compiled summary once identitySource carries a persona marker', () => {
    renderSettings({
      identitySource:
        '<!--persona:v1:{"style":"concise","proactivity":"reactive","call":"name"}-->\nzh\nen',
    });
    const personality = screen.getByText('persona-summary-fixture');
    expect(personality.className).toContain('line-clamp-5');
    expect(personality.className).not.toContain('block');
    expect(screen.queryByText('bots.persona.summaryUnset')).toBeNull();
  });
});

/*
  第 9 条:选模板卡时那份完整的角色设定,在设置页要**看得到、改得动**。
  在这之前它只存在于 identitySource 里,界面上一个字都不露。
*/
describe('profile background', () => {
  const TEMPLATE_IDENTITY = '你是本本，项目管家。流程你来盯：评审、检查、交付。';

  it('prints the template background in full, not just a personality summary', () => {
    renderSettings({ identitySource: TEMPLATE_IDENTITY });
    openProfileEditor();
    expect((screen.getByLabelText('bots.background.title') as HTMLTextAreaElement).value).toBe(
      TEMPLATE_IDENTITY,
    );
  });

  it('keeps the wizard block out of the visible background text', () => {
    renderSettings({
      identitySource: `${TEMPLATE_IDENTITY}\n\n<!--persona:v1:{"style":"concise","proactivity":"reactive","call":"name"}-->\nzh\nen`,
    });
    openProfileEditor();
    const shown = (screen.getByLabelText('bots.background.title') as HTMLTextAreaElement).value;
    expect(shown).toBe(TEMPLATE_IDENTITY);
    expect(shown).not.toContain('persona:v1');
  });

  it('shows an honest empty state for a hand-made teammate with no background yet', () => {
    renderSettings({ identitySource: '' });
    openProfileEditor();
    expect((screen.getByLabelText('bots.background.title') as HTMLTextAreaElement).value).toBe('');
  });

  it('shows a real editable textarea immediately — the background is not read-only', () => {
    renderSettings({ identitySource: TEMPLATE_IDENTITY });
    openProfileEditor();

    const textarea = screen.getByLabelText('bots.background.title') as HTMLTextAreaElement;
    expect(textarea.value).toBe(TEMPLATE_IDENTITY);
  });

  /*
    只读态显示的是 identitySource 的**投影**(向导段剥掉 + trim)。把那个投影直接
    接到 textarea 的 value 上,用户敲的行尾空格和刚按下的回车会在下一帧被吃掉 ——
    人根本换不了行。编辑时走独立缓冲,这条钉的就是它。
  */
  it('lets the user type a newline and a trailing space without them vanishing', () => {
    renderSettings({ identitySource: TEMPLATE_IDENTITY });
    openProfileEditor();

    const textarea = screen.getByLabelText('bots.background.title') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '你是本本。\n' } });
    expect(textarea.value).toBe('你是本本。\n');
    fireEvent.change(textarea, { target: { value: '你是本本。\n风险 ' } });
    expect(textarea.value).toBe('你是本本。\n风险 ');
  });

  it('keeps the identity field directly editable instead of returning to a read-only card', () => {
    renderSettings({ identitySource: TEMPLATE_IDENTITY });
    openProfileEditor();
    expect(screen.getByLabelText('bots.background.title')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'bots.background.done' })).toBeNull();
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
    renderTabSettings('growth');

    expect(await screen.findByText('Likes short replies')).toBeTruthy();
    expect(screen.queryByText('bots.memoryRecovery.title')).toBeNull();
  });

  it('shows an honest empty state rather than fabricated memories', async () => {
    emptyMemoryApi.list.mockResolvedValue([]);
    renderTabSettings('growth');
    expect(await screen.findByText('bots.memoryList.empty')).toBeTruthy();
  });

  it('offers a recovery affordance instead of the list when memory is off, and turns it back on', async () => {
    renderTabSettings('growth', { capabilities: capabilities({ memory: false }) });
    expect(screen.getByText('bots.memoryRecovery.description')).toBeTruthy();

    fireEvent.click(screen.getByRole('switch', { name: 'bots.memoryLabel' }));
    await waitFor(() => expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1));
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      capabilities: expect.objectContaining({ memory: true }),
    });
  });

  it('keeps an honest "TA 学会的" empty state when nothing carries the learned- convention', async () => {
    emptyMemoryApi.list.mockResolvedValue([]);
    renderTabSettings('growth');
    expect(screen.getByText('bots.learned.title')).toBeTruthy();
    expect(await screen.findByText('bots.learned.empty')).toBeTruthy();
  });
});

describe('learned list', () => {
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
    renderTabSettings('growth');

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
    renderTabSettings('growth');

    expect(await screen.findByText('bots.memoryList.empty')).toBeTruthy();
    expect(screen.getByText('bots.learned.empty')).toBeTruthy();
    expect(screen.queryByText('Internal digest')).toBeNull();
    expect(screen.queryByText('Internal learned digest')).toBeNull();
  });

  it('highlights the list the growth footnote pointed at, then lets the highlight fade', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      emptyMemoryApi.list.mockResolvedValue([]);
      renderSettings({}, 'settings=1&anchor=grew&highlight=learned');

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
    renderSettings({}, 'settings=1&anchor=grew&highlight=memory');
    await waitFor(() =>
      expect(screen.getByTestId('bot-memory-list').className).toContain('ring-2'),
    );
    expect(screen.getByTestId('bot-learned-list').className).not.toContain('ring-2');
  });

  it('does not highlight anything on an ordinary settings visit', async () => {
    emptyMemoryApi.list.mockResolvedValue([]);
    renderTabSettings('growth');
    await screen.findByText('bots.memoryList.empty');
    expect(screen.getByTestId('bot-memory-list').className).not.toContain('ring-2');
    expect(screen.getByTestId('bot-learned-list').className).not.toContain('ring-2');
  });
});

describe('运行维护 — lifecycle', () => {
  /*
    「它会做什么」那张芯片墙整块下线了(裁决 2026-08-19)。

     - 「定时干活」:自动化是标配,chip 却常年显示「关」而 Routine 建了就会跑;
     - 「动手做事」:和对话输入框里的权限 chip 是同一个 capabilities.permissions,
       两个入口管一件事迟早再长出一对矛盾说法 —— 唯一控制点收敛到输入框;
     - 渠道行:与「TA 会的 › 可以连上」重复,而且只有这份带踢皮球话术。

    所以这条锁的是**整页展开后一颗 Switch 都不剩**:芯片墙如果被谁重新装回来,
    不管装的是哪一颗,这里都会红。
  */
  it('keeps obsolete capability chips out of Maintenance', () => {
    renderSettings({ capabilities: capabilities({ permissions: 'ask' }) });
    openTab('maintenance');
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    // 连 i18n key 都不该再被任何组件引用。
    expect(screen.queryByText(/bots\.capabilityChips\./)).toBeNull();
  });

  /*
    芯片墙拆掉时,它身上两条与开关无关的信息不能跟着消失 —— 它们讲的是
    「Profile 运行态 vs 正在跑的任务」,和上下文压缩同属一件事,所以搬到了
    「任务生命周期」。
  */
  it('keeps health, history, delivery, and renewal together', () => {
    renderSettings();
    openTab('maintenance');
    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
  });
});

describe('Bot settings archived-bot reachability', () => {
  it('keeps archived Bot history and management reachable without inbox diagnostics', () => {
    renderSettings({ status: 'archived' });

    // The archived branch renders its own minimal page and never mounts the settings page.
    expect(screen.queryByText('bots.settingsBlocks.who')).toBeNull();
    expect(screen.getByTestId('bot-lifecycle-settings')).toBeTruthy();
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

  const advancedProfileInput = () => {
    openTab('growth');
    return screen.getByPlaceholderText('bots.userContextSourcePlaceholder');
  };

  it('merges a typing burst into one profile update after the debounce window', async () => {
    renderSettings();
    const input = advancedProfileInput();
    for (const value of ['Call', 'Call me', 'Call me Chris', 'Call me Chris, briefly.']) {
      fireEvent.change(input, { target: { value } });
      await advance(300);
      expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    }
    await advance(1300);
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      userContextSource: 'Call me Chris, briefly.',
    });
  });

  it('saves an instant memory edit without waiting out the text debounce', async () => {
    renderTabSettings('growth', { capabilities: capabilities({ memory: false }) });
    fireEvent.click(screen.getByRole('switch', { name: 'bots.memoryLabel' }));
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

  it('saves the four-field profile dialog through the same autosave channel', async () => {
    renderSettings({ identitySource: '你是本本，项目管家。' });
    openProfileEditor();
    fireEvent.change(screen.getByDisplayValue('PR steward'), { target: { value: 'PR crew' } });
    fireEvent.change(screen.getByDisplayValue('Delivery steward'), {
      target: { value: 'Reviews and merges' },
    });
    fireEvent.change(screen.getByLabelText('bots.background.title'), {
      target: { value: '你是本本，只说结论。' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'bots.save' }));
    await advance(1600);
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      name: 'PR crew',
      description: 'Reviews and merges',
      identitySource: '你是本本，只说结论。',
    });
  });

  it('leaves the personality marker untouched when only the background changes', async () => {
    renderSettings({
      identitySource:
        '你是本本，项目管家。\n\n<!--persona:v1:{"style":"steady","proactivity":"reportAll","call":"boss"}-->\nzh\nen',
    });
    openProfileEditor();
    fireEvent.change(screen.getByLabelText('bots.background.title'), {
      target: { value: '你是本本，只说结论。' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'bots.save' }));
    await advance(1600);
    const saved = mocks.updateBotProfile.mock.calls[0]?.[1] as { identitySource: string };
    expect(saved.identitySource).toContain('你是本本，只说结论。');
    expect(saved.identitySource).not.toContain('项目管家');
    expect(saved.identitySource).toContain('"style":"steady"');
    expect(saved.identitySource).toContain('"call":"boss"');
  });

  it('takes the user back to the conversation after saving a persona', async () => {
    const { onBack } = renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'bots.persona.adjustButton' }));
    fireEvent.click(screen.getByRole('button', { name: 'persona-wizard-save' }));
    await advance(0);
    expect(onBack).toHaveBeenCalledTimes(1);
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
    renderSettings({
      identitySource:
        '<!--persona:v1:{"style":"lively","proactivity":"proactive","call":"boss"}-->\nzh\nen',
    });
    fireEvent.click(screen.getByRole('button', { name: 'bots.persona.adjustButton' }));
    fireEvent.click(screen.getByRole('button', { name: 'persona-wizard-save' }));
    await advance(0);
    expect(peekPendingBotPersonaAck('bot-1')).toBeNull();
  });

  it('sends nothing when the page is only opened or profile edits are cancelled', async () => {
    renderSettings();
    await advance(3000);
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
    openProfileEditor();
    fireEvent.change(screen.getByDisplayValue('PR steward'), { target: { value: 'PR crew' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.cancel' }));
    await advance(3000);
    expect(mocks.updateBotProfile).not.toHaveBeenCalled();
  });

  it('flushes a still-pending edit when the settings view unmounts', () => {
    const view = renderSettings({}, 'settings=1&tab=growth');
    fireEvent.change(screen.getByPlaceholderText('bots.userContextSourcePlaceholder'), {
      target: { value: 'Call me Chris.' },
    });
    view.unmount();
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(mocks.updateBotProfile.mock.calls[0]?.[1]).toMatchObject({
      userContextSource: 'Call me Chris.',
    });
  });

  it('flushes on blur so long user-profile prompts do not wait for debounce', async () => {
    renderSettings({}, 'settings=1&tab=growth');
    const textarea = screen.getByPlaceholderText('bots.userContextSourcePlaceholder');
    fireEvent.change(textarea, { target: { value: 'Call me Chris, keep replies short.' } });
    fireEvent.blur(textarea);
    await advance(0);
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
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
    const input = advancedProfileInput();
    fireEvent.change(input, { target: { value: 'Call me Chris.' } });
    await advance(1300);
    expect(screen.getByText('bots.autosave.saving')).toBeTruthy();
    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('bots.autosave.saved')).toBeTruthy();
    await advance(2500);
    expect(screen.queryByText('bots.autosave.saved')).toBeNull();
  });

  it('surfaces a failure with a retry that re-sends the same change', async () => {
    mocks.updateBotProfile.mockRejectedValueOnce(new Error('ipc down'));
    renderSettings();
    const input = advancedProfileInput();
    fireEvent.change(input, { target: { value: 'Call me Chris.' } });
    await advance(1300);
    expect(screen.getByRole('alert').textContent).toContain('bots.profileApply.saveFailed');
    fireEvent.click(screen.getByRole('button', { name: 'bots.autosave.retry' }));
    await advance(0);
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(2);
    expect(mocks.updateBotProfile.mock.calls[1]?.[1]).toMatchObject({
      userContextSource: 'Call me Chris.',
    });
  });

  it('flushes before leaving and stays put when that save fails', async () => {
    mocks.updateBotProfile.mockRejectedValueOnce(new Error('ipc down'));
    const view = renderSettings();
    const input = advancedProfileInput();
    fireEvent.change(input, { target: { value: 'Call me Chris.' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.backToChat' }));
    await advance(0);
    expect(view.onBack).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'bots.backToChat' }));
    await advance(0);
    expect(view.onBack).toHaveBeenCalledTimes(1);
  });

  it('leaves settings directly after saving because capability epochs refresh automatically', async () => {
    mocks.updateBotProfile.mockImplementationOnce(async (_id, patch) => ({
      id: 'bot-1',
      currentVersion: 2,
      ...patch,
    }));
    const view = renderSettings();
    const input = advancedProfileInput();
    fireEvent.change(input, { target: { value: 'Call me Chris.' } });
    await advance(1300);
    expect(mocks.updateBotProfile).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('bots.profileApply.title')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'bots.backToChat' }));
    await advance(0);
    expect(view.onBack).toHaveBeenCalledTimes(1);
  });
});
