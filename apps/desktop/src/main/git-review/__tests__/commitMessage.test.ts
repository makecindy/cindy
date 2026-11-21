import { describe, expect, it, vi } from 'vitest';

import {
  buildCommitMessagePrompt,
  createCommitMessageDraft,
  sanitizeCommitMessage,
} from '../commitMessage';
import type { ReviewData } from '../types';

function reviewData(): ReviewData {
  return {
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
          indexStatus: null,
          worktreeStatus: 'modified',
          isUntracked: false,
          isUnmerged: false,
          isSubmodule: false,
          sources: ['unstaged'],
          rawXY: ' M',
        },
      ],
      stagedCount: 0,
      unstagedCount: 1,
      untrackedCount: 0,
      unmergedCount: 0,
      inProgress: [],
      writeDisabledReasons: [],
      dirty: true,
    },
    diffs: {
      staged: [],
      unstaged: [
        {
          id: 'unstaged:a',
          source: 'unstaged',
          path: 'apps/desktop/src/a.ts',
          oldPath: null,
          status: 'modified',
          kind: 'text',
          size: 20,
          additions: 1,
          deletions: 0,
          isBinary: false,
          isSubmodule: false,
          isTooLarge: false,
          mode: { old: '100644', new: '100644' },
          index: { oldOid: null, newOid: null },
          rawHeader: '',
          rawPatch: '',
          hunks: [
            {
              index: 0,
              header: '-1,1 +1,1 @@',
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              section: '',
              lines: [
                { index: 0, type: 'add', content: 'const apiKey = "test-redaction-probe-value"', raw: '', newLineNumber: 1, oldLineNumber: null, originalLineNumber: null, selectable: true, noTrailingNewLine: false },
              ],
              selectableLines: [0],
              raw: '',
            },
          ],
          error: null,
        },
      ],
    },
    summary: {} as never,
  };
}

describe('git commit message one-shot', () => {
  it('redacts secrets and caps model output to a conventional commit message', async () => {
    const data = reviewData();
    const prompt = buildCommitMessagePrompt(data);
    expect(prompt).not.toContain('test-redaction-probe-value');
    expect(prompt).toContain('[REDACTED]');
    expect(
      sanitizeCommitMessage(
        '```markdown\nfeat(desktop): 增加提交信息总结\n\n- 根据代码差异生成说明\n- 保留用户可编辑草稿\n```',
      ),
    ).toBe('feat(desktop): 增加提交信息总结\n\n- 根据代码差异生成说明\n- 保留用户可编辑草稿');
  });

  it('falls back to a deterministic message when one-shot output is unusable', async () => {
    const result = await createCommitMessageDraft(reviewData(), vi.fn(async () => 'not a commit'));
    expect(result).toEqual({
      source: 'fallback',
      message: expect.stringContaining('chore(desktop): 更新 1 个工作区文件'),
    });
  });
});
