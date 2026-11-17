// @vitest-environment jsdom

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewData, ReviewFileTarget } from '@/lib/gitReview.types';
import { buildDeterministicCommitMessage } from '../../../../../shared/gitCommitMessage';
import { ChangedFilesList } from '../ChangedFilesList';
import type { WorkdirGitFileChange } from '../lib/workdirGitStatus';

const confirm = vi.fn(async () => true);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { branch?: string }) =>
      options?.branch ? `${key}:${options.branch}` : key,
  }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm }),
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const discardFile = vi.fn(
  async (_params: { sessionId: string; targets: ReviewFileTarget[] }) => {
    void _params;
    return {
      data: {} as ReviewData,
      operation: { succeeded: ['a.ts'], failed: [], partial: false, action: 'discard' },
    };
  },
);
const unstageAll = vi.fn(
  async (_params: { sessionId: string; targets: ReviewFileTarget[] }) => {
    void _params;
    return {
      data: {
        status: {
          files: [
            {
              path: 'apps/desktop/src/a.ts',
              oldPath: null,
              sources: ['unstaged'],
            },
            {
              path: 'apps/desktop/new.ts',
              oldPath: null,
              sources: ['unstaged'],
            },
          ],
        },
      } as ReviewData,
      operation: { succeeded: ['a.ts'], failed: [], partial: false, action: 'unstage' },
    };
  },
);
const discardAll = vi.fn(
  async (_params: { sessionId: string; targets: ReviewFileTarget[] }) => {
    void _params;
    return {
      data: {} as ReviewData,
      operation: {
        succeeded: ['a.ts', 'new.ts'],
        failed: [],
        partial: false,
        action: 'discard',
      },
    };
  },
);
const commit = vi.fn(
  async (_params: { sessionId: string; message: string; includeUnstaged?: boolean }) => {
    void _params;
    return {
      data: {} as ReviewData,
      commitOid: '1234567890abcdef',
      stdout: '',
      stderr: '',
    };
  },
);
const commitMessage = vi.fn(async (_params: { sessionId: string }) => {
  void _params;
  return {
    message: 'feat(desktop): 增加 AI 提交信息总结\n\n- 根据代码差异生成提交说明',
    source: 'ai' as const,
  };
});
const push = vi.fn(async (_params: { sessionId: string }) => {
  void _params;
  return {
    kind: 'pushed' as const,
    data: {} as ReviewData,
    remote: 'origin',
    remoteRef: 'main',
    stdout: '',
    stderr: '',
    aheadBehind: { ahead: 0, behind: 0, upstream: 'origin/main', stale: false },
  };
});
const openExternal = vi.fn(async (_url: string) => {
  void _url;
  return { success: true };
});

function renderList() {
  const changes = new Map<string, WorkdirGitFileChange>([
    [
      'apps/desktop/src/a.ts',
      {
        path: 'apps/desktop/src/a.ts',
        repoPath: 'apps/desktop/src/a.ts',
        oldPath: null,
        kind: 'modified',
        staged: true,
        unstaged: true,
      },
    ],
    [
      'apps/desktop/new.ts',
      {
        path: 'apps/desktop/new.ts',
        repoPath: 'apps/desktop/new.ts',
        oldPath: null,
        kind: 'untracked',
        staged: false,
        unstaged: true,
      },
    ],
  ]);
  const onGitStateChanged = vi.fn();
  const data = {
    scope: {
      sessionId: 'session-1',
      workdir: '/repo',
      worktreePath: '/repo',
      workingDir: '/repo',
      repoRoot: '/repo',
      branch: 'main',
      headOid: null,
      isDetached: false,
      isUnborn: false,
      branchWebUrl: 'https://github.com/octo/repo/tree/main',
      source: 'worktree',
      aheadBehind: { ahead: 0, behind: 0, upstream: null, stale: false },
      disabledReason: null,
      disabledMessage: null,
      resolutionChain: [],
    },
    status: {
      scope: {} as never,
      files: [
        {
          path: 'apps/desktop/src/a.ts',
          oldPath: null,
          indexStatus: 'modified',
          worktreeStatus: 'modified',
          isUntracked: false,
          isUnmerged: false,
          isSubmodule: false,
          sources: ['staged', 'unstaged'],
          rawXY: 'MM',
        },
        {
          path: 'apps/desktop/new.ts',
          oldPath: null,
          indexStatus: null,
          worktreeStatus: 'untracked',
          isUntracked: true,
          isUnmerged: false,
          isSubmodule: false,
          sources: ['unstaged'],
          rawXY: '??',
        },
      ],
      stagedCount: 1,
      unstagedCount: 2,
      untrackedCount: 1,
      unmergedCount: 0,
      inProgress: [],
      writeDisabledReasons: [],
      dirty: true,
    },
    diffs: { staged: [], unstaged: [] },
    summary: {} as never,
  } satisfies ReviewData;
  const renderTree = (
    currentData: ReviewData,
    currentChanges: ReadonlyMap<string, WorkdirGitFileChange>,
  ) =>
    <ChangedFilesList
      sessionId="session-1"
      deviceId={null}
      data={currentData}
      changes={currentChanges}
      query=""
      selectedPath={null}
      loading={false}
      error={null}
      onSelectFile={vi.fn()}
      onGitStateChanged={onGitStateChanged}
    />;
  const view = render(renderTree(data, changes));
  return {
    changes,
    data,
    onGitStateChanged,
    unmount: view.unmount,
    rerenderWith: (nextData: ReviewData, nextChanges = changes) => {
      view.rerender(renderTree(nextData, nextChanges));
    },
  };
}

describe('ChangedFilesList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.stubGlobal('electronAPI', {
      gitReview: { commit, commitMessage, discardFile, discardAll, push, unstageAll },
      openExternal,
    });
  });

  it('shows aggregated changes and reverts one file or all files', async () => {
    const { onGitStateChanged } = renderList();
    expect(screen.getByText('rightSidebar.fileBrowser.changes')).toBeTruthy();
    const row = screen.getByRole('button', { name: /a\.ts/ });
    await act(async () => {
      fireEvent.click(
        within(row).getByRole('button', {
          name: 'rightSidebar.review.actions.discard',
        }),
      );
    });
    expect(unstageAll).toHaveBeenCalledTimes(1);
    expect(unstageAll.mock.calls[0][0].targets).toEqual([
      { path: 'apps/desktop/src/a.ts', oldPath: null, source: 'staged' },
    ]);
    expect(discardAll).toHaveBeenCalledTimes(1);
    expect(discardAll.mock.calls[0][0].targets).toEqual([
      { path: 'apps/desktop/src/a.ts', oldPath: null, source: 'unstaged' },
    ]);
    expect(discardFile).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'rightSidebar.review.actions.discardAll' }),
      );
    });
    expect(unstageAll).toHaveBeenCalledTimes(2);
    expect(discardAll).toHaveBeenCalledTimes(2);
    expect(discardAll.mock.calls[1][0].targets).toEqual([
      { path: 'apps/desktop/src/a.ts', oldPath: null, source: 'unstaged' },
      { path: 'apps/desktop/new.ts', oldPath: null, source: 'unstaged' },
    ]);
    expect(onGitStateChanged).toHaveBeenCalledTimes(2);
  });

  it('commits a complete message and only pushes when auto push is enabled', async () => {
    const { data, onGitStateChanged } = renderList();
    const messageField = screen.getByRole('textbox', {
      name: 'rightSidebar.fileBrowser.commitMessage',
    }) as HTMLTextAreaElement;
    expect(messageField.value).toBe(buildDeterministicCommitMessage(data));

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'rightSidebar.fileBrowser.aiCommitSummary' }),
      );
    });
    expect(messageField.value).toBe(
      'feat(desktop): 增加 AI 提交信息总结\n\n- 根据代码差异生成提交说明',
    );

    const commitButton = screen.getByRole('button', {
      name: 'rightSidebar.fileBrowser.commitToGithub',
    });
    await act(async () => {
      fireEvent.click(commitButton);
    });
    expect(commit).toHaveBeenCalledWith({
      sessionId: 'session-1',
      message: 'feat(desktop): 增加 AI 提交信息总结\n\n- 根据代码差异生成提交说明',
      includeUnstaged: true,
    });
    expect(buildDeterministicCommitMessage(data)).toContain(
      [
        'chore(desktop): 更新 2 个工作区文件',
        '',
        '- 新增：apps/desktop/new.ts',
        '- 修改：apps/desktop/src/a.ts',
      ].join('\n'),
    );
    expect(push).not.toHaveBeenCalled();
    expect(onGitStateChanged).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('checkbox', { name: 'rightSidebar.fileBrowser.autoPush' }));
    await act(async () => {
      fireEvent.click(commitButton);
    });
    expect(push).toHaveBeenCalledWith({ sessionId: 'session-1' });
    expect(onGitStateChanged).toHaveBeenCalledTimes(3);
  });

  it('remembers auto push across mounts and shows the push branch', () => {
    const first = renderList();
    expect(
      screen.getByText('rightSidebar.fileBrowser.pushBranch:main'),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole('checkbox', { name: 'rightSidebar.fileBrowser.autoPush' }),
    );
    expect(
      (screen.getByRole('checkbox', {
        name: 'rightSidebar.fileBrowser.autoPush',
      }) as HTMLInputElement).checked,
    ).toBe(true);

    first.unmount();
    renderList();
    expect(
      (screen.getByRole('checkbox', {
        name: 'rightSidebar.fileBrowser.autoPush',
      }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('opens the branch page from the push branch label', async () => {
    renderList();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: 'rightSidebar.fileBrowser.pushBranch:main',
        }),
      );
    });

    expect(openExternal).toHaveBeenCalledWith('https://github.com/octo/repo/tree/main');
  });

  it('shows a push failure above the commit card', async () => {
    push.mockRejectedValueOnce(new Error('permission denied'));
    renderList();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'rightSidebar.fileBrowser.autoPush' }),
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: 'rightSidebar.fileBrowser.commitToGithub',
        }),
      );
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('rightSidebar.review.push.failedTitle');
    expect(alert.textContent).toContain('permission denied');
    expect(alert.compareDocumentPosition(
      screen.getByRole('textbox', { name: 'rightSidebar.fileBrowser.commitMessage' }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the AI draft when Git status refreshes before commit', async () => {
    const { data, rerenderWith } = renderList();
    const messageField = screen.getByRole('textbox', {
      name: 'rightSidebar.fileBrowser.commitMessage',
    }) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'rightSidebar.fileBrowser.aiCommitSummary' }),
      );
    });
    expect(messageField.value).toBe(
      'feat(desktop): 增加 AI 提交信息总结\n\n- 根据代码差异生成提交说明',
    );

    rerenderWith({
      ...data,
      status: {
        ...data.status!,
        files: [
          ...data.status!.files,
          {
            path: 'apps/desktop/src/refreshed.ts',
            oldPath: null,
            indexStatus: null,
            worktreeStatus: 'modified',
            isUntracked: false,
            isUnmerged: false,
            isSubmodule: false,
            sources: ['unstaged'],
            rawXY: ' M',
          },
        ],
      },
    });

    expect(messageField.value).toBe(
      'feat(desktop): 增加 AI 提交信息总结\n\n- 根据代码差异生成提交说明',
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'rightSidebar.fileBrowser.commitToGithub' }),
      );
    });
    expect(commit).toHaveBeenCalledWith({
      sessionId: 'session-1',
      message: 'feat(desktop): 增加 AI 提交信息总结\n\n- 根据代码差异生成提交说明',
      includeUnstaged: true,
    });
  });
});
