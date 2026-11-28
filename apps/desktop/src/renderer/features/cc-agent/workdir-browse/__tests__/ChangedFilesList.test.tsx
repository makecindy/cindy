// @vitest-environment jsdom

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewData, ReviewFileTarget } from '@/lib/gitReview.types';
import { buildDeterministicCommitMessage } from '../../../../../shared/gitCommitMessage';
import { ChangedFilesList } from '../ChangedFilesList';
import type { WorkdirGitFileChange } from '../lib/workdirGitStatus';
import type { ReviewHistoryData } from '../../../../../shared/gitReviewWire';

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
      data: {
        scope: {
          aheadBehind: { ahead: 0, behind: 0, upstream: 'origin/main', stale: false },
        },
      } as ReviewData,
      commitOid: '1234567890abcdef',
      stdout: '',
      stderr: '',
    };
  },
);
const stageFile = vi.fn(
  async (_params: { sessionId: string; targets: ReviewFileTarget[] }) => {
    void _params;
    return {
      data: {} as ReviewData,
      operation: { succeeded: ['a.ts'], failed: [], partial: false, action: 'stage' as const },
    };
  },
);
const unstageFile = vi.fn(
  async (_params: { sessionId: string; targets: ReviewFileTarget[] }) => {
    void _params;
    return {
      data: {} as ReviewData,
      operation: { succeeded: ['a.ts'], failed: [], partial: false, action: 'unstage' as const },
    };
  },
);
const stageAll = vi.fn(
  async (_params: { sessionId: string; targets: ReviewFileTarget[] }) => {
    void _params;
    return {
      data: {} as ReviewData,
      operation: { succeeded: ['a.ts'], failed: [], partial: false, action: 'stage' as const },
    };
  },
);
const history = vi.fn(
  async (_params: { sessionId: string; limit?: number }): Promise<ReviewHistoryData> => {
    void _params;
    return { scope: {} as never, commits: [], upstreamOid: null };
  },
);
const pull = vi.fn(async (_params: { sessionId: string }) => {
  void _params;
  return { data: {} as ReviewData, stdout: '', stderr: '' };
});
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
      gitReview: {
        commit,
        commitMessage,
        discardFile,
        discardAll,
        push,
        pull,
        unstageAll,
        stageFile,
        stageAll,
        unstageFile,
        history,
      },
      openExternal,
    });
  });

  it('shows aggregated changes and reverts one file or all files', async () => {
    const { onGitStateChanged } = renderList();
    expect(screen.getByText('rightSidebar.fileBrowser.changes')).toBeTruthy();
    const rows = screen.getAllByRole('button', { name: /a\.ts/ });
    expect(rows).toHaveLength(2);
    await act(async () => {
      fireEvent.click(
        within(rows[0]).getByRole('button', {
          name: 'rightSidebar.review.actions.discard',
        }),
      );
    });
    expect(unstageAll).not.toHaveBeenCalled();
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
    expect(unstageAll).toHaveBeenCalledTimes(1);
    expect(discardAll).toHaveBeenCalledTimes(2);
    expect(unstageAll.mock.calls[0][0].targets).toEqual([
      { path: 'apps/desktop/src/a.ts', oldPath: null, source: 'staged' },
    ]);
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
    expect(messageField.value).toContain('apps/desktop/src/a.ts');
    expect(messageField.value).not.toContain('apps/desktop/new.ts');

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'rightSidebar.fileBrowser.aiCommitSummary' }),
      );
    });
    expect(messageField.value).toBe(
      'feat(desktop): 增加 AI 提交信息总结\n\n- 根据代码差异生成提交说明',
    );
    expect(commitMessage).toHaveBeenCalledWith({
      sessionId: 'session-1',
      includeUnstaged: false,
    });

    const commitButton = screen.getByRole('button', {
      name: 'rightSidebar.fileBrowser.commitToGithub',
    });
    await act(async () => {
      fireEvent.click(commitButton);
    });
    expect(commit).toHaveBeenCalledWith({
      sessionId: 'session-1',
      message: 'feat(desktop): 增加 AI 提交信息总结\n\n- 根据代码差异生成提交说明',
      includeUnstaged: false,
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

  it('stages and unstages files from the grouped list', async () => {
    // Tier: unit — verifies per-source stage targets; real git mutations are covered below/main tests.
    renderList();
    const rows = screen.getAllByRole('button', { name: /a\.ts/ });
    await act(async () => {
      fireEvent.click(
        within(rows[0]).getByRole('button', {
          name: 'rightSidebar.review.actions.stage',
        }),
      );
    });
    expect(stageFile).toHaveBeenCalledWith({
      sessionId: 'session-1',
      targets: [{ path: 'apps/desktop/src/a.ts', oldPath: null, source: 'unstaged' }],
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: 'rightSidebar.review.actions.stageAll',
        }),
      );
    });
    expect(stageAll).toHaveBeenCalledWith({
      sessionId: 'session-1',
      targets: [
        { path: 'apps/desktop/new.ts', oldPath: null, source: 'unstaged' },
        { path: 'apps/desktop/src/a.ts', oldPath: null, source: 'unstaged' },
      ],
    });

    await act(async () => {
      fireEvent.click(
        within(rows[1]).getByRole('button', {
          name: 'rightSidebar.review.actions.unstage',
        }),
      );
    });
    expect(unstageFile).toHaveBeenCalledWith({
      sessionId: 'session-1',
      targets: [{ path: 'apps/desktop/src/a.ts', oldPath: null, source: 'staged' }],
    });
    expect(screen.getByText('rightSidebar.fileBrowser.historyEmpty')).toBeTruthy();
  });

  it('blocks commit and offers pull when the branch is behind', async () => {
    // Tier: unit — pure-behind must disable commit and expose the pull affordance.
    const { data, rerenderWith } = renderList();
    rerenderWith({
      ...data,
      scope: {
        ...data.scope,
        aheadBehind: { ahead: 0, behind: 2, upstream: 'origin/main', stale: true },
      },
    });

    expect(screen.getByText('rightSidebar.fileBrowser.remoteBehind')).toBeTruthy();
    const commitButton = screen.getByRole('button', {
      name: 'rightSidebar.fileBrowser.commitToGithub',
    }) as HTMLButtonElement;
    expect(commitButton.disabled).toBe(true);

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'rightSidebar.fileBrowser.pull' }),
      );
    });
    expect(pull).toHaveBeenCalledWith({ sessionId: 'session-1' });
  });

  it('does not mark the newest commit as unpushed when the branch is in sync', async () => {
    // Tier: unit — a stale history upstreamOid must not override the fresh ahead=0 status.
    history.mockResolvedValueOnce({
      scope: {} as never,
      commits: [
        {
          oid: 'b'.repeat(40),
          shortOid: 'bbbbbbb',
          title: 'latest',
          authorTime: 1_700_000_000,
        },
      ],
      upstreamOid: 'a'.repeat(40),
    });
    renderList();
    await act(async () => {});

    expect(screen.getByText('latest')).toBeTruthy();
    expect(screen.queryByText('rightSidebar.fileBrowser.historyUnpushed')).toBeNull();
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
      includeUnstaged: false,
    });
  });
});
