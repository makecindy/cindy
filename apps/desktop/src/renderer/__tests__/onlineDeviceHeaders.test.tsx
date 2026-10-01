// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import type { ProjectNode } from '../features/cc-agent/lib/projectGrouping';
import {
  ProjectsSection,
  type ProjectsSectionProps,
} from '../features/cc-agent/sidebar/sections/ProjectsSection';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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
    onCreateDialogue: vi.fn(),
  };
}

beforeEach(() => {
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
  localStorage.clear();
});

describe('Online device headers without tasks', () => {
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

describe('Cindy Make sidebar entry', () => {
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
    const dialog = await screen.findByRole('dialog', { name: 'settings.cindyMake.create.title' });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Change the sidebar' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'settings.cindyMake.create.cancel' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(create);
    const reopened = await screen.findByRole('dialog');
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
