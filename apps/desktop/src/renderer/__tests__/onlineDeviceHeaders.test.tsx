// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import type { ProjectNode } from '../features/cc-agent/lib/projectGrouping';
import { remoteProjectsStore } from '../features/device-link/remoteProjectsStore';
import {
  ProjectsSection,
  type ProjectsSectionProps,
} from '../features/cc-agent/sidebar/sections/ProjectsSection';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));
const feature = vi.hoisted(() => ({ enabled: true }));
vi.mock('@cindy/maker-shared/cindy-make-feature', async (importOriginal) => ({
  ...await importOriginal<typeof import('@cindy/maker-shared/cindy-make-feature')>(),
  get CINDY_MAKE_ENABLED() { return feature.enabled; },
}));
beforeEach(() => { feature.enabled = true; });
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/features/device-link/useMachineSwitcher', () => ({
  useEffectiveSelectedMachineId: () => 'all',
}));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }));
vi.mock('@/hooks/useSidebarCardMode', () => ({ useSidebarMainViewMode: () => ({ mode: 'text' }) }));
vi.mock('../features/cc-agent/hooks/useRemoteHostProjectOrders', () => ({
  projectOrderWriteScopeForSelection: () => ({ kind: 'viewer' }),
  useLocalHostProjectOrder: () => ({ snapshot: { manualProjectOrder: [] } }),
  useRemoteHostProjectOrders: () => ({ orders: new Map() }),
}));
vi.mock('@/components/sidebar/SortableList', () => ({
  SortableList: ({
    items,
    renderItem,
  }: {
    items: ProjectNode[];
    renderItem: (item: ProjectNode) => ReactNode;
  }) => <>{items.map(renderItem)}</>,
}));
vi.mock('../features/cc-agent/sidebar/sections/ProjectNode', () => ({
  ProjectNode: ({ project }: { project: ProjectNode }) => <span>{project.displayName}</span>,
}));
// Remote desktop probing is outside the project creation entry's unit scope.
vi.mock('@/features/remote-desktop/useRemoteDesktopAvailability', () => ({
  useRemoteDesktopAvailability: () => ({ available: true, checking: false, retryable: false }),
}));
vi.mock('../features/cc-agent/sidebar/sections/UnclassifiedSection', () => ({
  UnclassifiedSection: ({ sessions }: { sessions: Session[] }) => (
    <>
      {sessions.map((session) => (
        <span key={session.id}>{session.title}</span>
      ))}
    </>
  ),
}));
// 顶部标签后未分类草稿并进混排、经 SessionEntryRows 渲染;只露标题以便校验先后顺序。
vi.mock('../features/cc-agent/sidebar/SessionItem', () => ({
  SessionItem: ({ session }: { session: Session }) => <span>{session.title}</span>,
}));
vi.mock('../features/cc-agent/sidebar/SessionCard', () => ({ SessionCard: () => null }));
vi.mock('../features/cc-agent/sidebar/AutomationSessionGroupItem', () => ({
  AutomationSessionGroupItem: () => null,
}));

function props(groupDevice: boolean): ProjectsSectionProps {
  return {
    unclassified: [],
    projects: [],
    dialogues: [],
    allKnownProjects: [],
    allProjectKeysForOrder: [],
    filter: {
      creators: 'all', creatorOptions: [], toggleCreator: vi.fn(), setCreatorsAll: vi.fn(), setCreatorsNone: vi.fn(),
      hideAutomations: false, setHideAutomations: vi.fn(),
      groupBy: 'project',
      groupDialogue: true,
      groupAutomation: false,
      groupDevice,
      sortBy: 'recency',
      pinnedSortBy: 'manual',
      setPinnedSortBy: vi.fn(),
      projectOrder: 'activity',
      manualProjectOrder: [],
      projects: 'all',
      status: 'active',
      isFilterActive: false,
      projectsAsSet: null,
      isSessionContentFiltered: false,
      vendor: 'all',
      lastActivity: 'all',
      manualPinnedOrder: [],
      setStatus: vi.fn(),
      toggleProject: vi.fn(),
      ensureProjectIncluded: vi.fn(),
      setProjectsAll: vi.fn(),
      gc: vi.fn(),
      setVendor: vi.fn(),
      setLastActivity: vi.fn(),
      setGroupBy: vi.fn(),
      setGroupDialogue: vi.fn(),
      setGroupAutomation: vi.fn(),
      setGroupDevice: vi.fn(),
      setSortBy: vi.fn(),
      setProjectOrder: vi.fn(),
      resetContentFilters: vi.fn(),
      setManualProjectOrder: vi.fn(),
      setManualPinnedOrder: vi.fn(),
      promotePin: vi.fn(),
      removePin: vi.fn(),
    },
    collapsed: new Set(),
    isAllCollapsed: false,
    runningSessionIds: new Set(),
    attachedSessionIds: new Set(),
    notifications: new Set(),
    scheduleSessionIndex: new Map(),
    remoteDeviceIndex: new Map([['remote', { name: 'Remote device', online: true }]]),
    onSessionClick: vi.fn(),
    onAction: vi.fn(),
    onRename: vi.fn(),
    onTogglePin: vi.fn(),
    onScheduleAction: vi.fn(),
    onToggleProject: vi.fn(),
    onSettings: vi.fn(),
    onRenameProject: vi.fn(),
    onCollapseAll: vi.fn(),
    onExpandAll: vi.fn(),
    onCreateInProject: vi.fn(),
    onOpenConversationSearch: vi.fn(),
    onOpenInExplorer: vi.fn(),
    onBrowseFiles: vi.fn(),
    onArchiveAll: vi.fn(),
    onSearchDialogues: vi.fn(),
    onArchiveAllDialogues: vi.fn(),
    onCreateDialogue: vi.fn(),
  };
}

beforeEach(() => {
  remoteProjectsStore.clear();
  localStorage.clear();
  localStorage.setItem('sidebar.collapse.projectSessionLimit', '1');
  // ProjectsSection 渲染时读 window.electronAPI.platform 做项目键比较(main 897de9031);
  // jsdom 没有 preload 桥,这里只补 platform 字段,与 windowCloseBehavior 用例同法。
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { platform: 'darwin' } as unknown as Window['electronAPI'],
  });
});
afterEach(() => {
  cleanup();
  remoteProjectsStore.clear();
  localStorage.clear();
});

// 2026-11-19 极简侧栏:电脑改由顶部标签下的横向电脑行切换,主列表不再竖向插入设备段头。
// 旧「按设备分组」设置仍可能留在用户本地,打开时也必须保持一份平铺列表。
// 最小输入:一个本机项目 + 一个在线远程设备上的项目。
describe('Main list without vertical device sections', () => {
  it.each([false, true])('keeps one flat list with the legacy device grouping setting %s', (groupDevice) => {
    const p = props(groupDevice);
    const base = {
      scope: 'local' as const,
      remoteHostId: null,
      deviceLinkDeviceName: null,
      deviceLinkConnectionStatus: null,
      segments: 1,
      sessions: [],
      latestActivityAt: '2026-10-04T00:00:00Z',
    };
    p.projects = [
      { ...base, projectKey: 'local:/here', displayName: 'Local project', workingDir: '/here', deviceLinkDeviceId: null },
      {
        ...base,
        projectKey: 'device:remote:/there',
        displayName: 'Remote project',
        workingDir: '/there',
        scope: 'remote',
        deviceLinkDeviceId: 'remote',
        deviceLinkDeviceName: 'Remote device',
        deviceLinkConnectionStatus: 'connected',
      },
    ] as ProjectNode[];
    p.allProjectKeysForOrder = p.projects.map((project) => project.projectKey);
    localStorage.setItem('sidebar.collapse.projectSessionLimit', '10');
    render(<ProjectsSection {...p} />);
    expect(screen.getByText('Local project')).toBeTruthy();
    expect(screen.getByText('Remote project')).toBeTruthy();
    expect(screen.queryByText('Remote device')).toBeNull();
    expect(screen.queryByText('ccAgent.sidebar.deviceGroup.local')).toBeNull();
    expect(screen.queryByRole('button', { name: 'ccAgent.sidebar.newProject' })).toBeNull();
  });
});

describe('Cindy Make sidebar entry', () => {
  it('hides the label, old tasks and creation entry when disabled', () => {
    feature.enabled = false;
    render(<ProjectsSection {...makeProps(false)} />);
    expect(screen.queryByText('settings.cindyMake.title')).toBeNull();
    expect(screen.queryByText('Make task')).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.cindyMake.create.title' })).toBeNull();
    expect(screen.getByText('Ordinary project')).toBeTruthy();
  });
  function makeProps(custom: boolean) {
    const p = props(false);
    const make = {
      id: 'make',
      title: 'Make task',
      source: 'cindy-make',
      status: 'active',
      createdAt: '2026-09-17T00:00:00Z',
      updatedAt: '2026-09-17T00:00:00Z',
    } as Session;
    const ordinary = {
      ...make,
      id: 'ordinary',
      source: undefined,
      title: 'Ordinary draft',
      createdAt: '2026-09-22T00:00:00Z',
      updatedAt: '2026-09-22T00:00:00Z',
    };
    p.unclassified = [ordinary, make];
    p.projects = [
      {
        projectKey: 'local:/ordinary',
        displayName: 'Ordinary project',
        workingDir: '/ordinary',
        scope: 'local',
        remoteHostId: null,
        deviceLinkDeviceId: null,
        deviceLinkDeviceName: null,
        deviceLinkConnectionStatus: null,
        segments: 1,
        sessions: [ordinary],
        latestActivityAt: ordinary.updatedAt,
      },
    ];
    p.filter.projectOrder = custom ? 'custom' : 'activity';
    p.filter.manualProjectOrder = ['local:/ordinary'];
    return p;
  }

  it.each([false, true])('renders Make before projects and drafts with custom project order %s', (custom) => {
    localStorage.setItem('sidebar.collapse.projectSessionLimit', '10');
    render(<ProjectsSection {...makeProps(custom)} />);
    const make = screen.getByText('settings.cindyMake.title');
    for (const later of ['Ordinary project', 'Ordinary draft']) {
      expect(
        make.compareDocumentPosition(screen.getByText(later)) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(screen.getAllByText('settings.cindyMake.title')).toHaveLength(1);
  });

  it('opens the settings creation dialog without toggling the group and resets it after cancel', async () => {
    render(<ProjectsSection {...makeProps(false)} />);
    const header = screen.getByText('settings.cindyMake.title').closest('[role="button"]')!;
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    const create = within(header as HTMLElement).getByRole('button', {
      name: 'settings.cindyMake.create.title',
    });
    fireEvent.click(create);
    // 弹窗是 React.lazy 动态载入的(见 ProjectsSection 的 CindyMakeCreateDialog),
    // 首次打开要等 import 落地;并行跑时这一步可能超过 findByRole 默认的 1s 上限,
    // 表现为该用例偶发失败(上游既有 flaky,与业务断言无关)。给足等待窗口。
    const dialog = await screen.findByRole(
      'dialog',
      { name: 'settings.cindyMake.create.title' },
      { timeout: 5000 },
    );
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Change the sidebar' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'settings.cindyMake.create.cancel' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(create);
    const reopened = await screen.findByRole('dialog', {}, { timeout: 5000 });
    expect((within(reopened).getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it(
    'does not open a local creation dialog from remote-only Make',
    () => {
      const p = makeProps(false);
      p.projects = [];
      p.unclassified = p.unclassified
        .filter((session) => session.source === 'cindy-make')
        .map((session) => ({ ...session, deviceLinkDeviceId: 'remote' }));
      render(<ProjectsSection {...p} />);
      expect(screen.getByText('settings.cindyMake.title')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'settings.cindyMake.create.title' })).toBeNull();
    },
  );
});
