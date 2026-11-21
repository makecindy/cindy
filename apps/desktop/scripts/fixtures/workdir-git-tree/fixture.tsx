import { mountPage, subscription } from '../../ui-page/harness';
import { FileTreeView } from '../../../src/renderer/features/cc-agent/workdir-browse/FileTreeView';
import type { DirEntry } from '../../../src/renderer/features/cc-agent/workdir-browse/hooks/useFileTree';
import { useFileTree } from '../../../src/renderer/features/cc-agent/workdir-browse/hooks/useFileTree';
import { useWorkdirGitChanges } from '../../../src/renderer/features/cc-agent/workdir-browse/hooks/useWorkdirGitChanges';
import type { FileStatus, ReviewData } from '../../../src/shared/gitReviewWire';

const WORKDIR = '/fixture/repo';
const SESSION_ID = 'fixture-session';

function dir(relPath: string): DirEntry {
  return { name: relPath.split('/').pop() ?? relPath, relPath, type: 'directory', size: 0, mtimeMs: 0 };
}

function file(relPath: string): DirEntry {
  return { name: relPath.split('/').pop() ?? relPath, relPath, type: 'file', size: 1024, mtimeMs: 0 };
}

const LISTINGS: Record<string, DirEntry[]> = {
  '': [
    dir('src'),
    file('README.md'),
    file('new-file.ts'),
    file('gone.ts'),
    file('renamed.ts'),
    file('draft.txt'),
    file('conflict.ts'),
    file('notes.md'),
  ],
  src: [file('src/app.ts')],
};

function status(
  path: string,
  next: Partial<FileStatus> & { indexStatus: FileStatus['indexStatus'] },
): FileStatus {
  return {
    path,
    oldPath: null,
    indexStatus: null,
    worktreeStatus: null,
    isUntracked: false,
    isUnmerged: false,
    isSubmodule: false,
    sources: ['unstaged'],
    rawXY: ' M',
    ...next,
  };
}

// 六种状态各一个文件 + 目录里一个改动，覆盖 WORKDIR_GIT_STATUS_VISUAL 的全部映射
// 与目录汇总（目录点不需要展开子项就应该出现）。
const FILES: FileStatus[] = [
  status('README.md', { indexStatus: 'modified', sources: ['staged', 'unstaged'], rawXY: 'MM' }),
  status('new-file.ts', { indexStatus: 'added', sources: ['staged'], rawXY: 'A ' }),
  status('gone.ts', { indexStatus: 'deleted', sources: ['staged'], rawXY: 'D ' }),
  status('renamed.ts', { oldPath: 'old-name.ts', indexStatus: 'renamed', sources: ['staged'], rawXY: 'R ' }),
  status('draft.txt', { worktreeStatus: 'untracked', isUntracked: true, rawXY: '??' }),
  status('conflict.ts', {
    indexStatus: 'unmerged',
    worktreeStatus: 'unmerged',
    isUnmerged: true,
    rawXY: 'UU',
  }),
  status('src/app.ts', { indexStatus: 'modified', sources: ['staged', 'unstaged'], rawXY: 'MM' }),
];

const REVIEW: ReviewData = {
  scope: {
    sessionId: SESSION_ID,
    workdir: WORKDIR,
    worktreePath: WORKDIR,
    workingDir: WORKDIR,
    repoRoot: WORKDIR,
    branch: 'main',
    headOid: null,
    isDetached: false,
    isUnborn: false,
    source: 'workingDir',
    aheadBehind: { ahead: 0, behind: 0, upstream: null },
    disabledReason: null,
    disabledMessage: null,
  },
  status: {
    scope: {
      sessionId: SESSION_ID,
      workdir: WORKDIR,
      worktreePath: WORKDIR,
      workingDir: WORKDIR,
      repoRoot: WORKDIR,
      branch: 'main',
      headOid: null,
      isDetached: false,
      isUnborn: false,
      source: 'workingDir',
      aheadBehind: { ahead: 0, behind: 0, upstream: null },
      disabledReason: null,
      disabledMessage: null,
    },
    files: FILES,
    stagedCount: 4,
    unstagedCount: 2,
    untrackedCount: 1,
    unmergedCount: 1,
    inProgress: [],
    writeDisabledReasons: [],
    dirty: true,
  },
  diffs: { staged: [], unstaged: [] },
  summary: {
    sessionId: SESSION_ID,
    disabledReason: null,
    disabledMessage: null,
    totalFiles: FILES.length,
    stagedFiles: 4,
    unstagedFiles: 2,
    untrackedFiles: 1,
    unmergedFiles: 1,
    dirty: true,
  },
};

function Tree() {
  const tree = useFileTree({ workdir: WORKDIR });
  const git = useWorkdirGitChanges(SESSION_ID, WORKDIR);
  return (
    <div className="flex h-screen flex-col bg-sidebar p-1">
      <FileTreeView
        tree={tree}
        scrollScope="fixture"
        selectedPath={null}
        onSelectFile={() => undefined}
        onCopyFilePath={() => undefined}
        gitFiles={git.files}
        gitDirectories={git.directories}
      />
    </div>
  );
}

mountPage({
  // 只读 host：文件列表与 git 状态都是夹具，任何写操作都不该发生。
  host: () => ({
    fileBrowser: {
      listDir: async ({ relPath }: { relPath?: string }) => LISTINGS[relPath ?? ''] ?? [],
      listAllFiles: async () => ({ files: [], truncated: false, elapsedMs: 0 }),
      startWatch: async () => ({ ok: true }),
      stopWatch: async () => ({ ok: true }),
      onEvent: subscription('fileBrowser.onEvent'),
    },
    gitReview: {
      get: async () => REVIEW,
      summary: async () => REVIEW.summary,
    },
  }),
  render: () => <Tree />,
});
