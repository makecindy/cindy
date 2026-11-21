import type { FileDiff, FileStatus, ReviewData } from '@/lib/gitReview.types';
import { toWorkdirRel } from '../../../../../shared/workdirPath';
import { isWindowsPathLike } from '../../../../../shared/workingDir';

export type WorkdirGitStatusKind =
  'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'unmerged';

export interface WorkdirGitFileChange {
  path: string;
  oldPath: string | null;
  kind: WorkdirGitStatusKind;
  staged: boolean;
  unstaged: boolean;
}

export interface WorkdirGitDirectoryChange {
  kind: WorkdirGitStatusKind;
  count: number;
}

export interface WorkdirGitMaps {
  files: ReadonlyMap<string, WorkdirGitFileChange>;
  directories: ReadonlyMap<string, WorkdirGitDirectoryChange>;
  changedLines: ReadonlyMap<string, ReadonlySet<number>>;
}

const STATUS_PRIORITY: Record<WorkdirGitStatusKind, number> = {
  untracked: 1,
  added: 2,
  modified: 3,
  renamed: 4,
  copied: 4,
  typechange: 4,
  deleted: 5,
  unmerged: 6,
};

export const WORKDIR_GIT_STATUS_VISUAL: Record<
  WorkdirGitStatusKind,
  { code: string; color: string }
> = {
  modified: { code: 'M', color: 'var(--warning-fg)' },
  added: { code: 'A', color: 'var(--diff-add-fg)' },
  deleted: { code: 'D', color: 'var(--diff-del-fg)' },
  renamed: { code: 'R', color: 'var(--text-secondary)' },
  copied: { code: 'C', color: 'var(--text-secondary)' },
  typechange: { code: 'T', color: 'var(--warning-fg)' },
  untracked: { code: 'U', color: 'var(--focus-ring)' },
  unmerged: { code: '!', color: 'var(--diff-del-fg)' },
};

export const EMPTY_WORKDIR_GIT_MAPS: WorkdirGitMaps = {
  files: new Map(),
  directories: new Map(),
  changedLines: new Map(),
};

export function buildWorkdirGitMaps(data: ReviewData, workdir: string): WorkdirGitMaps {
  const files = new Map<string, WorkdirGitFileChange>();
  const directories = new Map<string, WorkdirGitDirectoryChange>();
  const changedLines = new Map<string, ReadonlySet<number>>();

  for (const file of data.status?.files ?? []) {
    const path = toWorkdirPath(data, workdir, file.path);
    if (!path) continue;
    const kind = fileStatusKind(file);
    files.set(path, {
      path,
      oldPath: file.oldPath,
      kind,
      staged: file.sources.includes('staged'),
      unstaged: file.sources.includes('unstaged'),
    });
    mergeDirectoryStatus(directories, path, kind);
  }

  const addDiff = (diff: FileDiff) => {
    const path = toWorkdirPath(data, workdir, diff.path);
    if (!path || changedLines.has(path) || diff.kind !== 'text') return;
    const lines = new Set<number>();
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.type === 'add' && line.newLineNumber !== null) {
          lines.add(line.newLineNumber);
        }
      }
    }
    if (lines.size > 0) changedLines.set(path, lines);
  };
  for (const diff of data.diffs.unstaged) addDiff(diff);
  for (const diff of data.diffs.staged) addDiff(diff);

  return { files, directories, changedLines };
}

function fileStatusKind(file: FileStatus): WorkdirGitStatusKind {
  if (file.isUnmerged) return 'unmerged';
  if (file.isUntracked) return 'untracked';
  if (file.worktreeStatus === 'deleted' || file.indexStatus === 'deleted') return 'deleted';
  if (file.worktreeStatus === 'renamed' || file.indexStatus === 'renamed') return 'renamed';
  if (file.indexStatus === 'copied') return 'copied';
  if (file.worktreeStatus === 'typechange' || file.indexStatus === 'typechange') {
    return 'typechange';
  }
  if (file.worktreeStatus === 'modified' || file.indexStatus === 'modified') return 'modified';
  if (file.indexStatus === 'added') return 'added';
  return 'modified';
}

function mergeDirectoryStatus(
  directories: Map<string, WorkdirGitDirectoryChange>,
  filePath: string,
  kind: WorkdirGitStatusKind,
): void {
  let slash = filePath.lastIndexOf('/');
  while (slash > 0) {
    const directory = filePath.slice(0, slash);
    const previous = directories.get(directory);
    directories.set(directory, {
      kind:
        !previous || STATUS_PRIORITY[kind] > STATUS_PRIORITY[previous.kind] ? kind : previous.kind,
      count: (previous?.count ?? 0) + 1,
    });
    slash = directory.lastIndexOf('/');
  }
}

function toWorkdirPath(data: ReviewData, workdir: string, repoPath: string): string | null {
  const repoRoot = data.scope.repoRoot;
  if (!repoRoot || !workdir) return null;
  const separator = isWindowsPathLike(repoRoot) ? '\\' : '/';
  const absolute =
    repoRoot.replace(/[\\/]+$/, '') +
    separator +
    (separator === '\\' ? repoPath.replace(/\//g, '\\') : repoPath);
  return toWorkdirRel(workdir, absolute);
}
