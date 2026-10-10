// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SortableListProps } from '@/components/sidebar/SortableList';
import type { ProjectNode } from '../../lib/projectGrouping';
import type { ProjectWorkspace } from '../../../../../shared/projectWorkspaceSettings';
import { WorkspaceNameDialog, WorkspaceProjectList } from '../WorkspaceProjectList';

const mockToast = vi.hoisted(() => ({ error: vi.fn() }));
const transfers = new Map<string, NonNullable<SortableListProps<ProjectNode>['onTransfer']>>();
vi.mock('@/lib/toast', () => ({ toast: mockToast }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }));
vi.mock('@/components/sidebar/SortableList', () => ({
  SortableList: <Item,>({
    items,
    getId,
    renderItem,
    listId,
    onTransfer,
  }: SortableListProps<Item>) => {
    if (listId && onTransfer) transfers.set(listId, onTransfer);
    return (
      <div>
        {items.map((item, index) => (
          <div key={getId(item)}>{renderItem(item, index)}</div>
        ))}
      </div>
    );
  },
}));
vi.mock('../SectionCollapse', () => ({
  SectionCollapse: ({ collapsed, children }: { collapsed: boolean; children: ReactNode }) =>
    collapsed ? null : <>{children}</>,
}));

beforeEach(() => {
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  transfers.clear();
});

const workspaces: ProjectWorkspace[] = [
  { id: 'business', name: 'Business', projectKeys: ['local:/client'], collapsed: false },
  { id: 'code', name: 'Code', projectKeys: [], collapsed: false },
];
const project: ProjectNode = {
  projectKey: 'local:/client',
  scope: 'local',
  workingDir: '/client',
  displayName: 'Client',
  remoteHostId: null,
  deviceLinkDeviceId: null,
  deviceLinkDeviceName: null,
  deviceLinkConnectionStatus: null,
  segments: 1,
  sessions: [],
  latestActivityAt: '2026-10-08',
};

describe('workspace name dialog', () => {
  it('keeps unsaved input when the modal scrim is clicked', async () => {
    const onClose = vi.fn();
    render(<WorkspaceNameDialog workspaces={workspaces} onClose={onClose} onSave={vi.fn()} />);
    const input = screen.getByRole('textbox');
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: 'Keep this name' } });
    fireEvent.pointerDown(document.querySelector('.modal-scrim')!, {
      button: 0,
      pointerType: 'mouse',
    });
    fireEvent.click(document.querySelector('.modal-scrim')!);
    expect(screen.getByRole('textbox').getAttribute('value')).toBe('Keep this name');
    expect(onClose).not.toHaveBeenCalled();
  });
  it('rejects blank and duplicate names without calling storage', async () => {
    const onSave = vi.fn();
    render(<WorkspaceNameDialog workspaces={workspaces} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.workspaces.create' }));
    expect(screen.getByText('ccAgent.sidebar.workspaces.invalidName')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' business ' } });
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.workspaces.create' }));
    expect(screen.getByText('ccAgent.sidebar.workspaces.duplicateName')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps input on a failed save and allows an explicit retry', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    render(<WorkspaceNameDialog workspaces={workspaces} onClose={onClose} onSave={onSave} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: ' New group ' } });
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.workspaces.create' }));
    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith('ccAgent.sidebar.workspaces.saveError'),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(input.getAttribute('value')).toBe(' New group ');
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.workspaces.create' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenNthCalledWith(2, 'New group');
  });

  it('does not duplicate a save while the previous request is pending', async () => {
    let finish: () => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onClose = vi.fn();
    render(
      <WorkspaceNameDialog
        workspace={workspaces[0]}
        workspaces={workspaces}
        onClose={onClose}
        onSave={onSave}
      />,
    );
    const button = screen.getByRole('button', { name: 'ccAgent.sidebar.workspaces.rename' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'commonUi.confirmDialog.cancel' }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});

describe('workspace project list', () => {
  const props = {
    projects: [project],
    workspaces,
    comparisonKey: (key: string) => key,
    disabled: false,
    renderProject: (entry: ProjectNode) => <span>{entry.displayName}</span>,
    renderStatus: () => <span>Running status</span>,
    onMutation: vi.fn().mockResolvedValue(undefined),
    onProjectReorder: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
  };

  it('renders named and empty workspaces alongside the ungrouped drop area', () => {
    render(<WorkspaceProjectList {...props} />);
    expect(
      within(screen.getByRole('region', { name: 'Business' })).getByText('Client'),
    ).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Code' })).toBeTruthy();
    expect(
      screen.getByRole('region', { name: 'ccAgent.sidebar.workspaces.ungrouped' }),
    ).toBeTruthy();
  });

  it('persists keyboard collapse and shows the aggregate activity when collapsed', async () => {
    const { rerender } = render(<WorkspaceProjectList {...props} />);
    const header = screen.getByRole('button', { name: 'Business' });
    fireEvent.keyDown(header, { key: 'Enter' });
    expect(props.onMutation).toHaveBeenCalledWith({
      type: 'set-collapsed',
      id: 'business',
      collapsed: true,
    });
    rerender(
      <WorkspaceProjectList
        {...props}
        workspaces={workspaces.map((entry) => ({ ...entry, collapsed: true }))}
      />,
    );
    expect(screen.queryByText('Client')).toBeNull();
    expect(screen.getAllByText('Running status').length).toBeGreaterThan(0);
  });

  it('returns a project to the ungrouped area after its workspace is deleted', () => {
    const { rerender } = render(<WorkspaceProjectList {...props} />);
    rerender(<WorkspaceProjectList {...props} workspaces={[workspaces[1]!]} />);
    expect(
      within(
        screen.getByRole('region', { name: 'ccAgent.sidebar.workspaces.ungrouped' }),
      ).getByText('Client'),
    ).toBeTruthy();
  });

  it('keeps every workspace available as a drag target in any device section', () => {
    render(<WorkspaceProjectList {...props} projects={[]} />);
    expect(transfers.has('business')).toBe(true);
    expect(transfers.has('code')).toBe(true);
    expect(transfers.has('__ungrouped__')).toBe(true);
  });

  it('reports a failed order save after a successful cross-workspace move', async () => {
    const onProjectReorder = vi.fn().mockRejectedValue(new Error('offline'));
    render(<WorkspaceProjectList {...props} onProjectReorder={onProjectReorder} />);
    await act(async () => {
      transfers.get('business')!({
        itemId: project.projectKey,
        fromListId: 'business',
        toListId: 'code',
        newIndex: 0,
        targetOrderIds: [project.projectKey],
      });
    });
    expect(props.onMutation).toHaveBeenCalledWith({
      type: 'move-project',
      projectKey: project.projectKey,
      workspaceId: 'code',
    });
    expect(onProjectReorder).toHaveBeenCalledWith([project.projectKey]);
    expect(mockToast.error).toHaveBeenCalledWith('ccAgent.sidebar.workspaces.orderError');
  });

  it('does not change project order when saving membership fails', async () => {
    const onMutation = vi.fn().mockRejectedValue(new Error('disk full'));
    const onProjectReorder = vi.fn();
    render(
      <WorkspaceProjectList
        {...props}
        onMutation={onMutation}
        onProjectReorder={onProjectReorder}
      />,
    );
    await act(async () => {
      transfers.get('business')!({
        itemId: project.projectKey,
        fromListId: 'business',
        toListId: 'code',
        newIndex: 0,
        targetOrderIds: [project.projectKey],
      });
    });
    expect(onProjectReorder).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith('ccAgent.sidebar.workspaces.saveError');
  });
});
