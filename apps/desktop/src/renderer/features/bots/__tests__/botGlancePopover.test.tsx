// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：伙伴聊天头部的近况按钮（BotGlanceButton）。主人看到的电脑行、点待办后输入框收到的
 *   引用、右键删除与撤销、输出内容的打开，以及到期红点何时亮、何时灭。
 * - Bug／规则依据：docs/product-rules/cindy-bots-runtime.md「伙伴近况」；近况取代右侧栏工作台后，待办不再有
 *   行内按钮（点一条只交给对话），切电脑并进这里。
 * - 现有覆盖缺口：这是新入口；头部测试只验证按钮存在，不覆盖浮层内的行为。
 * - 「帮我查查」与「每天帮我查一次」：空待办收起；有待办时紧凑检查动作走普通发送，关闭每天检查经原宿主入口停用。
 * - 最小失败输入：一条今天到期的待办 + 一份带成品文件的委派 + Cindy 在另一台在线、一台离线的电脑上。
 * - tier：unit（jsdom 渲染真实组件，宿主 API 用内存 fake）。
 * - 实测耗时：见 PR（pnpm --dir apps/desktop exec vitest run 本文件）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTodoReferenceHref } from '@cindy/maker-shared/agent-input-projection';
import { todoLocalDate, type TeammateTodo } from '@cindy/maker-shared/teammate-todo';

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  insert: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
  local: [] as Array<Record<string, unknown>>,
  remote: [] as Array<Record<string, unknown>>,
  delegations: [] as Array<Record<string, unknown>>,
  send: vi.fn(async () => true),
  sessions: [] as Array<Record<string, unknown>>,
  remoteSessions: [] as Array<Record<string, unknown>>,
  refs: [] as Array<Record<string, unknown>>,
  statuses: new Map(),
  attention: new Map(),
  scopes: [] as Array<Record<string, unknown>>,
  pin: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'count' in options ? `${key}:${String(options.count)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate }));
vi.mock('@/lib/composerActionsBus', () => ({ insertTodoReferenceIntoComposer: h.insert }));
vi.mock('@/lib/toast', () => ({ toast: { info: h.toastInfo, error: h.toastError } }));
vi.mock('@/lib/orcaSessionIdentity', () => ({ resolveSessionRoute: async (id: string) => `/cc-agent/${id}` }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { sendMessage: h.send } }));
vi.mock('@/lib/sessionService', () => ({
  get: async (id: string) => ({ id, model: 'm', effort: 'high', permissionMode: 'auto', workingDir: '/w' }),
}));
vi.mock('../BotAvatar', () => ({ BotAvatar: () => <span data-testid="bot-avatar" /> }));
vi.mock('../botStore', () => ({ useBotProfiles: () => h.local, useBotUnreadCounts: () => ({}) }));
vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => h.remote, useRemoteCindyIds: () => new Set<string>() }));
vi.mock('@/features/device-link/refreshRemoteSessions', () => ({ refreshRemoteDeviceSessions: async () => 'done' }));
vi.mock('@/hooks/useCCSessions', () => ({ useCCSessions: () => ({ sessions: h.sessions }) }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  useRemoteProjectSessions: () => h.remoteSessions,
  remoteProjectsStore: { getSessionDeviceId: (id: string) => h.remoteSessions.find(task => task.id === id)?.deviceLinkDeviceId,
    getDeviceSessions: () => h.remoteSessions, pinSessionOrigin: h.pin },
}));
vi.mock('../botFollowScopes', async importOriginal => {
  const actual = await importOriginal<typeof import('../botFollowScopes')>();
  return { ...actual, useTaskCreatorIndex: () => new Map(h.scopes.map(scope =>
    [JSON.stringify([scope.deviceId ?? null, scope.sessionId]), new Set([JSON.stringify([null, 'bot-1'])])])) };
});
vi.mock('@/lib/sessionAttentionStore', () => ({ useSessionAttentionKind: (id: string) => h.attention.get(id) }));
vi.mock('@/contexts/PrRefsContext', () => ({
  usePrActions: () => ({ registerPrConsumer: () => () => undefined }),
  usePrRefsForSessions: (ids: string[]) => h.refs.filter(ref => ids.includes(ref.sessionId as string)),
  usePrStatuses: () => ({ statuses: h.statuses, successfulStatuses: new Map() }),
}));
vi.mock('../botDelegationLive', () => ({ useBotDelegations: () => h.delegations }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => [{ deviceId: 'self', name: 'Mac-Studio', isSelf: true }],
}));

const { BotGlanceButton } = await import('../BotGlancePopover');

function todo(id: string, patch: Partial<TeammateTodo> = {}): TeammateTodo {
  return {
    id,
    revision: 3,
    key: `k:${id}`,
    origin: 'discovered',
    title: `Todo ${id}`,
    progress: '',
    outcome: '',
    value: '',
    next: null,
    sources: [{ kind: 'mail', id: `m:${id}`, label: 'MagicLizi' }],
    associations: [],
    status: 'open',
    createdAt: '2026-10-20T01:00:00Z',
    updatedAt: '2026-10-20T01:00:00Z',
    sourceDeadline: { kind: 'date', date: todoLocalDate(new Date(), 'UTC'), timeZone: 'UTC' },
    deadlineCandidate: null,
    suggestedDate: null,
    decision: null,
    history: [],
    action: null,
    ...patch,
  };
}

const today = todoLocalDate(new Date(), 'UTC');
let items: TeammateTodo[] = [];
const list = vi.fn(async () => ({ items, version: 1 as const }));
const update = vi.fn(async (_botId: string, patch: { id: string }) => ({ ...todo(patch.id), revision: 4 }));
const openPath = vi.fn(async () => ({ ok: true }));
let dailyOn = false;
let routinesChanged: (() => void) | null = null;
const dailyCheck = vi.fn(async (_botId: string, enabled?: boolean) => (dailyOn = enabled ?? dailyOn));

beforeEach(() => {
  items = [];
  h.sessions = []; h.remoteSessions = []; h.refs = []; h.scopes = []; h.statuses.clear(); h.attention.clear();
  dailyOn = false;
  dailyCheck.mockImplementation(async (_botId: string, enabled?: boolean) => (dailyOn = enabled ?? dailyOn));
  h.local = [];
  h.remote = [];
  h.delegations = [];
  window.localStorage.clear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    localDb: { bots: { todos: { list, update, dailyCheck }, workbench: { followScopes: async () => h.scopes } } },
    maker: { onBotWorkbenchChanged: () => () => undefined },
    routines: { onChanged: (listener: () => void) => { routinesChanged = listener; return () => { routinesChanged = null; }; } },
    deviceLink: { invoke: vi.fn(), onRemotePush: () => () => undefined },
    openPath,
    openExternal: h.openExternal,
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const bot = { id: 'bot-1', name: '葫芦', sessionId: 's1' };

async function openGlance(target = bot) {
  render(<BotGlanceButton bot={target} cloudHome={false} />);
  await waitFor(() => expect(list).toHaveBeenCalled());
  fireEvent.click(screen.getByTestId('bot-glance-button'));
  return screen.findByTestId('bot-glance-popover');
}

describe('BotGlanceButton', () => {
  it('quotes a todo into the composer instead of acting on it, and offers only an undoable delete', async () => {
    items = [todo('t1')];
    await openGlance();
    fireEvent.click(await screen.findByText('Todo t1'));
    await waitFor(() =>
      expect(h.insert).toHaveBeenCalledWith({
        targetSessionId: 's1',
        href: buildTodoReferenceHref('bot-1', 't1'),
        title: 'Todo t1',
      }),
    );
    expect(update).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('bot-glance-button'));
    fireEvent.contextMenu(await screen.findByText('Todo t1'));
    fireEvent.click(await screen.findByText('bots.glance.delete'));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('bot-1', { id: 't1', expectedRevision: 3, operation: 'delete' }),
    );
    const undo = h.toastInfo.mock.calls[0]?.[1]?.action as { onClick: () => void };
    await act(async () => undo.onClick());
    expect(update).toHaveBeenLastCalledWith('bot-1', { id: 't1', expectedRevision: 4, operation: 'restore' });
  });

  it('hides an empty todo section without stopping an enabled daily routine', async () => {
    dailyOn = true;
    await openGlance();
    expect(screen.queryByText('bots.glance.todos')).toBeNull();
    expect(dailyCheck.mock.calls.every(call => call[1] === undefined)).toBe(true);
  });

  it('checks from the compact action and stops the daily routine persistently with its close button', async () => {
    items = [todo('t1')]; dailyOn = true;
    await openGlance();
    fireEvent.click(await screen.findByTestId('bot-glance-check'));
    await waitFor(() => expect(h.send).toHaveBeenCalledWith('s1', 'bots.glance.checkPrompt', 'm', 'high', 'auto', '/w'));
    fireEvent.click(screen.getByTestId('bot-glance-button'));
    fireEvent.click(await screen.findByRole('button', { name: 'bots.glance.stopDailyCheck' }));
    await waitFor(() => expect(screen.queryByTestId('bot-glance-daily-check')).toBeNull());
    expect(dailyCheck).toHaveBeenLastCalledWith('bot-1', false);
    await act(async () => routinesChanged?.());
    expect(screen.queryByTestId('bot-glance-daily-check')).toBeNull();
  });

  it('keeps the daily row and reports failure when stopping is refused', async () => {
    items = [todo('t1')];
    dailyCheck.mockImplementation(async (_botId: string, enabled?: boolean) => {
      if (enabled !== undefined) throw new Error('The teammate is paused');
      return true;
    });
    await openGlance();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.glance.stopDailyCheck' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('bots.glance.dailyCheckFailed'));
    expect(screen.getByTestId('bot-glance-daily-check')).toBeTruthy();
  });

  // cindy-bots-runtime.md §6「伙伴技能分层」: with the Todos system Skill off, its background check is refused by the host;
  // 近况 still lists the Todos but no longer offers "check for me" or the daily check.
  it('keeps todos but hides both check controls when the Todos system Skill is off', async () => {
    items = [todo('t1')]; dailyOn = true;
    h.local = [{ id: 'bot-1', name: '葫芦', capabilities: { systemSkillsOff: ['todo'] } }];
    await openGlance();
    expect(await screen.findByText('Todo t1')).toBeTruthy();
    expect(screen.queryByTestId('bot-glance-check')).toBeNull();
    expect(screen.queryByTestId('bot-glance-daily-check')).toBeNull();
  });

  // User-approved #7546 projection: two devices, existing unread, real PR title, one output per PR.
  it('opens the correct task host, reads existing attention and deduplicates true PR outputs', async () => {
    const a = { id: 'task-a', title: 'Session title A', status: 'active', updatedAt: '2026-10-28T10:00:00Z' };
    const b = { id: 'task-b', title: 'Session title B', status: 'active', updatedAt: '2026-10-28T09:00:00Z', deviceLinkDeviceId: 'mini', deviceLinkDeviceName: 'Mac mini' };
    h.sessions = [a, { ...a, id: 'unrelated', title: 'Unrelated' }]; h.remoteSessions = [b];
    h.scopes = [{ sessionId: a.id }, { sessionId: b.id, deviceId: 'mini' }];
    h.attention.set(a.id, 'done'); h.attention.set(b.id, 'error');
    h.refs = [a,b].map((task, i) => ({ id: String(i), sessionId: task.id, owner: 'makecindy', repo: 'cindy', prNumber: 123, lastSeenAt: 2-i }));
    h.statuses.set('makecindy/cindy#123', { ok: true, status: 'merged', title: 'Actual PR title' });
    await openGlance();
    expect(screen.getAllByTestId('bot-glance-task')).toHaveLength(2);
    expect(screen.queryByText('Unrelated')).toBeNull();
    expect(screen.getAllByLabelText('bots.glance.unread')).toHaveLength(1);
    expect(screen.getAllByTestId('bot-glance-pr')).toHaveLength(1);
    expect(screen.getByText('Actual PR title')).toBeTruthy();
    fireEvent.click(screen.getByTestId('bot-glance-pr'));
    expect(h.openExternal).toHaveBeenCalledWith('https://github.com/makecindy/cindy/pull/123');
    fireEvent.click(screen.getByText('Session title B'));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/cc-agent/task-b'));
    expect(h.pin).toHaveBeenCalledWith('mini', 'task-b');
  });

  it('lights the entry dot for a due todo until 近况 is opened, and marks the row itself', async () => {
    items = [todo('due', { sourceDeadline: { kind: 'date', date: today, timeZone: 'UTC' } }),
      todo('later', { sourceDeadline: { kind: 'date', date: todoLocalDate(new Date(Date.now() + 3 * 86_400_000), 'UTC'), timeZone: 'UTC' } })];
    render(<BotGlanceButton bot={bot} cloudHome={false} />);
    const button = screen.getByTestId('bot-glance-button');
    await waitFor(() => expect(button.getAttribute('aria-label')).toContain('bots.glance.dueUnseen'));
    fireEvent.click(button);
    await screen.findByTestId('bot-glance-popover');
    expect(button.getAttribute('aria-label')).not.toContain('bots.glance.dueUnseen');
    const rows = screen.getAllByTestId('bot-glance-todo');
    expect(rows[0].textContent).toContain('Todo due');
    expect(rows[0].querySelector('.bg-\\[var\\(--error-fg\\)\\]')).not.toBeNull();
    expect(rows[1].querySelector('.bg-\\[var\\(--error-fg\\)\\]')).toBeNull();

    cleanup();
    render(<BotGlanceButton bot={bot} cloudHome={false} />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(screen.getByTestId('bot-glance-button').getAttribute('aria-label')).not.toContain('bots.glance.dueUnseen');
  });

  it('reaches due todos past the first host page and hides the section when only old ideas or completed items remain', async () => {
    items = Array.from({ length: 30 }, (_, i) => todo(`o${String(i).padStart(2, '0')}`));
    await openGlance();
    fireEvent.click(screen.getByText('bots.glance.showMore'));
    expect(screen.getAllByTestId('bot-glance-todo')).toHaveLength(30);

    cleanup();
    items = [todo('finished', { status: 'done' }),
      ...Array.from({ length: 51 }, (_, i) => todo(`old-${i}`, { sourceDeadline: null }))];
    await openGlance();
    expect(screen.queryByText('bots.glance.todos')).toBeNull();
    expect(screen.queryByTestId('bot-glance-check')).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('lists Cindy on each computer: this one first, online ones selectable, offline ones folded', async () => {
    const cindy = { id: 'cindy-default', name: 'Cindy', templateId: 'cindy', status: 'active', sessionId: 's1' };
    h.local = [cindy];
    h.remote = [
      { id: 'cindy-default', name: 'Cindy', deviceId: 'mini', deviceName: 'Mac-mini', online: true, sessionId: 'r1' },
      { id: 'cindy-default', name: 'Cindy', deviceId: 'mbp', deviceName: 'Chris-MBP', online: false, sessionId: 'r2' },
    ];
    await openGlance(cindy);
    const names = () => screen.getAllByTestId('bot-glance-computer').map((row) => row.textContent);
    expect(names()[0]).toContain('bots.glance.runningHere');
    expect(names().some((text) => text?.includes('Chris-MBP'))).toBe(false);
    fireEvent.click(screen.getByText('bots.glance.offlineCount:1'));
    expect(names().some((text) => text?.includes('Chris-MBP'))).toBe(true);
    fireEvent.click(screen.getByText('Mac-mini'));
    expect(h.navigate).toHaveBeenCalledWith(expect.stringContaining('mini'));
  });

  it("shows only this teammate's finished deliverables and opens them", async () => {
    h.delegations = [
      {
        id: 'd1', requestingBotId: 'bot-1', status: 'completed', title: 'Weekly report', childSessionId: 'c1',
        completedAt: Date.now(), updatedAt: Date.now(),
        artifacts: [
          { path: 'out/report.docx', absolutePath: '/w/out/report.docx', status: 'added' },
          { path: 'src/app.ts', absolutePath: '/w/src/app.ts', status: 'modified' },
          { path: 'old.pdf', absolutePath: '/w/old.pdf', status: 'deleted' },
        ],
      },
      { id: 'd2', requestingBotId: 'bot-1', status: 'failed', title: 'x', childSessionId: 'c2', completedAt: 1, updatedAt: 1,
        artifacts: [{ path: 'fail.pdf', absolutePath: '/w/fail.pdf', status: 'added' }] },
      { id: 'd3', requestingBotId: 'other', status: 'completed', title: 'y', childSessionId: 'c3', completedAt: 1, updatedAt: 1,
        artifacts: [{ path: 'theirs.pdf', absolutePath: '/w/theirs.pdf', status: 'added' }] },
    ];
    await openGlance();
    const outputs = screen.getAllByTestId('bot-glance-output');
    expect(outputs.map((row) => row.textContent)).toEqual([expect.stringContaining('report.docx')]);
    fireEvent.click(outputs[0]);
    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/w/out/report.docx'));
  });

  // PR + file entries share one chronology and one fold; separate lists hid newer files below older PRs.
  it('mixes PRs and files by time with one shared show-more control', async () => {
    h.sessions = [{ id: 'task', title: 'Task', status: 'active' }];
    h.scopes = [{ sessionId: 'task' }];
    h.refs = [4, 2].map(at => ({ sessionId: 'task', owner: 'example', repo: 'app', prNumber: at, lastSeenAt: at }));
    for (const at of [4, 2]) h.statuses.set(`example/app#${at}`, { ok: true, status: 'merged', title: `PR title ${at}` });
    h.delegations = [3, 1].map(at => ({ id: `d${at}`, requestingBotId: 'bot-1', status: 'completed',
      title: 'Task', childSessionId: 'task', completedAt: at, updatedAt: at,
      artifacts: [{ path: `file-${at}.pdf`, absolutePath: `/w/file-${at}.pdf`, status: 'added' }] }));
    const popover = await openGlance();
    const rows = () => [...popover.querySelectorAll('[data-testid="bot-glance-pr"], [data-testid="bot-glance-output"]')]
      .map(row => row.querySelector('[title]')?.getAttribute('title'));
    expect(rows()).toEqual(['PR title 4', 'file-3.pdf', 'PR title 2']);
    expect(screen.getAllByText('bots.glance.showMore')).toHaveLength(1);
    fireEvent.click(screen.getByText('bots.glance.showMore'));
    expect(rows()).toEqual(['PR title 4', 'file-3.pdf', 'PR title 2', 'file-1.pdf']);
    fireEvent.click(screen.getByText('bots.glance.showLess'));
    expect(rows()).toHaveLength(3);
  });
});
