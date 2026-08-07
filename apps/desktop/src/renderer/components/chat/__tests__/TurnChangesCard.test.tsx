// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  onContextMenu: vi.fn(),
  openTurnReview: vi.fn(async () => undefined),
  shouldOpenTextLightboxForOrigin: vi.fn(async () => true),
  applyTurnChangeSet: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  useFileChipContextMenu: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { count?: number }) =>
      values?.count === undefined ? key : `${key}:${values.count}`,
  }),
}));

vi.mock('@/features/right-sidebar/lib/openTurnReview', () => ({
  openTurnReview: mocks.openTurnReview,
}));

vi.mock('@/lib/filePreview', () => ({
  shouldOpenTextLightboxForOrigin: mocks.shouldOpenTextLightboxForOrigin,
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

vi.mock('../TextLightbox', () => ({
  TextLightbox: ({ filePath, fileName }: { filePath: string; fileName: string }) => (
    <div data-testid="text-lightbox">{`${fileName}:${filePath}`}</div>
  ),
}));

vi.mock('../useFileChipContextMenu', () => ({
  useFileChipContextMenu: mocks.useFileChipContextMenu,
}));

import { SidebarHostSessionProvider } from '@/features/right-sidebar/lib/sidebarHostSession';
import { TurnChangesCard } from '../TurnChangesCard';
import type { TurnChangeSetSummary } from '../../../../shared/turnChangeSet';

const CHANGE_SET: TurnChangeSetSummary = {
  id: 'change-1',
  sessionId: 'session-1',
  anchorClientId: 'user-1',
  provider: 'codex',
  providerTurnId: 'turn-1',
  cwd: 'C:\\repo',
  state: 'complete',
  workspaceState: 'applied',
  isReversible: true,
  incompleteReasons: [],
  createdAt: 1,
  completedAt: 2,
  files: [{
    id: 'file-1',
    path: 'src/test.ts',
    oldPath: null,
    status: 'modified',
    additions: 3,
    deletions: 1,
  }],
  fileCount: 1,
  additions: 3,
  deletions: 1,
};

const HTML_CHANGE_SET: TurnChangeSetSummary = {
  ...CHANGE_SET,
  files: [{
    ...CHANGE_SET.files[0],
    id: 'file-html',
    path: 'web/page.html',
  }],
};

describe('TurnChangesCard file actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { maker: { applyTurnChangeSet: mocks.applyTurnChangeSet } },
    });
    mocks.useFileChipContextMenu.mockReturnValue({
      onContextMenu: mocks.onContextMenu,
      openAt: vi.fn(),
      menu: <div>file-context-menu</div> as ReactNode,
    });
  });

  it('opens the shared file context menu with the turn cwd resolved path', () => {
    render(<TurnChangesCard sessionId="session-1" changeSet={CHANGE_SET} />);

    const fileRow = screen.getByRole('button', { name: /src\/test\.ts/ });
    fireEvent.contextMenu(fileRow);

    expect(mocks.onContextMenu).toHaveBeenCalledTimes(1);
    expect(mocks.useFileChipContextMenu).toHaveBeenCalledTimes(1);
    const [{ getAbsPath, canOpenInBrowser, sidebarOpenSessionId, onViewSource }] =
      mocks.useFileChipContextMenu.mock.calls[0] as [{
      getAbsPath: () => string;
      canOpenInBrowser: boolean;
      sidebarOpenSessionId?: string;
      onViewSource?: () => Promise<void>;
    }];
    expect(getAbsPath()).toBe('C:\\repo\\src\\test.ts');
    expect(canOpenInBrowser).toBe(false);
    expect(sidebarOpenSessionId).toBeUndefined();
    expect(onViewSource).toBeUndefined();
    expect(screen.getByText('file-context-menu')).toBeTruthy();
  });

  it('matches markdown HTML file actions and lazily opens the current source', async () => {
    render(<TurnChangesCard sessionId="session-1" changeSet={HTML_CHANGE_SET} />);

    const [{ getAbsPath, canOpenInBrowser, sidebarOpenSessionId, onViewSource }] =
      mocks.useFileChipContextMenu.mock.calls[0] as [{
        getAbsPath: () => string;
        canOpenInBrowser: boolean;
        sidebarOpenSessionId?: string;
        onViewSource?: () => Promise<void>;
      }];

    expect(getAbsPath()).toBe('C:\\repo\\web\\page.html');
    expect(canOpenInBrowser).toBe(true);
    expect(sidebarOpenSessionId).toBe('session-1');
    expect(onViewSource).toEqual(expect.any(Function));
    expect(mocks.shouldOpenTextLightboxForOrigin).not.toHaveBeenCalled();

    await act(async () => {
      await onViewSource?.();
    });

    expect(mocks.shouldOpenTextLightboxForOrigin).toHaveBeenCalledWith(
      expect.objectContaining({ origin: { kind: 'local' } }),
      'C:\\repo\\web\\page.html',
    );
    expect(screen.getByTestId('text-lightbox').textContent).toBe(
      'page.html:C:\\repo\\web\\page.html',
    );
  });

  it('keeps left click routed to exact turn review', () => {
    render(<TurnChangesCard sessionId="session-1" changeSet={CHANGE_SET} />);

    fireEvent.click(screen.getByRole('button', { name: /src\/test\.ts/ }));

    expect(mocks.openTurnReview).toHaveBeenCalledWith(
      'session-1',
      ['change-1'],
      { selectedDiffId: 'file-1', hostSessionId: null },
    );
  });

  it('routes review to the sidebar host bucket when embedded in the collab panel', () => {
    // 协同面板里 worker 流内嵌于 lead 的 RSB tab:review tab 必须开到 lead 的
    // 可见桶(hostSessionId),否则落进 worker 自己的桶,点了没有任何反应。
    render(
      <SidebarHostSessionProvider sessionId="lead-1">
        <TurnChangesCard sessionId="session-1" changeSet={CHANGE_SET} />
      </SidebarHostSessionProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /src\/test\.ts/ }));

    expect(mocks.openTurnReview).toHaveBeenCalledWith(
      'session-1',
      ['change-1'],
      { selectedDiffId: 'file-1', hostSessionId: 'lead-1' },
    );
  });

  it('switches from undo to reapply only after Main applies the patch', async () => {
    mocks.applyTurnChangeSet.mockResolvedValue({
      action: 'undo',
      changed: true,
      summary: { ...CHANGE_SET, workspaceState: 'undone' },
    });
    render(<TurnChangesCard sessionId="session-1" changeSet={CHANGE_SET} />);

    fireEvent.click(screen.getByRole('button', { name: 'chat.turnChanges.undoAria' }));

    await waitFor(() => expect(mocks.applyTurnChangeSet).toHaveBeenCalledWith(
      'session-1',
      'change-1',
      'undo',
    ));
    expect(await screen.findByRole('button', { name: 'chat.turnChanges.reapplyAria' })).toBeTruthy();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('chat.turnChanges.undoSuccess');
  });

  it('offers partial undo for the exactly captured subset and explains the boundary', async () => {
    const partial: TurnChangeSetSummary = {
      ...CHANGE_SET,
      state: 'partial',
      isReversible: true,
      incompleteReasons: ['opaque-tool'],
    };
    mocks.applyTurnChangeSet
      .mockResolvedValueOnce({
        action: 'undo',
        changed: true,
        summary: { ...partial, workspaceState: 'undone' },
      })
      .mockResolvedValueOnce({
        action: 'reapply',
        changed: true,
        summary: { ...partial, workspaceState: 'applied' },
      });
    render(<TurnChangesCard sessionId="session-1" changeSet={partial} />);

    expect(screen.getByText('chat.turnChanges.partialReversible')).toBeTruthy();
    const undo = screen.getByRole('button', { name: 'chat.turnChanges.undoPartialAria' });
    expect(undo.getAttribute('title')).toBe('chat.turnChanges.partialActionHint');
    fireEvent.click(undo);

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'chat.turnChanges.undoPartialSuccess',
    ));
    fireEvent.click(await screen.findByRole('button', {
      name: 'chat.turnChanges.reapplyPartialAria',
    }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'chat.turnChanges.reapplyPartialSuccess',
    ));
  });

  it('renders a zero-file evidence card as a pure warning without +0 -0 or dead-end actions', () => {
    // 零文件但带变更证据(如 sensitive-file / diff-too-large)的卡:内容没录下,
    // +0 -0 会被误读成「没有变化」,「审查」必然打开空面板。只保留警示文案。
    render(
      <TurnChangesCard
        sessionId="session-1"
        changeSet={{
          ...CHANGE_SET,
          state: 'partial',
          isReversible: false,
          incompleteReasons: ['sensitive-file'],
          files: [],
          fileCount: 0,
          additions: 0,
          deletions: 0,
        }}
      />,
    );

    expect(screen.getByText('chat.turnChanges.partialTitle')).toBeTruthy();
    expect(screen.getByText('chat.turnChanges.partialNone')).toBeTruthy();
    expect(screen.queryByText(/\+0/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'chat.turnChanges.review' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'chat.turnChanges.undoAria' })).toBeNull();
  });

  it('does not offer undo for a non-reversible patch', () => {
    render(
      <TurnChangesCard
        sessionId="session-1"
        changeSet={{ ...CHANGE_SET, state: 'partial', isReversible: false }}
      />,
    );

    expect(screen.queryByRole('button', { name: 'chat.turnChanges.undoAria' })).toBeNull();
    expect(screen.getByRole('button', { name: 'chat.turnChanges.review' })).toBeTruthy();
  });

  it('does not retain a stale local state when the Main push arrives before the IPC result', async () => {
    let resolveApply!: (value: unknown) => void;
    mocks.applyTurnChangeSet.mockReturnValue(new Promise((resolve) => {
      resolveApply = resolve;
    }));
    const view = render(<TurnChangesCard sessionId="session-1" changeSet={CHANGE_SET} />);
    fireEvent.click(screen.getByRole('button', { name: 'chat.turnChanges.undoAria' }));

    view.rerender(
      <TurnChangesCard
        sessionId="session-1"
        changeSet={{ ...CHANGE_SET, workspaceState: 'undone' }}
      />,
    );
    await act(async () => {
      resolveApply({
        action: 'undo',
        changed: true,
        summary: { ...CHANGE_SET, workspaceState: 'undone' },
      });
    });
    view.rerender(<TurnChangesCard sessionId="session-1" changeSet={CHANGE_SET} />);

    expect(screen.getByRole('button', { name: 'chat.turnChanges.undoAria' })).toBeTruthy();
  });

  it('keeps the current action when Main rejects a stale workspace', async () => {
    mocks.applyTurnChangeSet.mockRejectedValue(new Error('[STALE_DIFF] stale'));
    render(<TurnChangesCard sessionId="session-1" changeSet={CHANGE_SET} />);

    fireEvent.click(screen.getByRole('button', { name: 'chat.turnChanges.undoAria' }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(
      'chat.turnChanges.actionConflict',
    ));
    expect(screen.getByRole('button', { name: 'chat.turnChanges.undoAria' })).toBeTruthy();
  });

  it('prompts the user to install Git when the action cannot find it', async () => {
    mocks.applyTurnChangeSet.mockRejectedValue(
      new Error('[TURN_CHANGE_GIT_UNAVAILABLE] Git is not installed'),
    );
    render(<TurnChangesCard sessionId="session-1" changeSet={CHANGE_SET} />);

    fireEvent.click(screen.getByRole('button', { name: 'chat.turnChanges.undoAria' }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(
      'chat.turnChanges.gitUnavailable',
    ));
    expect(screen.getByRole('button', { name: 'chat.turnChanges.undoAria' })).toBeTruthy();
  });
});
