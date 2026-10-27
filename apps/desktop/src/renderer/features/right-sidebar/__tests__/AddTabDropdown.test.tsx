// @vitest-environment jsdom
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { RenderOptions } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render as testingRender, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AddTabDropdown } from '../AddTabDropdown';
import { DetachedBotMenuOwnerContext } from '../botMenuOwnerContext';
import { EmptyState } from '../EmptyState';
import { FolderTree } from 'lucide-react';
import { useTabCreationMenu } from '../lib/useTabCreationMenu';
import type { TabCreationSelectionOptions } from '../lib/useTabCreationMenu';
import type { SideChatTabPlacement } from '../lib/openSideChatTab';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { __resetGlobalTabsForTest } from '../globalTabs';
import { __resetTabGroupsForTest, getTabGroup } from '../tabGroups';
import { _resetTabKindRegistry, registerTabKind, unregisterTabKind } from '../registry';
import type { TabKindId, TabKindMenuMeta } from '../types';

const render = (ui: ReactElement, options?: RenderOptions) =>
  testingRender(ui, { wrapper: MemoryRouter, ...options });

const m = vi.hoisted(() => ({
  openSideChat: vi.fn(async () => true),
  canSideChat: false,
  ghosts: [] as unknown[],
  profiles: [] as Array<{ id: string; sessions: Array<{ id: string; role: string }> }>,
  rows: new Map<string, { remoteHostId?: string | null; deviceLinkDeviceId?: string | null; deviceLinkConnectionStatus?: string }>(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({ useInstalledGhosts: () => m.ghosts }));
// Radix 浮层在 jsdom 里不需要真的开合:菜单摊平成按钮,只验证有哪些项、点了做什么。
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children, onSelect, disabled }: { children: ReactNode; onSelect?: () => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
}));
vi.mock('@/features/bots/botStore', () => ({
  useBotProfiles: () => m.profiles,
  canonicalBotSessionId: (bot: { sessions: Array<{ id: string; role: string }> }) =>
    bot.sessions.find((session) => session.role === 'canonical')?.id,
}));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { subscribe: () => () => {}, findById: (id: string) => m.rows.get(id) ?? null } }));
vi.mock('../lib/openSideChatTab', () => ({
  canOpenSideChat: () => m.canSideChat,
  openSideChatTab: m.openSideChat,
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ useRemoteProjectSessions: () => [] }));

function registerMenu(kind: TabKindId, labelKey: string, order: number, extra: Partial<TabKindMenuMeta> = {}) {
  registerTabKind({ kind, menu: { kind, labelKey, order, icon: FolderTree, enabled: true, ...extra },
    TabBody: () => null, TabPillTitle: () => null, defaultState: () => null });
}

function Entries({ sessionId, onSelect, both = false, subagentsAvailable = false, sideChatPlacement, ...selectionOptions }: {
  sessionId: string; onSelect: (kind: TabKindId) => void; both?: boolean; subagentsAvailable?: boolean;
  sideChatPlacement?: SideChatTabPlacement;
} & TabCreationSelectionOptions) {
  const menu = useTabCreationMenu({ sessionId, subagentsAvailable, onSelect, sideChatPlacement });
  return <>
    <div data-testid="menu"><AddTabDropdown open={false} anchorRef={createRef<HTMLElement>()}
      menu={menu} onClose={vi.fn()} {...selectionOptions} /></div>
    {both && <div data-testid="empty"><EmptyState menu={menu} selectionOptions={selectionOptions} /></div>}
  </>;
}

function renderMenu(
  sessionId: string,
  onSelect = vi.fn(),
  detachedOwner: { sessionId: string; botId: string; canonical: boolean } | null = null,
) {
  render(<DetachedBotMenuOwnerContext.Provider value={detachedOwner}>
    <Entries sessionId={sessionId} onSelect={onSelect} />
  </DetachedBotMenuOwnerContext.Provider>);
  return onSelect;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.rows = new Map();
  m.canSideChat = false;
  m.ghosts = [];
  m.profiles = [{ id: 'bot-1', sessions: [
    { id: 'bot-main', role: 'canonical' }, { id: 'bot-history', role: 'history' },
  ] }];
  window.localStorage.clear();
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  setDataOwnerGeneration('owner-a', 1);
  _resetTabKindRegistry();
  registerMenu('file-browser', 'rightSidebar.tabs.kinds.fileBrowser', 20);
  registerMenu('review', 'rightSidebar.tabs.kinds.review', 10);
  registerMenu('side-chat', 'chat.sideChat.new', 30);
  registerMenu('subagents', 'rightSidebar.tabs.kinds.subagents', 15);
});
afterEach(() => { cleanup(); _resetTabKindRegistry(); });

// Unit regression: the two entry surfaces drifted in labels, ordering and eligibility.
// Existing tests covered each separately. The same task with both real surfaces shows
// the mismatch; changing one registry entry must update both without another list edit.
it('shows identical action names and order in both entry surfaces', () => {
  const onSelect = vi.fn();
  render(<Entries sessionId="task-1" onSelect={onSelect} both />);
  const menu = within(screen.getByTestId('menu'));
  const empty = within(screen.getByTestId('empty'));
  const labels = (scope: typeof menu) => scope.getAllByRole('button')
    .map(button => button.getAttribute('aria-label') ?? button.textContent);
  expect(labels(empty)).toEqual(labels(menu));
  expect(labels(empty)).toEqual(['rightSidebar.tabs.kinds.review', 'rightSidebar.tabs.kinds.fileBrowser']);
  act(() => registerMenu('web-browser', 'browser.translation', 5, {
    labelText: 'Browser',
    descriptionKey: 'Browse pages in the panel',
  }));
  expect(labels(empty)).toEqual(labels(menu));
  expect(labels(empty)[0]).toBe('Browser');
  expect(empty.getByRole('button', { name: 'Browser', description: 'Browse pages in the panel' })).toBeTruthy();
  expect(menu.queryByText('Browse pages in the panel')).toBeNull();
  fireEvent.click(empty.getByRole('button', { name: 'Browser' }));
  fireEvent.click(menu.getByRole('button', { name: 'Browser' }));
  expect(onSelect.mock.calls).toEqual([['web-browser'], ['web-browser']]);
  act(() => unregisterTabKind('web-browser'));
  expect(empty.queryByRole('button', { name: 'Browser' })).toBeNull();
  expect(labels(empty)).toEqual(labels(menu));
});

it('keeps side-chat pending state and offline restrictions consistent across both entries', async () => {
  m.canSideChat = true;
  let resolve!: (value: boolean) => void;
  m.openSideChat.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  render(<Entries sessionId="task-1" onSelect={vi.fn()} both />);
  const buttons = screen.getAllByRole('button', { name: 'chat.sideChat.new' });
  fireEvent.click(buttons[1]);
  expect(buttons.every(button => (button as HTMLButtonElement).disabled)).toBe(true);
  fireEvent.click(buttons[0]);
  expect(m.openSideChat).toHaveBeenCalledTimes(1);
  await act(async () => resolve(true));
  expect(buttons.every(button => !(button as HTMLButtonElement).disabled)).toBe(true);
  cleanup();
  m.rows.set('remote', { deviceLinkDeviceId: 'host', deviceLinkConnectionStatus: 'disconnected' });
  render(<Entries sessionId="remote" onSelect={vi.fn()} both />);
  expect(screen.getAllByRole('button', { name: 'chat.sideChat.new' })
    .every(button => (button as HTMLButtonElement).disabled)).toBe(true);
});

it.each([false, true])('uses the same Subagent eligibility on both surfaces (available=%s)', subagentsAvailable => {
  render(<Entries sessionId="task-1" onSelect={vi.fn()} both subagentsAvailable={subagentsAvailable} />);
  expect(screen.queryAllByRole('button', { name: 'rightSidebar.tabs.kinds.subagents' })).toHaveLength(subagentsAvailable ? 2 : 0);
});

it('keeps hidden and retired plugin panels out of both entry surfaces', () => {
  registerMenu('retired-feature', 'Retired', -2, { hiddenFromMenu: true });
  registerMenu('ghost:legacy', 'Legacy plugin', -1);
  render(<Entries sessionId="task-1" onSelect={vi.fn()} both />);
  expect(screen.queryByRole('button', { name: 'Retired' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Legacy plugin' })).toBeNull();
});

it('uses the linked identity in a detached window without Bot profiles', () => {
  m.profiles = [];
  renderMenu('bot-main', vi.fn(), { sessionId: 'bot-main', botId: 'bot-1', canonical: true });
  for (const kind of ['review', 'subagents', 'terminal']) {
    expect(screen.queryByText(`rightSidebar.tabs.kinds.${kind}`)).toBeNull();
  }
  expect(screen.getByText('rightSidebar.tabs.kinds.fileBrowser')).toBeTruthy();
});

it('does not reuse a detached owner after switching to another session', () => {
  m.profiles = [];
  renderMenu('task-1', vi.fn(), { sessionId: 'bot-main', botId: 'bot-1', canonical: true });
  expect(screen.getByText('rightSidebar.tabs.kinds.review')).toBeTruthy();
});

it('keeps the other entries on the generic add path', () => {
  const onSelect = renderMenu('bot-main');
  fireEvent.click(screen.getByText('rightSidebar.tabs.kinds.fileBrowser'));
  expect(onSelect).toHaveBeenCalledWith('file-browser');
});

// Unit regression: the missing menu entry must create a child task before opening its tab.
// The generic tab path only produces an empty sessionId, so the existing file/browser tests
// cannot cover this failure. Minimal input: an eligible parent and the new menu item.
// Group/popout placement is part of this opening protocol: a menu must keep its
// new branch in the initiating host after the base branch adds multiple hosts.
it.each([undefined, { groupId: 'left' as const }, { onOptimisticAdd: vi.fn() }])(
  'opens a bound side chat with its host placement (%j)', async placement => {
  m.canSideChat = true;
  const onSelect = vi.fn();
  render(<Entries sessionId="task-1" onSelect={onSelect} sideChatPlacement={placement} />);
  await act(async () => fireEvent.click(screen.getByText('chat.sideChat.new')));
  expect(m.openSideChat).toHaveBeenCalledExactlyOnceWith('task-1', { placement });
  expect(onSelect).not.toHaveBeenCalled();
});

// 测试价值
// - 生产入口与可观察结果:「+」菜单插件项;可观察的是选择时把 (tabId, 此前是否已打开) 交给宿主,
//   独立窗口据此对「已打开」的页签切换 / 聚焦,而不是菜单关掉后毫无反应。
// - Bug / 规则依据:review「弹出窗口『+』菜单里已在别处打开的插件项点了没反应」。
// - 现有覆盖缺口:此前已打开的项不通知宿主。
// - 最小失败输入:同一个插件项连点两次。
// - 合并回归:主干插件项必须同时出现在两个入口,并保留目标分组及已打开页签的聚焦协议。
// - tier: unit,通过真实菜单与全局页签 store 验证。
it.each(['menu', 'empty'])('opens plugins in the selected group and reports existing tabs from %s', surface => {
  m.ghosts = [
    {
      manifest: { id: 'alpha', name: 'Alpha', panel: { html: 'p.html' } },
      enabled: true,
    },
  ];
  const onGlobalTabSelected = vi.fn();
  render(
    <Entries
      sessionId="task-1"
      onSelect={vi.fn()}
      both
      groupId="left"
      onGlobalTabSelected={onGlobalTabSelected}
    />,
  );
  fireEvent.click(within(screen.getByTestId(surface)).getByText('Alpha'));
  expect(onGlobalTabSelected).toHaveBeenLastCalledWith('g_alpha', false);
  expect(getTabGroup('g_alpha')).toBe('left');
  cleanup();
  render(
    <Entries
      sessionId="task-1"
      onSelect={vi.fn()}
      both
      groupId="left"
      onGlobalTabSelected={onGlobalTabSelected}
    />,
  );
  fireEvent.click(within(screen.getByTestId(surface)).getByText('Alpha'));
  expect(onGlobalTabSelected).toHaveBeenLastCalledWith('g_alpha', true);
});
