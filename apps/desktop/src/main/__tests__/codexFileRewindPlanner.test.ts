import { describe, expect, it } from 'vitest';

import {
  buildCodexFileRewindPlan,
  CodexFileRewindPlanError,
  type BuildCodexFileRewindPlanInput,
  type CodexRewindSavepoint,
  type CodexRewindUserMessage,
} from '../git-snapshot/codexFileRewindPlanner';

const USER_MESSAGES: CodexRewindUserMessage[] = [
  { clientId: 'm1', createdAt: 100 },
  { clientId: 'm2', createdAt: 200 },
  { clientId: 'm3', createdAt: 300 },
];

function savepoint(
  input: Omit<CodexRewindSavepoint, 'branch' | 'parentCount' | 'source'> &
    Partial<Pick<CodexRewindSavepoint, 'branch' | 'parentCount' | 'source'>>,
): CodexRewindSavepoint {
  return { branch: 'main', parentCount: 1, source: 'legacy', ...input };
}

const SAVEPOINTS: CodexRewindSavepoint[] = [
  savepoint({ commit: 'c3', sessionId: 's1', kind: 'after-edit', anchor: 'm3', label: 'third' }),
  savepoint({ commit: 'foreign', sessionId: 's2', kind: 'after-edit', anchor: 'm3', label: 'foreign' }),
  savepoint({ commit: 'manual', sessionId: 's1', kind: 'manual', anchor: 'm2', label: 'manual' }),
  savepoint({ commit: 'c2', sessionId: 's1', kind: 'after-edit', anchor: 'm2', label: 'second' }),
  savepoint({ commit: 'c1', sessionId: 's1', kind: 'after-edit', anchor: 'm1', label: 'first' }),
];

function plan(overrides: Partial<BuildCodexFileRewindPlanInput> = {}) {
  return buildCodexFileRewindPlan({
    sessionId: 's1',
    targetMessageClientId: 'm2',
    userMessages: USER_MESSAGES,
    repo: {
      kind: 'local-git',
      repoRoot: '/repo',
      currentHead: 'head',
      currentBranch: 'main',
      savepointsNewestFirst: SAVEPOINTS,
    },
    ...overrides,
  });
}

function expectPlanError(
  overrides: Partial<BuildCodexFileRewindPlanInput>,
  code: CodexFileRewindPlanError['code'],
): void {
  let caughtErr: unknown;
  try {
    plan(overrides);
  } catch (err) {
    caughtErr = err;
  }

  expect(caughtErr).toBeInstanceOf(CodexFileRewindPlanError);
  expect((caughtErr as CodexFileRewindPlanError).code).toBe(code);
}

describe('buildCodexFileRewindPlan', () => {
  it('selects current-session after-edit savepoints from the target message onward', () => {
    const result = plan();

    expect(result.mode).toBe('file-rewind');
    if (result.mode !== 'file-rewind') throw new Error('expected file-rewind plan');
    expect(result.revertCommitsNewestFirst).toEqual(['c3', 'c2']);
    expect(result.tailTurnsToDrop).toBe(2);
    expect(result.commits.find((commit) => commit.commit === 'foreign')?.action).toBe('keep');
    expect(result.commits.find((commit) => commit.commit === 'manual')?.action).toBe('keep');
    expect(result.commits.find((commit) => commit.commit === 'c1')?.action).toBe('keep');
  });

  it('keeps before-edit baselines while reverting only turn-end savepoints', () => {
    const result = plan({
      repo: {
        kind: 'local-git',
        repoRoot: '/repo',
        currentHead: 'head',
        currentBranch: 'main',
        savepointsNewestFirst: [
          savepoint({ commit: 'after-m3', sessionId: 's1', kind: 'after-edit', anchor: 'm3' }),
          savepoint({ commit: 'before-m3', sessionId: 's1', kind: 'before-edit', anchor: 'm3' }),
          savepoint({ commit: 'after-m2', sessionId: 's1', kind: 'after-edit', anchor: 'm2' }),
          savepoint({ commit: 'before-m2', sessionId: 's1', kind: 'before-edit', anchor: 'm2' }),
        ],
      },
    });

    expect(result.mode).toBe('file-rewind');
    if (result.mode !== 'file-rewind') throw new Error('expected file-rewind plan');
    expect(result.revertCommitsNewestFirst).toEqual(['after-m3', 'after-m2']);
    expect(result.commits.find((commit) => commit.commit === 'before-m3')?.action).toBe('keep');
    expect(result.commits.find((commit) => commit.commit === 'before-m2')?.action).toBe('keep');
  });

  it('does not select savepoints from other sessions', () => {
    const result = plan({
      repo: {
        kind: 'local-git',
        repoRoot: '/repo',
        currentHead: 'head',
        currentBranch: 'main',
        savepointsNewestFirst: [
          savepoint({ commit: 'foreign', sessionId: 's2', kind: 'after-edit', anchor: 'm2' }),
        ],
      },
    });

    expect(result).toMatchObject({
      mode: 'conversation-only',
      fallbackReason: 'no-savepoints',
      tailTurnsToDrop: 2,
    });
  });

  it('does not select savepoints from other branches', () => {
    const result = plan({
      repo: {
        kind: 'local-git',
        repoRoot: '/repo',
        currentHead: 'head',
        currentBranch: 'main',
        savepointsNewestFirst: [
          savepoint({ commit: 'feature', sessionId: 's1', kind: 'after-edit', anchor: 'm2', branch: 'feature' }),
          savepoint({ commit: 'main', sessionId: 's1', kind: 'after-edit', anchor: 'm2' }),
        ],
      },
    });

    expect(result.mode).toBe('file-rewind');
    if (result.mode !== 'file-rewind') throw new Error('expected file-rewind plan');
    expect(result.revertCommitsNewestFirst).toEqual(['main']);
    expect(result.commits.find((commit) => commit.commit === 'feature')?.action).toBe('keep');
  });

  it('falls back when the selected range contains a dirty-start marker', () => {
    const result = plan({
      repo: {
        kind: 'local-git',
        repoRoot: '/repo',
        currentHead: 'head',
        currentBranch: 'main',
        savepointsNewestFirst: [
          savepoint({ commit: 'c3', sessionId: 's1', kind: 'after-edit', anchor: 'm3' }),
          savepoint({ commit: 'blocked', sessionId: 's1', kind: 'rewind-blocked', anchor: 'm2' }),
        ],
      },
    });

    expect(result).toMatchObject({
      mode: 'conversation-only',
      fallbackReason: 'blocked-by-dirty-start',
      tailTurnsToDrop: 2,
    });
  });

  it('allows later file rewind when a dirty-start marker is before the target range', () => {
    const result = plan({
      targetMessageClientId: 'm3',
      repo: {
        kind: 'local-git',
        repoRoot: '/repo',
        currentHead: 'head',
        currentBranch: 'main',
        savepointsNewestFirst: [
          savepoint({ commit: 'c3', sessionId: 's1', kind: 'after-edit', anchor: 'm3' }),
          savepoint({ commit: 'blocked', sessionId: 's1', kind: 'rewind-blocked', anchor: 'm2' }),
        ],
      },
    });

    expect(result.mode).toBe('file-rewind');
    if (result.mode !== 'file-rewind') throw new Error('expected file-rewind plan');
    expect(result.revertCommitsNewestFirst).toEqual(['c3']);
  });

  it('allows later file rewind when an unanchored blocked marker is before the target range', () => {
    const result = plan({
      targetMessageClientId: 'm3',
      repo: {
        kind: 'local-git',
        repoRoot: '/repo',
        currentHead: 'head',
        currentBranch: 'main',
        savepointsNewestFirst: [
          savepoint({ commit: 'c3', sessionId: 's1', kind: 'after-edit', anchor: 'm3' }),
          savepoint({ commit: 'blocked', sessionId: 's1', kind: 'rewind-blocked' }),
        ],
      },
    });

    expect(result.mode).toBe('file-rewind');
    if (result.mode !== 'file-rewind') throw new Error('expected file-rewind plan');
    expect(result.revertCommitsNewestFirst).toEqual(['c3']);
  });

  it('falls back when an unanchored blocked marker may be within the target range', () => {
    const result = plan({
      repo: {
        kind: 'local-git',
        repoRoot: '/repo',
        currentHead: 'head',
        currentBranch: 'main',
        savepointsNewestFirst: [
          savepoint({ commit: 'c3', sessionId: 's1', kind: 'after-edit', anchor: 'm3' }),
          savepoint({ commit: 'blocked', sessionId: 's1', kind: 'rewind-blocked' }),
        ],
      },
    });

    expect(result).toMatchObject({
      mode: 'conversation-only',
      fallbackReason: 'blocked-by-dirty-start',
      tailTurnsToDrop: 2,
    });
  });

  it('allows selected root savepoint commits', () => {
    const result = plan({
      repo: {
        kind: 'local-git',
        repoRoot: '/repo',
        currentHead: 'root',
        currentBranch: 'main',
        savepointsNewestFirst: [
          savepoint({ commit: 'root', sessionId: 's1', kind: 'after-edit', anchor: 'm2', parentCount: 0 }),
        ],
      },
    });

    expect(result.mode).toBe('file-rewind');
    if (result.mode !== 'file-rewind') throw new Error('expected file-rewind plan');
    expect(result.revertCommitsNewestFirst).toEqual(['root']);
  });

  it('falls back to conversation-only for remote sessions', () => {
    const result = plan({ repo: { kind: 'remote-session' } });

    expect(result).toMatchObject({
      mode: 'conversation-only',
      fallbackReason: 'remote-session',
      conversationWillRewind: true,
    });
  });

  it('falls back to conversation-only for non-git workdirs', () => {
    const result = plan({ repo: { kind: 'non-git-workdir' } });

    expect(result).toMatchObject({
      mode: 'conversation-only',
      fallbackReason: 'non-git-workdir',
    });
  });

  it('falls back to conversation-only when no matching savepoint exists', () => {
    const result = plan({
      targetMessageClientId: 'm3',
      repo: {
        kind: 'local-git',
        repoRoot: '/repo',
        currentHead: 'head',
        currentBranch: 'main',
        savepointsNewestFirst: [
          savepoint({ commit: 'c2', sessionId: 's1', kind: 'after-edit', anchor: 'm2' }),
        ],
      },
    });

    expect(result).toMatchObject({
      mode: 'conversation-only',
      fallbackReason: 'no-savepoints',
      tailTurnsToDrop: 1,
    });
  });

  it('rejects merge savepoints selected by the target range', () => {
    expectPlanError({
      repo: {
        kind: 'local-git',
        repoRoot: '/repo',
        currentHead: 'head',
        currentBranch: 'main',
        savepointsNewestFirst: [
          savepoint({ commit: 'merge', sessionId: 's1', kind: 'after-edit', anchor: 'm2', parentCount: 2 }),
        ],
      },
    }, 'UNSUPPORTED_MERGE_COMMIT');
  });

  it('rejects malformed selected savepoints', () => {
    expectPlanError({
      repo: {
        kind: 'local-git',
        repoRoot: '/repo',
        currentHead: 'head',
        currentBranch: 'main',
        savepointsNewestFirst: [
          savepoint({ commit: '   ', sessionId: 's1', kind: 'after-edit', anchor: 'm2' }),
        ],
      },
    }, 'MALFORMED_SAVEPOINT');
  });

  it('rejects negative parent metadata on selected savepoints', () => {
    expectPlanError({
      repo: {
        kind: 'local-git',
        repoRoot: '/repo',
        currentHead: 'head',
        currentBranch: 'main',
        savepointsNewestFirst: [
          savepoint({ commit: 'bad-parent', sessionId: 's1', kind: 'after-edit', anchor: 'm2', parentCount: -1 }),
        ],
      },
    }, 'MALFORMED_SAVEPOINT');
  });

  it('rejects missing parent metadata on selected savepoints', () => {
    expectPlanError({
      repo: {
        kind: 'local-git',
        repoRoot: '/repo',
        currentHead: 'head',
        currentBranch: 'main',
        savepointsNewestFirst: [
          { commit: 'unknown-parent', sessionId: 's1', kind: 'after-edit', source: 'legacy', branch: 'main', anchor: 'm2' } as CodexRewindSavepoint,
        ],
      },
    }, 'MALFORMED_SAVEPOINT');
  });

  it('rejects missing target messages', () => {
    expectPlanError({ targetMessageClientId: 'missing' }, 'MESSAGE_NOT_FOUND');
  });

  describe('shadow savepoints (refs/cindy 链)', () => {
    it('builds a file-restore plan from selected shadow after-edit savepoints', () => {
      const result = plan({
        repo: {
          kind: 'local-git',
          repoRoot: '/repo',
          currentHead: 'head',
          currentBranch: 'main',
          savepointsNewestFirst: [
            savepoint({ commit: 'sc3', sessionId: 's1', kind: 'after-edit', source: 'shadow', anchor: 'm3', baselineCommit: 'ts3', label: 'third' }),
            savepoint({ commit: 'foreign', sessionId: 's2', kind: 'after-edit', source: 'shadow', anchor: 'm3', baselineCommit: 'tsx' }),
            savepoint({ commit: 'sc2', sessionId: 's1', kind: 'after-edit', source: 'shadow', anchor: 'm2', baselineCommit: 'ts2', label: 'second' }),
            savepoint({ commit: 'sc1', sessionId: 's1', kind: 'after-edit', source: 'shadow', anchor: 'm1', baselineCommit: 'ts1' }),
          ],
        },
      });

      expect(result.mode).toBe('file-restore');
      if (result.mode !== 'file-restore') throw new Error('expected file-restore plan');
      expect(result.repoRoot).toBe('/repo');
      expect(result.currentHead).toBe('head');
      // 文件回到区间内最老一轮 (m2) 的 turn-start 基线。
      expect(result.baselineCommit).toBe('ts2');
      expect(result.restoreCommitsNewestFirst).toEqual([
        { commit: 'sc3', baselineCommit: 'ts3', anchor: 'm3', label: 'third' },
        { commit: 'sc2', baselineCommit: 'ts2', anchor: 'm2', label: 'second' },
      ]);
      expect(result.tailTurnsToDrop).toBe(2);
    });

    it('falls back to conversation-only when the shadow chain read was truncated', () => {
      const result = plan({
        repo: {
          kind: 'local-git',
          repoRoot: '/repo',
          currentHead: 'head',
          currentBranch: 'main',
          shadowSavepointsTruncated: true,
          // 窗口内仍有可入选的 after-edit,但窗口外的历史未知 → 不得部分回退。
          savepointsNewestFirst: [
            savepoint({ commit: 'sc2', sessionId: 's1', kind: 'after-edit', source: 'shadow', anchor: 'm2', baselineCommit: 'ts2' }),
          ],
        },
      });

      expect(result).toMatchObject({
        mode: 'conversation-only',
        fallbackReason: 'savepoint-history-truncated',
      });
    });

    it('selects shadow savepoints regardless of branch (no branch filter)', () => {
      const result = plan({
        repo: {
          kind: 'local-git',
          repoRoot: '/repo',
          currentHead: 'head',
          currentBranch: 'main',
          savepointsNewestFirst: [
            savepoint({ commit: 'sb', sessionId: 's1', kind: 'after-edit', source: 'shadow', anchor: 'm2', baselineCommit: 'tsb', branch: 'feature' }),
          ],
        },
      });

      expect(result.mode).toBe('file-restore');
      if (result.mode !== 'file-restore') throw new Error('expected file-restore plan');
      expect(result.baselineCommit).toBe('tsb');
      expect(result.restoreCommitsNewestFirst).toEqual([
        { commit: 'sb', baselineCommit: 'tsb', anchor: 'm2' },
      ]);
    });

    it('falls back with savepoint-gap when a shadow blocking marker lands in the target range', () => {
      const result = plan({
        repo: {
          kind: 'local-git',
          repoRoot: '/repo',
          currentHead: 'head',
          currentBranch: 'main',
          savepointsNewestFirst: [
            savepoint({ commit: 'sc3', sessionId: 's1', kind: 'after-edit', source: 'shadow', anchor: 'm3', baselineCommit: 'ts3' }),
            savepoint({ commit: 'gap', sessionId: 's1', kind: 'rewind-blocked', source: 'shadow', anchor: 'm2' }),
          ],
        },
      });

      expect(result).toMatchObject({
        mode: 'conversation-only',
        fallbackReason: 'savepoint-gap',
        tailTurnsToDrop: 2,
      });
    });

    it('allows file restore when the shadow blocking marker is before the target range', () => {
      const result = plan({
        targetMessageClientId: 'm3',
        repo: {
          kind: 'local-git',
          repoRoot: '/repo',
          currentHead: 'head',
          currentBranch: 'main',
          savepointsNewestFirst: [
            savepoint({ commit: 'sc3', sessionId: 's1', kind: 'after-edit', source: 'shadow', anchor: 'm3', baselineCommit: 'ts3' }),
            savepoint({ commit: 'gap', sessionId: 's1', kind: 'rewind-blocked', source: 'shadow', anchor: 'm2' }),
          ],
        },
      });

      expect(result.mode).toBe('file-restore');
      if (result.mode !== 'file-restore') throw new Error('expected file-restore plan');
      expect(result.baselineCommit).toBe('ts3');
      expect(result.restoreCommitsNewestFirst).toEqual([
        { commit: 'sc3', baselineCommit: 'ts3', anchor: 'm3' },
      ]);
    });

    it('falls back with mixed-savepoint-formats when both generations select (upgrade window)', () => {
      const result = plan({
        repo: {
          kind: 'local-git',
          repoRoot: '/repo',
          currentHead: 'head',
          currentBranch: 'main',
          savepointsNewestFirst: [
            savepoint({ commit: 'sc3', sessionId: 's1', kind: 'after-edit', source: 'shadow', anchor: 'm3', baselineCommit: 'ts3' }),
            savepoint({ commit: 'c2', sessionId: 's1', kind: 'after-edit', anchor: 'm2' }),
          ],
        },
      });

      expect(result).toMatchObject({
        mode: 'conversation-only',
        fallbackReason: 'mixed-savepoint-formats',
        tailTurnsToDrop: 2,
      });
    });

    it('falls back when a selected shadow after-edit lacks its turn-start baseline', () => {
      const result = plan({
        repo: {
          kind: 'local-git',
          repoRoot: '/repo',
          currentHead: 'head',
          currentBranch: 'main',
          savepointsNewestFirst: [
            savepoint({ commit: 'sc3', sessionId: 's1', kind: 'after-edit', source: 'shadow', anchor: 'm3', baselineCommit: 'ts3' }),
            savepoint({ commit: 'sc2', sessionId: 's1', kind: 'after-edit', source: 'shadow', anchor: 'm2' }),
          ],
        },
      });

      expect(result).toMatchObject({
        mode: 'conversation-only',
        fallbackReason: 'missing-turn-start-baseline',
        tailTurnsToDrop: 2,
      });
    });

    it('keeps the legacy file-rewind plan when only legacy savepoints select (regression)', () => {
      const result = plan({
        repo: {
          kind: 'local-git',
          repoRoot: '/repo',
          currentHead: 'head',
          currentBranch: 'main',
          savepointsNewestFirst: [
            // 区间外的 shadow 保存点不入选, 不该触发 mixed-savepoint-formats。
            savepoint({ commit: 'sc1', sessionId: 's1', kind: 'after-edit', source: 'shadow', anchor: 'm1', baselineCommit: 'ts1' }),
            savepoint({ commit: 'c3', sessionId: 's1', kind: 'after-edit', anchor: 'm3' }),
            savepoint({ commit: 'c2', sessionId: 's1', kind: 'after-edit', anchor: 'm2' }),
          ],
        },
      });

      expect(result.mode).toBe('file-rewind');
      if (result.mode !== 'file-rewind') throw new Error('expected file-rewind plan');
      expect(result.revertCommitsNewestFirst).toEqual(['c3', 'c2']);
      // legacy commits 快照只覆盖 legacy 桶, shadow 保存点不混入。
      expect(result.commits.map((commit) => commit.commit)).toEqual(['c3', 'c2']);
    });
  });
});
