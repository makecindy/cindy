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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotChatIdentity } from '../BotSessionContentHeader';

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
vi.mock('@/lib/toast', () => ({ toast: { info: h.toastInfo, error: h.toastError } }));
vi.mock('@/lib/orcaSessionIdentity', () => ({ resolveSessionRoute: async (id: string) => `/cc-agent/${id}` }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { sendMessage: h.send } }));
vi.mock('@/lib/sessionService', () => ({
  get: async (id: string) => ({ id, model: 'm', effort: 'high', permissionMode: 'auto', workingDir: '/w' }),
}));
vi.mock('../BotAvatar', () => ({ BotAvatar: () => <span data-testid="bot-avatar" /> }));
vi.mock('../botStore', () => ({ useBotProfiles: () => h.local, useBotUnreadCounts: () => ({}), ensureBotProfilesLoaded: async () => h.local }));
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
vi.mock('../botDelegationHistory', () => ({ useBotDelegationRecords: () => h.delegations }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => [{ deviceId: 'self', name: 'Mac-Studio', isSelf: true }],
}));

const { BotGlanceButton } = await import('../BotGlancePopover');
const { resetCompanionCloudStoreForTests } = await import('../companionCloudStore');
const { MENU_DANGER_TEXT } = await import('@/components/ui/menu-row');

const openPath = vi.fn(async () => ({ ok: true }));

beforeEach(() => {
  h.sessions = []; h.remoteSessions = []; h.refs = []; h.scopes = []; h.statuses.clear(); h.attention.clear();
  h.local = [];
  h.remote = [];
  h.delegations = [];
  window.localStorage.clear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    localDb: { bots: { workbench: { followScopes: async () => h.scopes } } },
    maker: { onBotWorkbenchChanged: () => () => undefined },
    deviceLink: { invoke: vi.fn(), onRemotePush: () => () => undefined },
    openPath,
    openExternal: h.openExternal,
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetCompanionCloudStoreForTests();
});

const bot = { id: 'bot-1', name: '葫芦', sessionId: 's1' };

async function openGlance(target: BotChatIdentity = bot) {
  render(<BotGlanceButton bot={target} cloudHome={false} />);
  fireEvent.click(screen.getByTestId('bot-glance-button'));
  return screen.findByTestId('bot-glance-popover');
}

describe('BotGlanceButton', () => {
  it('opens the correct task host, reads existing attention and deduplicates true PR outputs', async () => {
    const a = { id: 'task-a', title: 'Session title A', status: 'active', updatedAt: '2026-10-28T10:00:00Z' };
    const b = { id: 'task-b', title: 'Session title B', status: 'active', updatedAt: '2026-10-28T09:00:00Z', deviceLinkDeviceId: 'mini', deviceLinkDeviceName: 'Mac mini' };
    h.sessions = [a, { ...a, id: 'unrelated', title: 'Unrelated' }]; h.remoteSessions = [b];
    h.scopes = [{ sessionId: a.id }, { sessionId: b.id, deviceId: 'mini' }];
    h.attention.set(a.id, 'done'); h.attention.set(b.id, 'error');
    h.refs = [a,b].map((task, i) => ({ id: String(i), sessionId: task.id, owner: 'makecindy', repo: 'cindy', prNumber: 123, lastSeenAt: 2-i }));
    h.statuses.set('github:github.com/makecindy/cindy#123', { ok: true, status: 'merged', title: 'Actual PR title' });
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

  // cloud-companions.md §3.1 (2026-11-21, issue #12016): the 近况 popover, like the settings menu, names the
  // forced take-over of a main computer that is listed online but does not answer, in the destructive
  // style. Before, the clickable row read like an ordinary choice («this computer · online»).
  // The force is submitted for the home the popover's choices decided on (C), even while the rendered
  // snapshot still shows A (#11999 review, zqchris 11-25); the dialog names it from the same decision.
  it.each([['laptop', 'Laptop'], ['carbon', 'Carbon']] as const)('names the forced take-over here when the main computer is listed online but does not answer (decided home %s)', async (decided, decidedName) => {
    const cloud = (home: string) => ({ enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [],
      actors: [{ id: 'a-1', externalId: 'bot-1', name: '葫芦', avatar: null, homeDeviceId: home,
        homeDevice: { deviceId: home, name: home === 'desk' ? 'Desk' : 'Laptop', online: true, isSelf: home === 'desk' } }] });
    resetCompanionCloudStoreForTests(cloud('laptop'));
    h.local = [{ id: 'bot-1', name: '葫芦', status: 'active', sessionId: 's1' }];
    const switchCompanionHome = vi.fn(async () => { resetCompanionCloudStoreForTests(cloud('desk')); return { ok: true }; });
    Object.assign((window as unknown as { electronAPI: { maker: Record<string, unknown> } }).electronAPI.maker, {
      getCompanionCloudState: async () => cloud('laptop'),
      onCompanionCloudChanged: () => () => undefined,
      getCompanionHomeChoices: async () => ({ homeDeviceId: decided, homeName: decidedName, mode: 'takeOver', reason: 'HOME_UNRESPONSIVE',
        targets: [{ deviceId: 'desk', name: 'Desk', online: true, isSelf: true }] }),
      switchCompanionHome,
    });
    render(<BotGlanceButton bot={bot} cloudHome />);
    fireEvent.click(screen.getByTestId('bot-glance-button'));
    expect(await screen.findByText('bots.cloud.homeUnresponsive')).toBeTruthy();
    const force = screen.getByRole('button', { name: 'bots.cloud.forceHere' });
    expect(screen.getByText('bots.cloud.forceHere').className).toContain(MENU_DANGER_TEXT);
    expect(screen.queryByText('bots.glance.online')).toBeNull();
    fireEvent.click(force);
    expect(await screen.findByText('bots.cloud.forceDescription')).toBeTruthy();
    expect(switchCompanionHome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'bots.cloud.forceAction' }));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/bots/bot-1'));
    expect(switchCompanionHome).toHaveBeenCalledWith('bot-1', 'desk', { force: true, forceHomeDeviceId: decided });
  });

  // cloud-companions.md §3.1 「主力电脑行的显示」 (#11999 review, zqchris 11-25 20:44Z and 21:31Z): the home row
  // says «running there» only from a confirmed fact — a local companion that is active. Another computer's
  // answer is about that computer's Cindy (version, computers it can hand over to), never about this
  // companion, so a remote home never shows the running label. Before, a failed read, a paused companion and
  // a home that answered while its companion runtime was not ready all said «running there».
  const here = { deviceId: 'desk', name: 'Desk', online: true, isSelf: true };
  const cloudWith = (home: string | null, botId = 'bot-1') => ({ enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [],
    actors: [{ id: `a-${botId}`, externalId: botId, name: '葫芦', avatar: null, homeDeviceId: home,
      homeDevice: home ? { deviceId: home, name: home === 'desk' ? 'Desk' : 'Laptop', online: true, isSelf: home === 'desk' } : null }] });
  type Read = 'pending' | 'reject' | Record<string, unknown>;
  const showCloud = (home: string | null, read: Read, localStatus?: string) => {
    resetCompanionCloudStoreForTests(cloudWith(home));
    h.local = localStatus ? [{ id: 'bot-1', name: '葫芦', status: localStatus, sessionId: 's1' }] : [];
    const getCompanionHomeChoices = vi.fn(() => read === 'pending' ? new Promise(() => {})
      : read === 'reject' ? Promise.reject(new Error('directory read failed')) : Promise.resolve(read));
    Object.assign((window as unknown as { electronAPI: { maker: Record<string, unknown> } }).electronAPI.maker, {
      getCompanionCloudState: async () => cloudWith(home), onCompanionCloudChanged: () => () => undefined, getCompanionHomeChoices,
    });
    render(<BotGlanceButton bot={bot} cloudHome />);
    fireEvent.click(screen.getByTestId('bot-glance-button'));
    return getCompanionHomeChoices;
  };
  const homeRow = () => screen.getAllByTestId('bot-glance-computer')[0]!.textContent ?? '';
  it.each([
    ['a local companion that is active', 'desk', { homeDeviceId: 'desk', mode: 'local', targets: [{ deviceId: 'laptop', name: 'Laptop', online: true }] }, 'active', true, null, 'Laptop'],
    ['a local companion that is paused (not asked)', 'desk', 'pending', 'paused', false, 'bots.cloud.resumeToMove', null],
    ['a remote home still being checked', 'laptop', 'pending', undefined, false, 'bots.cloud.checkingHome', null],
    ['a remote home that answered, the same computer as the row', 'laptop', { homeDeviceId: 'laptop', homeName: 'Laptop', mode: 'remote', targets: [here] }, undefined, false, null, 'bots.cloud.thisComputer'],
    // zqchris 21:31Z: the home's Cindy answers (version and an empty target list) while its companion runtime
    // is not ready; nothing says this companion runs there.
    ['a remote home whose Cindy answers while the companion state is unknown', 'laptop', { homeDeviceId: 'laptop', homeName: 'Laptop', mode: 'remote', targets: [] }, undefined, false, null, null],
    ['a remote answer about another home than the row', 'laptop', { homeDeviceId: 'carbon', homeName: 'Carbon', mode: 'remote', targets: [here] }, undefined, false, null, 'bots.cloud.thisComputer'],
    ['a remote home that cannot be confirmed', 'laptop', { homeDeviceId: 'laptop', homeName: 'Laptop', mode: 'takeOver', reason: 'HOME_UNRESPONSIVE', targets: [here] }, undefined, false, 'bots.cloud.homeUnresponsive', 'bots.cloud.forceHere'],
    ['a remote home explicitly offline or refusing', 'laptop', { homeDeviceId: 'laptop', homeName: 'Laptop', mode: 'takeOver', targets: [here] }, undefined, false, null, 'bots.cloud.thisComputer'],
    ['a remote home running an older Cindy', 'laptop', { homeDeviceId: 'laptop', homeName: 'Laptop', mode: 'unavailable', reason: 'HOME_OUTDATED', targets: [] }, undefined, false, null, null],
    ['a read that failed', 'laptop', 'reject', undefined, false, 'bots.cloud.devicesFailed', null],
    ['a companion without a home', null, { homeDeviceId: null, mode: 'takeOver', targets: [here] }, undefined, false, null, 'bots.cloud.thisComputer'],
  ] as const)('shows the home row for %s', async (_, home, read, localStatus, running, line, action) => {
    const asked = showCloud(home, read as Read, localStatus);
    await screen.findByTestId('bot-glance-popover');
    if (line) expect(await screen.findByText(line)).toBeTruthy();
    else await waitFor(() => expect(asked).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByTestId('bot-glance-computer').length).toBe(action ? 2 : 1));
    expect(homeRow().includes('bots.glance.runningHere')).toBe(running);
    if (action) expect(screen.getByRole('button', { name: new RegExp(action) })).toBeTruthy();
    if (localStatus === 'paused') expect(asked).not.toHaveBeenCalled();
    // Settled states keep their own line: no checking line left behind, no running label coming back.
    if (line !== 'bots.cloud.checkingHome') expect(screen.queryByText('bots.cloud.checkingHome')).toBeNull();
  });

  // Late results: switching companions while the popover is open asks again for the new one; the previous
  // companion's answer arriving afterwards never shows (neither its running label nor its choices).
  it("never shows the previous companion's late answer after switching companions", async () => {
    const both = { ...cloudWith('laptop'), actors: [...cloudWith('laptop').actors, ...cloudWith('laptop', 'bot-2').actors] };
    resetCompanionCloudStoreForTests(both);
    const answers = new Map<string, (value: unknown) => void>();
    Object.assign((window as unknown as { electronAPI: { maker: Record<string, unknown> } }).electronAPI.maker, {
      getCompanionCloudState: async () => both, onCompanionCloudChanged: () => () => undefined,
      getCompanionHomeChoices: vi.fn((botId: string) => new Promise((resolve) => { answers.set(botId, resolve); })),
    });
    const view = render(<BotGlanceButton bot={bot} cloudHome />);
    fireEvent.click(screen.getByTestId('bot-glance-button'));
    await waitFor(() => expect(answers.has('bot-1')).toBe(true));
    view.rerender(<BotGlanceButton bot={{ ...bot, id: 'bot-2' }} cloudHome />);
    await waitFor(() => expect(answers.has('bot-2')).toBe(true));
    answers.get('bot-1')!({ homeDeviceId: 'laptop', homeName: 'Laptop', mode: 'remote', targets: [here] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(homeRow()).not.toContain('bots.glance.runningHere');
    expect(screen.getByText('bots.cloud.checkingHome')).toBeTruthy();
    answers.get('bot-2')!({ homeDeviceId: 'laptop', homeName: 'Laptop', mode: 'remote', targets: [here] });
    await waitFor(() => expect(screen.queryByText('bots.cloud.checkingHome')).toBeNull());
    expect(screen.getByRole('button', { name: /bots\.cloud\.thisComputer/ })).toBeTruthy();
    expect(homeRow()).not.toContain('bots.glance.runningHere');
  });

  it('never shows an earlier answer for the same companion once the popover asked again', async () => {
    const answers: Array<(value: unknown) => void> = [];
    resetCompanionCloudStoreForTests(cloudWith('laptop'));
    Object.assign((window as unknown as { electronAPI: { maker: Record<string, unknown> } }).electronAPI.maker, {
      getCompanionCloudState: async () => cloudWith('laptop'), onCompanionCloudChanged: () => () => undefined,
      getCompanionHomeChoices: () => new Promise((resolve) => { answers.push(resolve); }),
    });
    render(<BotGlanceButton bot={bot} cloudHome />);
    const toggle = () => fireEvent.click(screen.getByTestId('bot-glance-button'));
    toggle();
    await waitFor(() => expect(answers).toHaveLength(1));
    toggle();
    await waitFor(() => expect(screen.queryByTestId('bot-glance-popover')).toBeNull());
    toggle();
    await waitFor(() => expect(answers).toHaveLength(2));
    answers[0]!({ homeDeviceId: 'laptop', homeName: 'Laptop', mode: 'remote', targets: [here] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(homeRow()).not.toContain('bots.glance.runningHere');
    expect(screen.getByText('bots.cloud.checkingHome')).toBeTruthy();
  });

  it('drops an answer that arrives after the popover is gone', async () => {
    let answer!: (value: unknown) => void;
    resetCompanionCloudStoreForTests(cloudWith('laptop'));
    Object.assign((window as unknown as { electronAPI: { maker: Record<string, unknown> } }).electronAPI.maker, {
      getCompanionCloudState: async () => cloudWith('laptop'), onCompanionCloudChanged: () => () => undefined,
      getCompanionHomeChoices: () => new Promise((resolve) => { answer = resolve; }),
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = render(<BotGlanceButton bot={bot} cloudHome />);
    fireEvent.click(screen.getByTestId('bot-glance-button'));
    await screen.findByText('bots.cloud.checkingHome');
    view.unmount();
    answer({ homeDeviceId: 'laptop', homeName: 'Laptop', mode: 'remote', targets: [here] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  // Guard: only the cloud companion's home row changed. An ordinary companion's row still says it runs here.
  it("keeps «running here» on an ordinary companion's row", async () => {
    h.local = [{ id: 'bot-1', name: '葫芦', status: 'active', sessionId: 's1' }];
    await openGlance();
    expect(homeRow()).toContain('bots.glance.runningHere');
  });

  // PR + file entries share one chronology and one fold; separate lists hid newer files below older PRs.
  it('mixes PRs and files by time with one shared show-more control', async () => {
    h.sessions = [{ id: 'task', title: 'Task', status: 'active' }];
    h.scopes = [{ sessionId: 'task' }];
    h.refs = [4, 2].map(at => ({ sessionId: 'task', owner: 'example', repo: 'app', prNumber: at, lastSeenAt: at }));
    for (const at of [4, 2]) h.statuses.set(`github:github.com/example/app#${at}`, { ok: true, status: 'merged', title: `PR title ${at}` });
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
