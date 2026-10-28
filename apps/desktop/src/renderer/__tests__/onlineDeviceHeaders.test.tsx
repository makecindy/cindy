// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
vi.mock('../features/cc-agent/sidebar/MainListScopeHeader', () => ({
  MainListScopeHeader: ({ fold }: { fold: { label: string; onClick: () => void } | null }) =>
    fold ? <button onClick={fold.onClick}>{fold.label}</button> : null,
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
// Keep device grouping real; the header bridge is outside this rendering test.
vi.mock('../features/cc-agent/sidebar/DeviceSectionHeader', () => ({
  DeviceSectionHeader: ({ children }: { children: ReactNode }) => <>{children}</>,
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
vi.mock('@/features/bots/BotAvatar', () => ({ BotAvatar: () => <span>Bot avatar</span> }));
vi.mock('../features/cc-agent/sidebar/SessionItem', () => ({ SessionItem: () => null }));
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
    bots: [],
    filter: {
      creators: 'all', creatorOptions: [], toggleCreator: vi.fn(), setCreatorsAll: vi.fn(),
      groupBy: 'project',
      groupDialogue: true,
      groupDevice,
      sortBy: 'recency',
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
    onToggleProjectPin: vi.fn(),
    onRenameProject: vi.fn(),
    onRemoveFromSidebar: vi.fn(),
    onCollapseAll: vi.fn(),
    onExpandAll: vi.fn(),
    onCreateInProject: vi.fn(),
    onOpenConversationSearch: vi.fn(),
    onOpenInExplorer: vi.fn(),
    onLinkCodexProject: vi.fn(),
    linkingCodexProject: null,
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

describe('Online device headers without tasks', () => {
  // #7237: unit regression through the real group headers. One unnamed host
  // was covered, but two ID-as-name hosts previously had indistinguishable labels.
  it('distinguishes unnamed device headers and folds only the selected device', () => {
    render(<ProjectsSection {...props(true)} remoteDeviceIndex={new Map([
      ['host-b', { name: 'host-b', online: true }],
      ['host-a', { name: '', online: true }],
    ])} />);
    const first = screen.getByText('another computer (1)').closest('button')!;
    const second = screen.getByText('another computer (2)').closest('button')!;
    fireEvent.click(second);
    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect(second.getAttribute('aria-expanded')).toBe('false');
  });

  it('renders and folds an empty online device, then removes it when offline', () => {
    const p = { ...props(true), bots: [], allProjectKeysForOrder: [] };
    const view = render(<ProjectsSection {...p} />);
    const header = screen.getByText('Remote device').closest('button')!;
    expect(header.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    view.rerender(
      <ProjectsSection
        {...p}
        remoteDeviceIndex={new Map([['remote', { name: 'Remote device', online: false }]])}
      />,
    );
    expect(screen.queryByText('Remote device')).toBeNull();
    view.rerender(<ProjectsSection {...p} />);
    expect(screen.getByText('Remote device').closest('button')!.getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('does not show device headers when device grouping is disabled', () => {
    render(<ProjectsSection {...props(false)} bots={[]} allProjectKeysForOrder={[]} />);
    expect(screen.queryByText('Remote device')).toBeNull();
  });
});

// #6615: entering Settings unmounts ProjectsSection. Existing device tests only
// rerender it, so they miss lost collapse state. Unit tier: real component clicks
// and unmount/remount with jsdom storage; the smallest input is two empty devices.
describe('Device collapse state after remounting', () => {
  const localName = 'ccAgent.sidebar.deviceGroup.local';
  const remoteName = 'Remote device';
  const deviceHeader = (name: string) => screen.getByText(name).closest('button')!;

  it.each([
    { collapsedNames: [localName] },
    { collapsedNames: [remoteName] },
    { collapsedNames: [localName, remoteName] },
  ])(
    'restores individually collapsed devices: $collapsedNames',
    ({ collapsedNames }) => {
      const p = props(true);
      const view = render(<ProjectsSection {...p} />);
      for (const name of [localName, remoteName]) {
        expect(deviceHeader(name).getAttribute('aria-expanded')).toBe('true');
      }
      for (const name of collapsedNames) fireEvent.click(deviceHeader(name));
      view.unmount();

      render(<ProjectsSection {...p} />);
      for (const name of [localName, remoteName]) {
        expect(deviceHeader(name).getAttribute('aria-expanded')).toBe(
          String(!collapsedNames.includes(name)),
        );
      }
    },
  );

  it('remembers bulk collapse and clears it after expanding all', () => {
    const p = props(true);
    let view = render(<ProjectsSection {...p} />);
    fireEvent.click(screen.getByText('ccAgent.sidebar.foldAll.collapseDevices'));
    view.unmount();

    view = render(<ProjectsSection {...p} />);
    for (const name of [localName, remoteName]) {
      expect(deviceHeader(name).getAttribute('aria-expanded')).toBe('false');
    }
    fireEvent.click(screen.getByText('ccAgent.sidebar.foldAll.expandAll'));
    view.unmount();

    render(<ProjectsSection {...p} />);
    for (const name of [localName, remoteName]) {
      expect(deviceHeader(name).getAttribute('aria-expanded')).toBe('true');
    }
  });
});

describe('Offline device header names', () => {
  function cachedProjectProps(): ProjectsSectionProps {
    const p = props(true);
    p.projects = [
      {
        projectKey: 'device:offline:/project',
        displayName: 'Cached project',
        workingDir: '/project',
        scope: 'remote',
        remoteHostId: null,
        deviceLinkDeviceId: 'offline',
        deviceLinkDeviceName: 'Saved computer',
        deviceLinkConnectionStatus: 'disconnected',
        segments: 1,
        sessions: [
          {
            id: 'cached-task',
            title: 'Cached task',
            status: 'active',
            workingDir: '/project',
            deviceLinkDeviceId: 'offline',
            deviceLinkDeviceName: 'Saved computer',
            createdAt: '2026-10-04T00:00:00Z',
            updatedAt: '2026-10-04T00:00:00Z',
          } as Session,
        ],
        latestActivityAt: '2026-10-04T00:00:00Z',
      },
    ];
    p.allProjectKeysForOrder = p.projects.map((project) => project.projectKey);
    return p;
  }

  it('keeps the cached name after disconnecting and uses the current name on reconnect', () => {
    remoteProjectsStore.setDeviceSessions('offline', 'Saved computer', []);
    const p = cachedProjectProps();
    const onlineIndex = new Map(p.remoteDeviceIndex);
    onlineIndex.set('offline', { name: 'Current computer', online: true });
    const view = render(<ProjectsSection {...p} remoteDeviceIndex={onlineIndex} />);
    expect(screen.getByText('Current computer')).toBeTruthy();
    expect(screen.queryByText('Saved computer')).toBeNull();

    act(() => remoteProjectsStore.markDeviceDisconnected('offline'));
    view.rerender(<ProjectsSection {...p} />);
    expect(screen.getByText('Saved computer')).toBeTruthy();
    expect(screen.queryByText('offline')).toBeNull();
    expect(screen.getByText('ccAgent.sidebar.deviceGroup.offline')).toBeTruthy();

    act(() => remoteProjectsStore.renameDevice('offline', 'Renamed computer'));
    expect(screen.getByText('Renamed computer')).toBeTruthy();
    expect(screen.queryByText('Saved computer')).toBeNull();

    view.rerender(<ProjectsSection {...p} remoteDeviceIndex={onlineIndex} />);
    expect(screen.getByText('Current computer')).toBeTruthy();
    expect(screen.queryByText('ccAgent.sidebar.deviceGroup.offline')).toBeNull();
  });

  it('reads the name from a restored offline snapshot on first render', () => {
    remoteProjectsStore.hydrateFromCache([
      {
        deviceId: 'offline',
        deviceName: 'Restored computer',
        sessions: cachedProjectProps().projects[0].sessions,
      },
    ]);
    render(<ProjectsSection {...cachedProjectProps()} />);
    expect(screen.getByText('Restored computer')).toBeTruthy();
    expect(screen.queryByText('offline')).toBeNull();
  });

  it('uses a readable fallback when no device name is known', () => {
    render(<ProjectsSection {...cachedProjectProps()} />);
    expect(screen.getByText('another computer')).toBeTruthy();
  });

  it('does not enable device grouping when only disconnected devices remain', () => {
    remoteProjectsStore.setDeviceSessions('offline', 'Saved computer', []);
    remoteProjectsStore.markDeviceDisconnected('offline');
    render(<ProjectsSection {...cachedProjectProps()} remoteDeviceIndex={new Map()} />);
    expect(screen.getByText('Cached project')).toBeTruthy();
    expect(screen.queryByText('Saved computer')).toBeNull();
    expect(screen.queryByText('ccAgent.sidebar.deviceGroup.local')).toBeNull();
  });
});

describe('Cindy Make sidebar entry', () => {
  it.each([false, true])('hides the label, old tasks and creation entry with device grouping %s when disabled', (groupDevice) => {
    feature.enabled = false;
    render(<ProjectsSection {...makeProps(groupDevice, false)} />);
    expect(screen.queryByText('settings.cindyMake.title')).toBeNull();
    expect(screen.queryByText('Make task')).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.cindyMake.create.title' })).toBeNull();
    expect(screen.getByText('Ordinary project')).toBeTruthy();
  });
  function makeProps(groupDevice: boolean, custom: boolean) {
    const p = props(groupDevice);
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

  it.each([false, true])(
    'renders Make before projects and drafts with device grouping %s',
    (groupDevice) => {
      for (const custom of [false, true]) {
        render(<ProjectsSection {...makeProps(groupDevice, custom)} />);
        const make = screen.getByText('settings.cindyMake.title');
        const project = screen.getByText('Ordinary project');
        expect(
          make.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        if (!groupDevice) {
          expect(
            make.compareDocumentPosition(screen.getByText('Ordinary draft')) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ).toBeTruthy();
        }
        expect(screen.getAllByText('settings.cindyMake.title')).toHaveLength(1);
        cleanup();
      }
    },
  );

  it('opens the settings creation dialog without toggling the group and resets it after cancel', async () => {
    render(<ProjectsSection {...makeProps(false, false)} />);
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

  it.each([false, true])(
    'does not open a local creation dialog from remote-only Make with device grouping %s',
    (groupDevice) => {
      const p = makeProps(groupDevice, false);
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
