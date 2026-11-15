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
vi.mock('../botDelegationHistory', () => ({ useBotDelegationRecords: () => h.delegations }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => [{ deviceId: 'self', name: 'Mac-Studio', isSelf: true }],
}));

const { BotGlanceButton } = await import('../BotGlancePopover');

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
