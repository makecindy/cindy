// @vitest-environment jsdom

import { createElement, useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { FileDiff, ReviewBranchDiffData, ReviewSource } from '@/lib/gitReview.types';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key} ${options.count}`,
  }),
}));

import {
  actionForReviewDiff,
  BatchActionPill,
  BranchBaseDropdown,
  buildLastTurnCappedData,
  canUsePatchBasedReviewActions,
  CappedSourceView,
  countEagerExpandedDiffRows,
  descriptorForReviewSource,
  discardForReviewDiff,
  filterWhitespaceHiddenDiffs,
  getLastTurnCappedSummaryEntries,
  getCappedDiffForSource,
  getBatchActionLayout,
  getNextCappedFileSelection,
  getCurrentBranchDiffData,
  getExpandedDiffSet,
  getReviewCommitDropdownCompletionEffect,
  getReviewCommitActionDisabledReason,
  getReviewToolbarLayout,
  lastTurnDiscardableDiffs,
  lastTurnStageableTargets,
  partialAllowed,
  REVIEW_BRANCH_BASE_LABEL_MIN_WIDTH_PX,
  ReviewDiffListHeader,
  ReviewMoreMenu,
  ReviewRefreshButton,
  refreshBranchDiffAfterCommit,
  revealReviewFileTreeActiveNode,
  reviewActionRevealClass,
  reviewSourceStatePatch,
  scrollElementIntoContainerView,
  shouldShowBranchBaseLabel,
  shouldOfferReviewOpenFile,
  shouldFallbackFromMissingSelectedCommit,
  shouldHideWhitespaceOnlyDiff,
  summaryEntryToPlaceholderDiff,
  SourceDropdown,
  type WriteActionProps,
  useClearReviewOperationNoticeOnSourceChange,
} from '../ReviewTabBody';

function diff(
  source: FileDiff['source'],
  path: string,
  overrides: Partial<FileDiff> = {},
): FileDiff {
  return {
    id: `${source}:${path}`,
    source,
    path,
    oldPath: null,
    status: 'modified',
    kind: 'text',
    size: null,
    additions: 1,
    deletions: 0,
    isBinary: false,
    isSubmodule: false,
    isTooLarge: false,
    mode: { old: null, new: null },
    index: { oldOid: null, newOid: null },
    rawHeader: '',
    rawPatch: '',
    hunks: [],
    error: null,
    ...overrides,
  };
}

function branchDiffData(baseRef: string): ReviewBranchDiffData {
  return {
    scope: {} as ReviewBranchDiffData['scope'],
    baseRef,
    baseOid: 'base',
    headOid: 'head',
    mergeBaseOid: 'merge-base',
    candidates: [],
    diffs: [diff('branch', `${baseRef}.txt`)],
    capped: null,
    warning: null,
  };
}

describe('ReviewTabBody Last turn actions', () => {
  it('offers local file opening only when neither SSH nor device-link controls the task', () => {
    expect(shouldOfferReviewOpenFile(null, null)).toBe(true);
    expect(shouldOfferReviewOpenFile('ssh-host', null)).toBe(false);
    expect(shouldOfferReviewOpenFile(null, 'device-id')).toBe(false);
  });

  it('keeps Last turn as a read-only source while other sources retain file actions', () => {
    expect(actionForReviewDiff('unstaged', diff('unstaged', 'a.ts'))).toBe('stage');
    expect(actionForReviewDiff('staged', diff('staged', 'b.ts'))).toBe('unstage');
    expect(actionForReviewDiff('last-turn', diff('unstaged', 'a.ts'))).toBeNull();
    expect(actionForReviewDiff('last-turn', diff('staged', 'b.ts'))).toBeNull();
    expect(actionForReviewDiff('unstaged', diff('staged', 'b.ts'))).toBe('stage');
    expect(actionForReviewDiff('staged', diff('unstaged', 'a.ts'))).toBe('unstage');
    expect(actionForReviewDiff('commit' as ReviewSource, diff('unstaged', 'a.ts'))).toBeNull();
    expect(actionForReviewDiff('branch' as ReviewSource, diff('branch', 'feature.ts'))).toBeNull();
  });

  it('does not expose Last turn batch stage targets', () => {
    const targets = lastTurnStageableTargets([
      diff('staged', 'already.ts'),
      diff('unstaged', 'worktree.ts'),
    ]);

    expect(targets).toEqual([]);
  });

  it('offers destructive discard only for the unstaged source', () => {
    expect(discardForReviewDiff('unstaged', diff('unstaged', 'a.ts'))).toBe(true);
    expect(discardForReviewDiff('staged', diff('staged', 'b.ts'))).toBe(false);
    expect(discardForReviewDiff('last-turn', diff('unstaged', 'a.ts'))).toBe(false);
    expect(discardForReviewDiff('last-turn', diff('staged', 'b.ts'))).toBe(false);
    expect(discardForReviewDiff('commit' as ReviewSource, diff('unstaged', 'a.ts'))).toBe(false);
    expect(discardForReviewDiff('branch' as ReviewSource, diff('branch', 'feature.ts'))).toBe(
      false,
    );

    expect(
      lastTurnDiscardableDiffs([diff('staged', 'already.ts'), diff('unstaged', 'worktree.ts')]).map(
        (item) => item.path,
      ),
    ).toEqual([]);
  });
});

describe('ReviewTabBody expanded diff budget', () => {
  function diffWithRows(path: string, rowCount: number): FileDiff {
    return diff('unstaged', path, {
      hunks: [
        {
          index: 0,
          header: `@@ -1,${rowCount} +1,${rowCount} @@`,
          oldStart: 1,
          oldLines: rowCount,
          newStart: 1,
          newLines: rowCount,
          section: '',
          lines: Array.from({ length: rowCount }, (_, index) => ({
            index,
            type: 'context' as const,
            content: `line ${index}`,
            raw: ` line ${index}`,
            oldLineNumber: index + 1,
            newLineNumber: index + 1,
            originalLineNumber: index + 1,
            selectable: false,
            noTrailingNewLine: false,
          })),
          selectableLines: [],
          raw: '',
        },
      ],
    });
  }

  it('adds only expanded diffs that do not already virtualize their own rows', () => {
    const first = diffWithRows('first.ts', 120);
    const second = diffWithRows('second.ts', 120);
    const selfVirtualized = diffWithRows('large.ts', 201);

    expect(countEagerExpandedDiffRows([first, second], new Set([first.id]), 'unified')).toBe(120);
    expect(
      countEagerExpandedDiffRows(
        [first, second, selfVirtualized],
        new Set([first.id, second.id, selfVirtualized.id]),
        'unified',
      ),
    ).toBe(240);
  });

  it('skips expanded-row scanning when file count already virtualizes the outer list', () => {
    const diffs = Array.from({ length: 101 }, (_, index) => diff('unstaged', `${index}.ts`));

    expect(countEagerExpandedDiffRows(diffs, new Set(diffs.map((item) => item.id)), 'unified')).toBe(
      0,
    );
  });
});

describe('ReviewTabBody hunk action eligibility', () => {
  it('keeps patch-based hunk actions available for modified text diffs', () => {
    expect(partialAllowed(diff('unstaged', 'file.txt'))).toBe(true);
  });

  it('disables patch-based hunk actions for deleted files', () => {
    expect(
      partialAllowed(
        diff('unstaged', 'deleted.txt', {
          status: 'deleted',
        }),
      ),
    ).toBe(false);
  });

  it('disables patch-based hunk actions for typechange and mode changes', () => {
    expect(partialAllowed(diff('unstaged', 'file.txt'))).toBe(true);
    expect(
      partialAllowed(
        diff('unstaged', 'link.txt', {
          status: 'typechange',
          mode: { old: '100644', new: '120000' },
        }),
      ),
    ).toBe(false);
    expect(
      partialAllowed(
        diff('unstaged', 'script.sh', {
          mode: { old: '100644', new: '100755' },
        }),
      ),
    ).toBe(false);
  });
});

describe('ReviewTabBody diff expansion state', () => {
  it('combines the persisted all-diff default with ephemeral per-file overrides', () => {
    const diffs = [diff('unstaged', 'a.ts'), diff('unstaged', 'b.ts')];

    expect(Array.from(getExpandedDiffSet(diffs, true, new Map()))).toEqual([
      'unstaged:a.ts',
      'unstaged:b.ts',
    ]);
    expect(
      Array.from(getExpandedDiffSet(diffs, true, new Map([['unstaged:b.ts', false]]))),
    ).toEqual(['unstaged:a.ts']);
    expect(
      Array.from(getExpandedDiffSet(diffs, false, new Map([['unstaged:b.ts', true]]))),
    ).toEqual(['unstaged:b.ts']);
    expect(Array.from(getExpandedDiffSet(diffs, false, new Map()))).toEqual([]);
  });
});

describe('ReviewTabBody source state', () => {
  it('replaces the descriptor and clears entry-only positioning state', () => {
    expect(reviewSourceStatePatch({ kind: 'branch', baseRef: 'main' })).toEqual({
      descriptor: { kind: 'branch', baseRef: 'main' },
      jumpTarget: null,
      turnTarget: null,
    });
  });

  it('restores a non-default branch base when returning to the branch source', () => {
    expect(descriptorForReviewSource('branch', 'origin/release')).toEqual({
      kind: 'branch',
      baseRef: 'origin/release',
    });
  });
});

describe('ReviewTabBody compact source dropdown', () => {
  it('uses a compact toolbar trigger instead of a full-width control', () => {
    render(
      createElement(SourceDropdown, {
        source: 'unstaged',
        counts: { unstaged: 2, staged: 1, branch: 0, lastTurn: 1 },
        onChange: vi.fn(),
      }),
    );

    const trigger = screen.getByRole('button', { name: 'rightSidebar.review.sourceDropdownAria' });
    expect(trigger.className).toContain('max-w-[11rem]');
    expect(trigger.className).not.toContain('w-full');
  });

  it('uses a source trigger wide enough for localized labels in compact toolbar layouts', () => {
    const { rerender } = render(
      createElement(SourceDropdown, {
        source: 'unstaged',
        counts: { unstaged: 2, staged: 1, branch: 0, lastTurn: 1 },
        layout: 'minimal',
        onChange: vi.fn(),
      }),
    );

    let trigger = screen.getByRole('button', { name: 'rightSidebar.review.sourceDropdownAria' });
    expect(trigger.className).toContain('max-w-[10rem]');

    rerender(
      createElement(SourceDropdown, {
        source: 'staged',
        counts: { unstaged: 2, staged: 12, branch: 0, lastTurn: 1 },
        layout: 'compact',
        onChange: vi.fn(),
      }),
    );

    trigger = screen.getByRole('button', { name: 'rightSidebar.review.sourceDropdownAria' });
    expect(trigger.className).toContain('max-w-[10rem]');
  });

  it('renders source counts as positive badges only for dirty worktree sources', () => {
    const { rerender } = render(
      createElement(SourceDropdown, {
        source: 'unstaged',
        counts: { unstaged: 2, staged: 0, branch: 4, lastTurn: 3 },
        onChange: vi.fn(),
      }),
    );

    let trigger = screen.getByRole('button', { name: 'rightSidebar.review.sourceDropdownAria' });
    expect(within(trigger).getByText('2')).toBeTruthy();
    expect(trigger.textContent).not.toContain('4');
    expect(trigger.textContent).not.toContain('3');

    rerender(
      createElement(SourceDropdown, {
        source: 'branch',
        counts: { unstaged: 2, staged: 0, branch: 4, lastTurn: 3 },
        onChange: vi.fn(),
      }),
    );
    trigger = screen.getByRole('button', { name: 'rightSidebar.review.sourceDropdownAria' });
    expect(trigger.textContent).toBe('rightSidebar.review.source.branch');

    rerender(
      createElement(SourceDropdown, {
        source: 'staged',
        counts: { unstaged: 2, staged: 0, branch: 4, lastTurn: 3 },
        onChange: vi.fn(),
      }),
    );
    trigger = screen.getByRole('button', { name: 'rightSidebar.review.sourceDropdownAria' });
    expect(trigger.textContent).toBe('rightSidebar.review.source.staged');
  });
});

describe('ReviewTabBody turn source dropdown', () => {
  // 轮次 descriptor 与 Git 审查共用同一个来源下拉:轮次态下选中项是
  // 轮次伪选项,git 来源仍全部可选——这是"从轮次视图切回 git 审查不需要
  // 关掉重开 tab"的回归钉。
  it('shows the turn pseudo-source as the selected trigger label', () => {
    render(
      createElement(SourceDropdown, {
        source: 'turn',
        counts: {},
        onChange: vi.fn(),
      }),
    );

    const trigger = screen.getByRole('button', { name: 'rightSidebar.review.sourceDropdownAria' });
    expect(trigger.textContent).toBe('rightSidebar.review.turn.title');
  });

  it('lists git sources in turn mode and switches directly without close-reopen', async () => {
    const onChange = vi.fn();
    render(
      createElement(SourceDropdown, {
        source: 'turn',
        counts: {},
        onChange,
      }),
    );

    const trigger = screen.getByRole('button', { name: 'rightSidebar.review.sourceDropdownAria' });
    fireEvent.keyDown(trigger, { key: 'Enter' });

    expect(
      await screen.findByRole('menuitem', { name: 'rightSidebar.review.turn.title' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'rightSidebar.review.source.unstaged' }));
    expect(onChange).toHaveBeenCalledWith('unstaged');
  });

  it('keeps the selected message snapshot item as a no-op', async () => {
    const onChange = vi.fn();
    const onSelectMessageSnapshot = vi.fn();
    render(
      createElement(SourceDropdown, {
        source: 'turn',
        counts: {},
        onChange,
        onSelectMessageSnapshot,
      }),
    );

    const trigger = screen.getByRole('button', { name: 'rightSidebar.review.sourceDropdownAria' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'rightSidebar.review.turn.title' }),
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(onSelectMessageSnapshot).not.toHaveBeenCalled();
  });

  it('keeps the message snapshot available while a git source is active and restores it', async () => {
    const onChange = vi.fn();
    const onSelectMessageSnapshot = vi.fn();
    render(
      createElement(SourceDropdown, {
        source: 'unstaged',
        messageSnapshotAvailable: true,
        counts: { unstaged: 0, staged: 0, branch: 0, lastTurn: 0 },
        onChange,
        onSelectMessageSnapshot,
      }),
    );

    const trigger = screen.getByRole('button', { name: 'rightSidebar.review.sourceDropdownAria' });
    expect(trigger.textContent).toBe('rightSidebar.review.source.unstaged');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'rightSidebar.review.turn.title' }),
    );
    expect(onSelectMessageSnapshot).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not offer a message snapshot for a normal review tab', async () => {
    render(
      createElement(SourceDropdown, {
        source: 'unstaged',
        counts: { unstaged: 0, staged: 0, branch: 0, lastTurn: 0 },
        onChange: vi.fn(),
      }),
    );

    const trigger = screen.getByRole('button', { name: 'rightSidebar.review.sourceDropdownAria' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    await screen.findByRole('menuitem', { name: 'rightSidebar.review.source.unstaged' });
    expect(screen.queryByRole('menuitem', { name: 'rightSidebar.review.turn.title' })).toBeNull();
  });

  it('keeps the same source trigger visible but inert for cross-session snapshots', () => {
    const onChange = vi.fn();
    render(
      createElement(SourceDropdown, {
        source: 'turn',
        counts: {},
        disabledReason: 'cross-session',
        onChange,
      }),
    );

    const trigger = screen.getByRole('button', { name: 'rightSidebar.review.sourceDropdownAria' });
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(trigger.className).toContain('cursor-not-allowed');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('ReviewTabBody branch base dropdown', () => {
  it('marks stale local branch candidates with a tertiary text suffix', () => {
    render(
      createElement(BranchBaseDropdown, {
        candidates: [
          {
            refName: 'origin/main',
            shortName: 'origin/main',
            kind: 'remote-default',
            remote: 'origin',
            oid: 'a'.repeat(40),
          },
          {
            refName: 'main',
            shortName: 'main',
            kind: 'local',
            remote: null,
            oid: 'b'.repeat(40),
            isStaleRisk: true,
          },
        ],
        selectedBaseRef: 'origin/main',
        onSelectBase: vi.fn(),
      }),
    );

    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'rightSidebar.review.branch.baseTooltip' }),
      {
        button: 0,
        ctrlKey: false,
      },
    );

    const suffix = screen.getByText('rightSidebar.review.branch.staleRiskSuffix');
    expect(suffix.className).toContain('text-[var(--text-tertiary)]');
    expect(suffix.parentElement?.textContent).toContain('main');
  });
});

describe('ReviewTabBody refresh control', () => {
  it('uses a descriptive aria label and shows pending state', () => {
    const onRefresh = vi.fn();
    render(
      createElement(ReviewRefreshButton, {
        pending: true,
        onRefresh,
      }),
    );

    const button = screen.getByRole('button', { name: 'rightSidebar.review.refreshGitData' });
    expect(button.querySelector('.animate-spinner')).toBeTruthy();
    button.click();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('ReviewTabBody more menu state icons', () => {
  function renderOpenMoreMenu({
    wordWrap,
    wordDiff,
    hideWhitespace,
    diffExpansionAction,
    fileTreeVisible,
  }: {
    wordWrap: boolean;
    wordDiff: boolean;
    hideWhitespace: boolean;
    diffExpansionAction: 'expand' | 'collapse';
    fileTreeVisible: boolean;
  }) {
    render(
      createElement(ReviewMoreMenu, {
        wordWrap,
        wordDiff,
        hideWhitespace,
        diffExpansionOverflow: {
          action: diffExpansionAction,
          onToggle: vi.fn(),
        },
        fileTreeOverflow: {
          preferenceVisible: fileTreeVisible,
          temporarilyHidden: false,
          onToggle: vi.fn(),
        },
        canCopyGitApply: true,
        onWordWrapChange: vi.fn(),
        onWordDiffChange: vi.fn(),
        onHideWhitespaceChange: vi.fn(),
        onCopyGitApply: vi.fn(),
      }),
    );
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'rightSidebar.review.moreMenu.aria' }),
      {
        button: 0,
        ctrlKey: false,
      },
    );
  }

  it('shows current-state icons next to action text when toggles are enabled', () => {
    renderOpenMoreMenu({
      wordWrap: true,
      wordDiff: true,
      hideWhitespace: true,
      diffExpansionAction: 'collapse',
      fileTreeVisible: true,
    });

    expect(document.body.querySelector('.lucide-wrap-text')).toBeTruthy();
    expect(document.body.querySelector('.lucide-diff')).toBeTruthy();
    expect(document.body.querySelector('.lucide-eye-off')).toBeTruthy();
    expect(document.body.querySelector('.lucide-unfold-vertical')).toBeTruthy();
    expect(document.body.querySelector('.lucide-folder-open')).toBeTruthy();
    expect(screen.queryByText('rightSidebar.review.moreMenu.richPreviewDisable')).toBeNull();
  });

  it('shows current-state icons next to action text when toggles are disabled', () => {
    renderOpenMoreMenu({
      wordWrap: false,
      wordDiff: false,
      hideWhitespace: false,
      diffExpansionAction: 'expand',
      fileTreeVisible: false,
    });

    expect(document.body.querySelector('.lucide-arrow-right')).toBeTruthy();
    expect(document.body.querySelector('.lucide-square-split-horizontal')).toBeTruthy();
    expect(document.body.querySelector('.lucide-eye')).toBeTruthy();
    expect(document.body.querySelector('.lucide-fold-vertical')).toBeTruthy();
    expect(document.body.querySelector('.lucide-folder')).toBeTruthy();
    expect(screen.queryByText('rightSidebar.review.moreMenu.richPreviewEnable')).toBeNull();
  });
});

describe('ReviewTabBody diff list header', () => {
  it('keeps branch base selector shrinkable without squeezing refresh and view mode controls', () => {
    render(
      createElement(ReviewDiffListHeader, {
        fileCount: 5,
        branchBaseControl: createElement(
          'button',
          {
            type: 'button',
            className: 'truncate',
          },
          'feature/a-very-long-branch-name-that-must-not-push-actions-away',
        ),
        refreshPending: false,
        onRefresh: vi.fn(),
        viewMode: 'split',
        onViewModeChange: vi.fn(),
        richMarkdownPreview: true,
        onRichMarkdownPreviewChange: vi.fn(),
      }),
    );

    expect(screen.getByTestId('review-diff-list-header-left').className).toContain('min-w-0');
    expect(screen.getByTestId('review-diff-list-header-left').className).toContain('flex-1');
    expect(screen.getByTestId('review-branch-base-control').className).toContain('min-w-0');
    expect(screen.getByTestId('review-branch-base-control').className).toContain('max-w-[8.5rem]');
    expect(screen.getByTestId('review-diff-list-header-actions').className).toContain('shrink-0');
    expect(screen.getByRole('button', { name: 'rightSidebar.review.refreshGitData' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'rightSidebar.review.moreMenu.richPreviewDisable' }),
    ).toBeTruthy();
    expect(screen.queryByTestId('review-branch-base-label')).toBeNull();
    expect(screen.getByText('rightSidebar.review.fileCount 5')).toBeTruthy();
  });

  it('toggles rich markdown preview from the diff list header', () => {
    const onRichMarkdownPreviewChange = vi.fn();
    render(
      createElement(ReviewDiffListHeader, {
        fileCount: 1,
        refreshPending: false,
        onRefresh: vi.fn(),
        viewMode: 'unified',
        onViewModeChange: vi.fn(),
        richMarkdownPreview: false,
        onRichMarkdownPreviewChange,
      }),
    );

    const button = screen.getByRole('button', {
      name: 'rightSidebar.review.moreMenu.richPreviewEnable',
    });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.querySelector('.lucide-image-off')).toBeTruthy();
    fireEvent.click(button);
    expect(onRichMarkdownPreviewChange).toHaveBeenCalledWith(true);
  });

  it('shows the branch base label from the measured row width, not the viewport width', () => {
    expect(shouldShowBranchBaseLabel(279, true)).toBe(false);
    expect(shouldShowBranchBaseLabel(REVIEW_BRANCH_BASE_LABEL_MIN_WIDTH_PX - 1, true)).toBe(false);
    expect(shouldShowBranchBaseLabel(REVIEW_BRANCH_BASE_LABEL_MIN_WIDTH_PX, true)).toBe(true);
    expect(shouldShowBranchBaseLabel(900, false)).toBe(false);
  });
});

describe('ReviewTabBody responsive layout helpers', () => {
  it('chooses toolbar density from the measured panel width', () => {
    expect(getReviewToolbarLayout(0)).toBe('wide');
    expect(getReviewToolbarLayout(240)).toBe('minimal');
    expect(getReviewToolbarLayout(419)).toBe('minimal');
    expect(getReviewToolbarLayout(420)).toBe('compact');
    expect(getReviewToolbarLayout(559)).toBe('compact');
    expect(getReviewToolbarLayout(560)).toBe('wide');
  });

  it('uses icon-only batch actions in narrow panels', () => {
    expect(getBatchActionLayout(240)).toBe('icon-only');
    expect(getBatchActionLayout(419)).toBe('icon-only');
    expect(getBatchActionLayout(420)).toBe('full');
    expect(getBatchActionLayout(0)).toBe('full');
  });
});

describe('ReviewTabBody commit source guards', () => {
  it('falls back only when the selected commit disappears from a loaded branch list', () => {
    const commits = [{ oid: 'a' }, { oid: 'b' }];

    expect(shouldFallbackFromMissingSelectedCommit('commit', 'missing', commits, true)).toBe(true);
    expect(shouldFallbackFromMissingSelectedCommit('commit', 'a', commits, true)).toBe(false);
    expect(shouldFallbackFromMissingSelectedCommit('commit', 'missing', commits, false)).toBe(
      false,
    );
    expect(shouldFallbackFromMissingSelectedCommit('commit', 'missing', commits, true, true)).toBe(
      false,
    );
    expect(
      shouldFallbackFromMissingSelectedCommit('branch' as ReviewSource, 'missing', commits, true),
    ).toBe(false);
    expect(shouldFallbackFromMissingSelectedCommit('commit', null, commits, true)).toBe(false);
  });

  it('keeps the newly committed selection while commits refresh and after it appears in the refreshed list', () => {
    expect(
      shouldFallbackFromMissingSelectedCommit('commit', 'new', [{ oid: 'old' }], true, true),
    ).toBe(false);
    expect(
      shouldFallbackFromMissingSelectedCommit(
        'commit',
        'new',
        [{ oid: 'new' }, { oid: 'old' }],
        true,
        false,
      ),
    ).toBe(false);
    expect(
      shouldFallbackFromMissingSelectedCommit('commit', 'new', [{ oid: 'old' }], true, false),
    ).toBe(true);
  });
});

describe('ReviewTabBody branch source guards', () => {
  it('hides stale branch diff data while a different selected base is loading', () => {
    const main = branchDiffData('main');

    expect(getCurrentBranchDiffData(main, 'main')).toBe(main);
    expect(getCurrentBranchDiffData(main, null)).toBe(main);
    expect(getCurrentBranchDiffData(main, 'origin/main')).toBeNull();
    expect(getCurrentBranchDiffData(null, 'main')).toBeNull();
  });

  it('keeps fallback branch diff data when the requested base is missing', () => {
    const fallback = {
      ...branchDiffData('origin/main'),
      warning: {
        code: 'base-missing' as const,
        message: 'missing requested base',
        requestedBaseRef: 'deleted-base',
      },
    };
    const staleFallback = {
      ...fallback,
      warning: {
        ...fallback.warning,
        requestedBaseRef: 'other-deleted-base',
      },
    };

    expect(getCurrentBranchDiffData(fallback, 'deleted-base')).toBe(fallback);
    expect(getCurrentBranchDiffData(staleFallback, 'deleted-base')).toBeNull();
  });
});

describe('ReviewTabBody operation notices', () => {
  function OperationNoticeHarness({ source }: { source: ReviewSource }) {
    const [error, setError] = useState<string | null>('stale diff');
    useClearReviewOperationNoticeOnSourceChange(source, () => setError(null));
    return createElement('div', null, error && createElement('div', { role: 'alert' }, error));
  }

  it('clears operation errors when switching review sources', () => {
    const { rerender } = render(createElement(OperationNoticeHarness, { source: 'unstaged' }));

    expect(screen.getByRole('alert').textContent).toBe('stale diff');
    rerender(createElement(OperationNoticeHarness, { source: 'unstaged' }));
    expect(screen.getByRole('alert').textContent).toBe('stale diff');

    rerender(createElement(OperationNoticeHarness, { source: 'staged' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('ReviewTabBody hover-reveal action affordance', () => {
  it('keeps file actions visible without waiting for hover or focus', () => {
    render(
      createElement('div', {
        'data-testid': 'file-actions',
        className: reviewActionRevealClass('file', false),
      }),
    );

    const actions = screen.getByTestId('file-actions');
    expect(actions.className).toContain('visible');
    expect(actions.className).toContain('opacity-100');
    expect(actions.className).not.toContain('group-hover/file:opacity-100');
    expect(actions.className).not.toContain('group-focus-within/file:opacity-100');
  });

  it('keeps pending file actions visible', () => {
    expect(reviewActionRevealClass('file', true)).toContain('opacity-100');
    expect(reviewActionRevealClass('file', true)).not.toContain('opacity-0');
  });

  it('renders bottom floating batch actions with source-specific semantics', () => {
    const stageAll = vi.fn();
    const discardAll = vi.fn();
    const unstagedActions: WriteActionProps = {
      canWrite: true,
      pendingKey: null,
      actionForDiff: () => 'stage',
      discardForDiff: () => true,
      sectionAction: 'stage',
      sectionPendingKey: 'stage:all',
      sectionDiscardVisible: true,
      sectionDiscardPendingKey: 'discard:all',
      onFileAction: vi.fn(),
      onFileDiscard: vi.fn(),
      onHunkAction: vi.fn(),
      onHunkDiscard: vi.fn(),
      onSectionAction: stageAll,
      onSectionDiscard: discardAll,
    };
    const stagedActions: WriteActionProps = {
      canWrite: true,
      pendingKey: null,
      actionForDiff: () => 'unstage',
      sectionAction: 'unstage',
      sectionPendingKey: 'unstage:all',
      onFileAction: vi.fn(),
      onHunkAction: vi.fn(),
      onSectionAction: vi.fn(),
    };
    const { container, rerender } = render(
      createElement(BatchActionPill, {
        allPending: false,
        discardAllPending: false,
        writeAction: unstagedActions,
      }),
    );

    expect(container.querySelector('[data-review-batch-action-pill="true"]')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'rightSidebar.review.actions.discardAll' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'rightSidebar.review.actions.stageAll' }),
    ).toBeTruthy();

    rerender(
      createElement(BatchActionPill, {
        allPending: false,
        discardAllPending: false,
        writeAction: stagedActions,
      }),
    );

    expect(
      screen.queryByRole('button', { name: 'rightSidebar.review.actions.discardAll' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'rightSidebar.review.actions.unstageAll' }),
    ).toBeTruthy();
  });

  it('keeps narrow batch actions icon-only with tooltips and a max-width guard', () => {
    const unstagedActions: WriteActionProps = {
      canWrite: true,
      pendingKey: 'stage:all',
      actionForDiff: () => 'stage',
      discardForDiff: () => true,
      sectionAction: 'stage',
      sectionPendingKey: 'stage:all',
      sectionDiscardVisible: true,
      sectionDiscardPendingKey: 'discard:all',
      onFileAction: vi.fn(),
      onFileDiscard: vi.fn(),
      onHunkAction: vi.fn(),
      onHunkDiscard: vi.fn(),
      onSectionAction: vi.fn(),
      onSectionDiscard: vi.fn(),
    };
    const { container } = render(
      createElement(BatchActionPill, {
        allPending: true,
        discardAllPending: false,
        layout: 'icon-only',
        writeAction: unstagedActions,
      }),
    );

    const pill = container.querySelector<HTMLElement>('[data-review-batch-action-pill="true"]');
    expect(pill?.style.maxWidth).toBe('calc(100% - 16px)');
    const stageButton = screen.getByRole('button', {
      name: 'rightSidebar.review.actions.stageAll',
    });
    expect(stageButton.className).toContain('w-6');
    expect(stageButton.querySelector('.sr-only')?.textContent).toBe(
      'rightSidebar.review.actions.stageAll',
    );
    expect(stageButton.querySelector('.animate-spinner')).toBeTruthy();
  });
});

describe('ReviewTabBody commit dropdown enablement', () => {
  it('requires a message before evaluating change availability', () => {
    expect(
      getReviewCommitActionDisabledReason({
        message: '   ',
        includeUnstaged: true,
        stagedCount: 1,
        unstagedCount: 1,
        canWrite: true,
      }),
    ).toBe('no-message');
  });

  it('allows committing any dirty state when unstaged changes are included', () => {
    expect(
      getReviewCommitActionDisabledReason({
        message: 'ship it',
        includeUnstaged: true,
        stagedCount: 0,
        unstagedCount: 1,
        canWrite: true,
      }),
    ).toBeNull();
    expect(
      getReviewCommitActionDisabledReason({
        message: 'ship it',
        includeUnstaged: true,
        stagedCount: 0,
        unstagedCount: 0,
        canWrite: true,
      }),
    ).toBe('no-changes');
  });

  it('keeps staged-only commits gated on staged changes', () => {
    expect(
      getReviewCommitActionDisabledReason({
        message: 'ship it',
        includeUnstaged: false,
        stagedCount: 1,
        unstagedCount: 1,
        canWrite: true,
      }),
    ).toBeNull();
    expect(
      getReviewCommitActionDisabledReason({
        message: 'ship it',
        includeUnstaged: false,
        stagedCount: 0,
        unstagedCount: 1,
        canWrite: true,
      }),
    ).toBe('no-staged');
  });

  it('honors write gates once the message exists', () => {
    expect(
      getReviewCommitActionDisabledReason({
        message: 'ship it',
        includeUnstaged: true,
        stagedCount: 1,
        unstagedCount: 0,
        canWrite: false,
      }),
    ).toBe('write-disabled');
  });

  it('clears a consumed commit message even when push fails after the commit', () => {
    expect(
      getReviewCommitDropdownCompletionEffect({
        committed: true,
        completed: false,
      }),
    ).toEqual({
      clearMessage: true,
      closeDropdown: false,
    });

    expect(
      getReviewCommitDropdownCompletionEffect({
        committed: true,
        completed: true,
      }),
    ).toEqual({
      clearMessage: true,
      closeDropdown: true,
    });

    expect(
      getReviewCommitDropdownCompletionEffect({
        committed: false,
        completed: false,
      }),
    ).toEqual({
      clearMessage: false,
      closeDropdown: false,
    });
  });

  it('refreshes branch diffs only when a commit succeeds from the branch source', () => {
    const refresh = vi.fn();

    refreshBranchDiffAfterCommit('branch', refresh);
    expect(refresh).toHaveBeenCalledTimes(1);

    refreshBranchDiffAfterCommit('unstaged', refresh);
    refreshBranchDiffAfterCommit('staged', refresh);
    refreshBranchDiffAfterCommit('commit' as ReviewSource, refresh);
    refreshBranchDiffAfterCommit('last-turn', refresh);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('ReviewTabBody hidden whitespace helpers', () => {
  it('hides only modified text diffs that have no hunks in whitespace-hidden mode', () => {
    const whitespaceOnly = diff('unstaged', 'space.ts', { hunks: [] });
    const substantive = diff('unstaged', 'code.ts', {
      hunks: [
        {
          index: 0,
          header: '@@ -1 +1 @@',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          section: '',
          lines: [],
          selectableLines: [],
          raw: '',
        },
      ],
    });
    const untracked = diff('unstaged', 'new.ts', { status: 'untracked', hunks: [] });
    const binary = diff('unstaged', 'image.png', { kind: 'binary', hunks: [] });

    expect(shouldHideWhitespaceOnlyDiff(whitespaceOnly, true)).toBe(true);
    expect(
      filterWhitespaceHiddenDiffs([whitespaceOnly, substantive, untracked, binary], true).map(
        (item) => item.path,
      ),
    ).toEqual(['code.ts', 'new.ts', 'image.png']);
    expect(filterWhitespaceHiddenDiffs([whitespaceOnly], false).map((item) => item.path)).toEqual([
      'space.ts',
    ]);
  });

  it('keeps patch-based hunk actions available when whitespace is hidden', () => {
    expect(canUsePatchBasedReviewActions(false)).toBe(true);
    expect(canUsePatchBasedReviewActions(true)).toBe(true);
  });
});

describe('ReviewTabBody capped diff helpers', () => {
  const capped = {
    reason: 'file-count' as const,
    stats: {
      fileCount: 2,
      totalChangedLines: 3,
      totalChangedBytes: 20,
    },
    files: [
      {
        id: 'branch:main:a.ts',
        source: 'branch' as const,
        path: 'a.ts',
        oldPath: null,
        status: 'modified' as const,
        additions: 2,
        deletions: 1,
        changedLines: 3,
        changedBytes: 20,
        isBinary: false,
        isSubmodule: false,
      },
    ],
  };

  it('selects the capped payload for the active source', () => {
    expect(
      getCappedDiffForSource({
        source: 'branch',
        branchCapped: capped,
      }),
    ).toBe(capped);
    expect(
      getCappedDiffForSource({
        source: 'unstaged',
        worktreeCapped: { unstaged: capped, staged: null },
      }),
    ).toBe(capped);
    expect(
      getCappedDiffForSource({
        source: 'last-turn',
        worktreeCapped: { unstaged: capped, staged: null },
      }),
    ).toBeNull();
    expect(
      getCappedDiffForSource({
        source: 'last-turn',
        lastTurnCapped: capped,
      }),
    ).toBe(capped);
  });

  it('keeps the current capped file selection when it still exists and otherwise defaults to the first file', () => {
    const diffs = [
      diff('branch', 'a.ts', { id: 'branch:main:a.ts' }),
      diff('branch', 'b.ts', { id: 'branch:main:b.ts' }),
    ];

    expect(getNextCappedFileSelection('branch:main:b.ts', diffs)).toBe('branch:main:b.ts');
    expect(getNextCappedFileSelection('missing', diffs)).toBe('branch:main:a.ts');
    expect(getNextCappedFileSelection(null, [])).toBeNull();
  });

  it('converts capped summary entries into lightweight placeholder diffs for file tree and jump UI', () => {
    const placeholder = summaryEntryToPlaceholderDiff(capped.files[0]);

    expect(placeholder).toMatchObject({
      id: 'branch:main:a.ts',
      source: 'branch',
      path: 'a.ts',
      additions: 2,
      deletions: 1,
      size: 20,
      hunks: [],
      rawPatch: '',
    });
  });

  it('keeps mixed staged and unstaged Last turn subsets in normal mode when the subset is below capped thresholds', () => {
    const unstagedEntry = {
      ...capped.files[0],
      id: 'unstaged:small-a.ts',
      source: 'unstaged' as const,
      path: 'small-a.ts',
    };
    const stagedEntry = {
      ...capped.files[0],
      id: 'staged:small-b.ts',
      source: 'staged' as const,
      path: 'small-b.ts',
    };
    const entries = getLastTurnCappedSummaryEntries(
      {
        unstaged: { ...capped, files: [unstagedEntry] },
        staged: { ...capped, files: [stagedEntry] },
      },
      new Set(['small-a.ts', 'small-b.ts']),
    );

    expect(entries.map((entry) => `${entry.source}:${entry.path}`)).toEqual([
      'unstaged:small-a.ts',
      'staged:small-b.ts',
    ]);
    expect(buildLastTurnCappedData([diff('unstaged', 'already-loaded.ts')], entries)).toBeNull();
  });

  it('matches Last turn capped summaries by oldPath for renamed files', () => {
    const renamed = {
      ...capped.files[0],
      id: 'staged:renamed-new.ts',
      source: 'staged' as const,
      path: 'renamed-new.ts',
      oldPath: 'renamed-old.ts',
      status: 'renamed' as const,
    };

    expect(
      getLastTurnCappedSummaryEntries(
        {
          unstaged: null,
          staged: { ...capped, files: [renamed] },
        },
        new Set(['renamed-old.ts']),
      ),
    ).toEqual([renamed]);
  });

  it('keeps Last turn in capped mode when the narrowed subset still exceeds thresholds', () => {
    const huge = {
      ...capped.files[0],
      id: 'unstaged:huge.ts',
      source: 'unstaged' as const,
      path: 'huge.ts',
      changedLines: 9001,
      additions: 9001,
      deletions: 0,
    };

    expect(buildLastTurnCappedData([], [huge])).toMatchObject({
      reason: 'changed-lines',
      stats: { fileCount: 1, totalChangedLines: 9001 },
      files: [huge],
    });
  });

  it('keeps capped views inside the same flex source frame as normal source views', () => {
    const summaryDiff = summaryEntryToPlaceholderDiff(capped.files[0]);
    const { container } = render(
      createElement(CappedSourceView, {
        capped,
        summaryDiffs: [summaryDiff],
        selectedSummaryDiff: null,
        loadedDiff: null,
        loading: false,
        error: null,
        onSelectFile: vi.fn(),
        onRefresh: vi.fn(),
        refreshPending: false,
        viewMode: 'unified',
        onViewModeChange: vi.fn(),
        onRichMarkdownPreviewChange: vi.fn(),
        wordWrap: false,
        wordDiff: true,
        expandedSet: new Set<string>(),
        onToggleDiff: vi.fn(),
        fileTreeVisible: true,
        loadImagePreview: vi.fn(),
        loadMarkdownPreview: vi.fn(),
        richMarkdownPreview: true,
        onOpenFile: vi.fn(),
      }),
    );

    const frame = container.firstElementChild as HTMLElement | null;
    expect(frame?.dataset.testid).toBe('review-capped-source-view');
    expect(frame?.className).toContain('flex');
    expect(frame?.className).toContain('min-h-0');
    expect(frame?.className).toContain('flex-1');
    expect(frame?.className).toContain('flex-col');
    expect(frame?.className).toContain('overflow-hidden');
    expect(within(frame as HTMLElement).getByTestId('review-diff-list-header-left')).toBeTruthy();
  });

  it('uses the selected capped file expansion state for the single rendered file', () => {
    const summaryDiff = summaryEntryToPlaceholderDiff(capped.files[0]);
    const toggle = vi.fn();
    const { rerender } = render(
      createElement(CappedSourceView, {
        capped,
        summaryDiffs: [summaryDiff],
        selectedSummaryDiff: summaryDiff,
        loadedDiff: summaryDiff,
        loading: false,
        error: null,
        onSelectFile: vi.fn(),
        onRefresh: vi.fn(),
        refreshPending: false,
        viewMode: 'unified',
        onViewModeChange: vi.fn(),
        onRichMarkdownPreviewChange: vi.fn(),
        wordWrap: false,
        wordDiff: true,
        expandedSet: new Set([summaryDiff.id]),
        onToggleDiff: toggle,
        fileTreeVisible: false,
        loadImagePreview: vi.fn(),
        loadMarkdownPreview: vi.fn(),
        richMarkdownPreview: true,
        onOpenFile: vi.fn(),
      }),
    );

    const button = screen.getByRole('button', { expanded: true });
    fireEvent.click(button);
    expect(toggle).toHaveBeenCalledWith(summaryDiff.id);

    rerender(
      createElement(CappedSourceView, {
        capped,
        summaryDiffs: [summaryDiff],
        selectedSummaryDiff: summaryDiff,
        loadedDiff: summaryDiff,
        loading: false,
        error: null,
        onSelectFile: vi.fn(),
        onRefresh: vi.fn(),
        refreshPending: false,
        viewMode: 'unified',
        onViewModeChange: vi.fn(),
        onRichMarkdownPreviewChange: vi.fn(),
        wordWrap: false,
        wordDiff: true,
        expandedSet: new Set<string>(),
        onToggleDiff: toggle,
        fileTreeVisible: false,
        loadImagePreview: vi.fn(),
        loadMarkdownPreview: vi.fn(),
        richMarkdownPreview: true,
        onOpenFile: vi.fn(),
      }),
    );

    expect(screen.getByRole('button', { expanded: false })).toBeTruthy();
    expect(screen.queryByText('rightSidebar.review.noRenderableDiff')).toBeNull();
  });

  it('scrolls only the intended container when revealing rows', () => {
    const container = document.createElement('div');
    const row = document.createElement('div');
    const scrollTo = vi.fn();
    container.scrollTop = 40;
    container.scrollTo = scrollTo;
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 100,
      width: 200,
      height: 100,
      top: 100,
      right: 200,
      bottom: 200,
      left: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 160,
      width: 200,
      height: 20,
      top: 160,
      right: 200,
      bottom: 180,
      left: 0,
      toJSON: () => ({}),
    });

    scrollElementIntoContainerView(container, row, 'start');
    expect(scrollTo).toHaveBeenCalledWith({ top: 100 });

    scrollTo.mockClear();
    scrollElementIntoContainerView(container, row, 'nearest');
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('reveals the active file tree row by scrolling only the non-virtual tree container', () => {
    const container = document.createElement('div');
    const row = document.createElement('button');
    row.dataset.reviewFileTreeNodeId = 'unstaged:src/deep.ts';
    container.appendChild(row);
    container.scrollTop = 10;
    const scrollTo = vi.fn();
    container.scrollTo = scrollTo;
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 100,
      width: 200,
      height: 50,
      top: 100,
      right: 200,
      bottom: 150,
      left: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 160,
      width: 200,
      height: 20,
      top: 160,
      right: 200,
      bottom: 180,
      left: 0,
      toJSON: () => ({}),
    });

    revealReviewFileTreeActiveNode({
      activeFileId: 'unstaged:src/deep.ts',
      flatNodes: [
        {
          depth: 1,
          node: {
            type: 'file',
            id: 'unstaged:src/deep.ts',
            path: 'src/deep.ts',
            name: 'deep.ts',
            diff: diff('unstaged', 'src/deep.ts'),
          },
        },
      ],
      virtualized: false,
      treeVirtualizer: { scrollToIndex: vi.fn() },
      listEl: container,
    });

    expect(scrollTo).toHaveBeenCalledWith({ top: 40 });
    rafSpy.mockRestore();
  });

  it('reveals the active file tree row through virtualizer scrollToIndex for virtual trees', () => {
    const scrollToIndex = vi.fn();

    revealReviewFileTreeActiveNode({
      activeFileId: 'unstaged:src/deep.ts',
      flatNodes: [
        {
          depth: 0,
          node: { type: 'directory', id: 'dir:src', path: 'src', name: 'src', children: [] },
        },
        {
          depth: 1,
          node: {
            type: 'file',
            id: 'unstaged:src/deep.ts',
            path: 'src/deep.ts',
            name: 'deep.ts',
            diff: diff('unstaged', 'src/deep.ts'),
          },
        },
      ],
      virtualized: true,
      treeVirtualizer: { scrollToIndex },
      listEl: null,
    });

    expect(scrollToIndex).toHaveBeenCalledWith(1, { align: 'auto' });
  });
});
