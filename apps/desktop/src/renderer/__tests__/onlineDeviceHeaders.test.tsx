// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('@/components/sidebar/SortableList', () => ({ SortableList: () => null }));
vi.mock('../features/cc-agent/sidebar/sections/ProjectNode', () => ({ ProjectNode: () => null }));
// Keep device grouping real; the header bridge is outside this rendering test.
vi.mock('../features/cc-agent/sidebar/DeviceSectionHeader', () => ({
  DeviceSectionHeader: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../features/cc-agent/sidebar/sections/UnclassifiedSection', () => ({
  UnclassifiedSection: () => null,
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
