// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：伙伴聊天头部的近况按钮（BotGlanceButton）。主人看到的电脑行、点待办后输入框收到的
 *   引用、右键删除与撤销、输出内容的打开，以及到期红点何时亮、何时灭。
 * - Bug／规则依据：docs/product-rules/cindy-bots-runtime.md「伙伴近况」；近况取代右侧栏工作台后，待办不再有
 *   行内按钮（点一条只交给对话），切电脑并进这里。
 * - 现有覆盖缺口：这是新入口；头部测试只验证按钮存在，不覆盖浮层内的行为。
 * - 「帮我查查」与「每天帮我查一次」：没有待办时也在；前者以主人的一句话走普通发送，后者经宿主开关内置例行任务。
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
vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => h.remote }));
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
    sourceDeadline: null,
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
  dailyOn = false;
  dailyCheck.mockImplementation(async (_botId: string, enabled?: boolean) => (dailyOn = enabled ?? dailyOn));
  h.local = [];
  h.remote = [];
  h.delegations = [];
  window.localStorage.clear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    localDb: { bots: { todos: { list, update, dailyCheck } } },
    maker: { onBotWorkbenchChanged: () => () => undefined },
    routines: { onChanged: (listener: () => void) => { routinesChanged = listener; return () => { routinesChanged = null; }; } },
    deviceLink: { invoke: vi.fn(), onRemotePush: () => () => undefined },
    openPath,
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

  it('asks the teammate to check for todos as the owner, and switches the weekday check on', async () => {
    await openGlance();
    // No todos yet: the section still offers 「帮我查查」 and the daily switch.
    fireEvent.click(await screen.findByTestId('bot-glance-check'));
    await waitFor(() => expect(h.send).toHaveBeenCalledWith('s1', 'bots.glance.checkPrompt', 'm', 'high', 'auto', '/w'));

    fireEvent.click(screen.getByTestId('bot-glance-button'));
    const toggle = (await screen.findByTestId('bot-glance-daily-check')).querySelector('[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(dailyCheck).toHaveBeenLastCalledWith('bot-1', true);

    // Paused from the routines list while 近况 is open: the switch follows.
    dailyOn = false;
    await act(async () => routinesChanged?.());
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  });

  it('keeps the switch when the host refuses it, and hides it for a teammate on an older desktop', async () => {
    dailyCheck.mockImplementation(async (_botId: string, enabled?: boolean) => {
      if (enabled !== undefined) throw new Error('The teammate is paused');
      return false;
    });
    await openGlance();
    const toggle = (await screen.findByTestId('bot-glance-daily-check')).querySelector('[role="switch"]')!;
    fireEvent.click(toggle);
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('bots.glance.dailyCheckFailed'));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    cleanup();

    // Another computer whose host predates the switch: its todo page has no dailyCheck field.
    const invoke = window.electronAPI.deviceLink.invoke as ReturnType<typeof vi.fn>;
    invoke.mockResolvedValue({ blocks: [{ primitive: 'teammate-todos', data: { items: [], total: 0 } }] });
    render(<BotGlanceButton bot={{ ...bot, deviceId: 'mini', deviceName: 'Mac-mini' }} cloudHome={false} />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('bot-glance-button'));
    expect(await screen.findByTestId('bot-glance-check')).toBeTruthy();
    expect(screen.queryByTestId('bot-glance-daily-check')).toBeNull();
  });

  it('lights the entry dot for a due todo until 近况 is opened, and marks the row itself', async () => {
    items = [todo('due', { sourceDeadline: { kind: 'date', date: today, timeZone: 'UTC' } }), todo('later')];
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

  it('reaches todos past the first host page, and keeps finished ones after the last open todo is done', async () => {
    items = Array.from({ length: 30 }, (_, i) => todo(`o${String(i).padStart(2, '0')}`));
    await openGlance();
    fireEvent.click(screen.getByText('bots.glance.showMore'));
    expect(screen.getAllByTestId('bot-glance-todo')).toHaveLength(30);

    cleanup();
    items = [todo('finished', { status: 'done' })];
    await openGlance();
    fireEvent.click(await screen.findByText('bots.glance.doneCount:1'));
    expect(screen.getByText('Todo finished')).toBeTruthy();
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
});
