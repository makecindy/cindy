// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';

// 真实的工作台组件、投影与分组;只隔离宿主数据、任务列表读取与浮层。
const m = vi.hoisted(() => ({
  navigate: vi.fn(),
  readTask: vi.fn(),
  sendMessage: vi.fn(async () => true),
  rows: { active: [] as Session[], archived: [] as Session[] },
  pages: {
    active: { loading: false, error: false, hasMore: false },
    archived: { loading: false, error: false, hasMore: false },
  },
  load: { active: vi.fn(), archived: vi.fn() },
  activity: new Map<string, unknown>(),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => m.navigate }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values && 'count' in values ? `${key}:${String(values.count)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('../BotTodoList', () => ({ BotTodoList: () => <section aria-label="todos" /> }));
vi.mock('../useWorkbenchSessionPages', () => ({
  useWorkbenchSessionPages: (_scope: string, status: 'active' | 'archived') => ({
    rows: m.rows[status],
    ...m.pages[status],
    load: m.load[status],
  }),
}));
vi.mock('../useWorkbenchSessionActions', () => ({
  useWorkbenchSessionActions: (rows: Session[]) => ({
    open: vi.fn(),
    action: vi.fn(),
    togglePin: vi.fn(),
    byId: new Map(rows.map((row) => [row.id, row])),
  }),
}));
vi.mock('../botStore', () => ({ useBotProfiles: () => [{ id: 'bot-1', name: 'LiZi', sessions: [] }] }));
vi.mock('../botDelegationLive', () => ({ useBotDelegations: () => [] }));
vi.mock('@/hooks/useCCSessions', () => ({ useCCSessions: () => ({ sessions: [] }) }));
vi.mock('@/state/agentIslandActivity', () => ({ useAgentIslandActivityMap: () => m.activity }));
vi.mock('@/lib/sessionAttentionStore', () => ({ useSessionAttentionKinds: () => new Map() }));
vi.mock('@/features/scheduler/lib/schedulesStore', () => ({
  useSchedulesSnapshot: () => [],
  schedulesStore: { ensure: async () => undefined },
}));
vi.mock('@/contexts/PrRefsContext', () => ({
  usePrActions: () => ({ registerPrConsumer: () => () => undefined }),
  usePrRefsForSession: () => [],
  usePrStatuses: () => ({ statuses: new Map(), successfulStatuses: new Map() }),
}));
vi.mock('@/cindy-brain/ghostUnreadStore', () => ({ useElementVisible: () => ({ ref: () => undefined, visible: false }) }));
vi.mock('@/lib/sessionService', () => ({ get: async () => ({ workingDir: '/p', model: 'm' }) }));
vi.mock('@/lib/sessionsBus', () => ({ emitRefresh: vi.fn() }));
vi.mock('@/lib/sidebarWindow', () => ({ isSidebarWindow: () => false }));
vi.mock('@/lib/orcaSessionIdentity', () => ({ resolveSessionRoute: async (id: string) => '/cc-agent/' + id }));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    subscribe: () => () => undefined,
    getSnapshot: () => null,
    sendMessage: m.sendMessage,
    stopSession: vi.fn(),
  },
}));
vi.mock('@/components/ui/tooltip', () => ({ Tip: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
    DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
      <button type="button" role="menuitem" onClick={onSelect}>
        {children}
      </button>
    ),
  };
});

import { BotWorkbench } from '../BotWorkbench';

function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    workingDir: '/p',
    workspaceKind: 'project',
    status: 'active',
    agentKind: 'cc',
    source: 'desktop',
    userSendAt: '2026-10-01T01:00:00.000Z',
    updatedAt: '2026-10-01T01:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...patch,
  } as Session;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.rows = {
    active: [session('s-wait'), session('s-run'), session('s-todo'), session('s-idle')],
    archived: [session('s-old', { status: 'archived', title: '旧任务' })],
  };
  m.activity = new Map<string, unknown>([
    ['s-wait', { phase: 'needs-interaction', interactionKind: 'permission', currentActionSummary: '删旧迁移' }],
    ['s-run', { phase: 'running', startedAtMs: Date.now() - 5_000, currentActionSummary: 'pnpm test' }],
  ]);
  m.readTask.mockResolvedValue({
    ok: true,
    transcript: { items: [{ role: 'assistant', text: '测试也要覆盖断网重连。', at: Date.now() }], truncated: false },
  });
  window.electronAPI = {
    platform: 'darwin',
    localDb: {
      bots: {
        workbench: {
          get: async () => ({
            directories: [{ path: '/p', name: 'p', exists: true }],
            tasks: {
              's-todo': {
                title: '修复登录超时',
                verdict: 'unfinished',
                next: '刷新重试没有上限,改成 3 次',
                project: '/p',
                updatedAt: '2026-10-01T00:00:00.000Z',
              },
            },
            responsibleSessionIds: ['s-wait', 's-run', 's-todo', 's-idle', 's-old'],
          }),
          candidates: async () => ({ ok: true, candidates: [] }),
          readTask: m.readTask,
        },
      },
    },
    maker: { onBotWorkbenchChanged: () => () => undefined, onBotDelegationChanged: () => () => undefined },
  } as unknown as Window['electronAPI'];
});
afterEach(cleanup);

it('lists Cindy tasks in one column with a summary, groups, 跟进 only where it belongs, and archived at the bottom of done', async () => {
  render(<BotWorkbench botId="bot-1" sessionId="bot-main" />);
  expect(await screen.findByText(
    'bots.workbench.summary.waiting:1 · bots.workbench.summary.running:1 · bots.workbench.summary.todo:1',
  )).toBeTruthy();

  const waiting = screen.getByRole('region', { name: 'bots.workbench.group.waiting' });
  expect(within(waiting).getByText('bots.workbench.line.waitingFor')).toBeTruthy();
  expect(within(waiting).getByRole('button', { name: 'bots.workbench.followUp.aria' })).toBeTruthy();

  const running = screen.getByRole('region', { name: 'bots.workbench.group.running' });
  expect(within(running).getByText('pnpm test')).toBeTruthy();
  expect(within(running).queryByRole('button', { name: 'bots.workbench.followUp.aria' })).toBeNull();

  const todo = screen.getByRole('region', { name: 'bots.workbench.group.todo' });
  expect(within(todo).getByText('修复登录超时')).toBeTruthy();
  expect(within(todo).getByText('刷新重试没有上限,改成 3 次')).toBeTruthy();
  expect(within(todo).getByRole('button', { name: 'bots.workbench.followUp.aria' })).toBeTruthy();

  const done = screen.getByRole('region', { name: 'bots.workbench.group.done' });
  expect(within(done).queryByText('旧任务')).toBeNull();
  fireEvent.click(within(done).getByRole('button', { expanded: false }));
  expect(within(done).getByText('s-idle')).toBeTruthy();
  expect(within(done).getByText('旧任务')).toBeTruthy();
  expect(within(done).getByText('ccAgent.sidebar.filterStatus.archived')).toBeTruthy();
  expect(within(done).queryByRole('button', { name: 'bots.workbench.followUp.aria' })).toBeNull();
  // 每条 Cindy 任务都带任务菜单;归档的给「取消归档」。
  expect(within(done).getAllByRole('menuitem', { name: 'ccAgent.sidebar.sessionMenu.unarchive' })).toHaveLength(1);
});

it('opens a Cindy task inside the panel, reads it, and returns to the list', async () => {
  render(<BotWorkbench botId="bot-1" sessionId="bot-main" />);
  const todo = await screen.findByRole('region', { name: 'bots.workbench.group.todo' });
  fireEvent.click(within(todo).getByRole('button', { name: 'bots.workbench.openTask' }));

  const crumb = await screen.findByRole('navigation', { name: 'bots.workbench.title' });
  expect(within(crumb).getByText('修复登录超时')).toBeTruthy();
  expect(m.navigate).not.toHaveBeenCalled();
  await waitFor(() => expect(m.readTask).toHaveBeenCalledWith('bot-1', 's-todo'));
  expect(await screen.findByText('测试也要覆盖断网重连。')).toBeTruthy();
  expect(screen.getByText('bots.workbench.detail.judgment')).toBeTruthy();
  expect(screen.getByRole('button', { name: /bots.workbench.detail.openInTasks/ })).toBeTruthy();

  fireEvent.click(within(crumb).getByRole('button', { name: 'bots.workbench.title' }));
  expect(await screen.findByRole('region', { name: 'bots.workbench.group.todo' })).toBeTruthy();
});

it('keeps a retry for a failed archived read when nothing is done or archived yet', async () => {
  m.rows = { active: [session('s-run')], archived: [] };
  m.pages.archived = { loading: false, error: true, hasMore: false };
  try {
    render(<BotWorkbench botId="bot-1" sessionId="bot-main" />);
    await screen.findByRole('region', { name: 'bots.workbench.group.running' });
    expect(screen.queryByRole('region', { name: 'bots.workbench.group.done' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'commonUi.retry' }));
    expect(m.load.archived).toHaveBeenCalledTimes(1);
    expect(m.load.active).not.toHaveBeenCalled();
  } finally {
    m.pages.archived = { loading: false, error: false, hasMore: false };
  }
});

it('opens an archived task read-only, without restoring it or offering 补一句', async () => {
  render(<BotWorkbench botId="bot-1" sessionId="bot-main" />);
  const done = await screen.findByRole('region', { name: 'bots.workbench.group.done' });
  fireEvent.click(within(done).getByRole('button', { expanded: false }));
  fireEvent.click(within(done).getAllByRole('button', { name: 'bots.workbench.openTask' }).at(-1)!);
  await waitFor(() => expect(m.readTask).toHaveBeenCalledWith('bot-1', 's-old'));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(m.navigate).not.toHaveBeenCalled();
});

it('shows the live action and a stop control for a running Cindy task', async () => {
  render(<BotWorkbench botId="bot-1" sessionId="bot-main" />);
  const running = await screen.findByRole('region', { name: 'bots.workbench.group.running' });
  fireEvent.click(within(running).getByRole('button', { name: 'bots.workbench.openTask' }));
  expect(await screen.findByText('bots.workbench.detail.doing')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'bots.workbench.detail.stop' })).toBeTruthy();
});
