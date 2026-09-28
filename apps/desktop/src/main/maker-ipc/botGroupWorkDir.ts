/**
 * Where 分工 steps run and which files a step produced
 * (docs/product-rules/bot-group-chat.md §7.4–7.5).
 *
 * - No 项目文件夹: the group's own folder under the owner's userData, created on the
 *   first 开始 and moved to the system trash when the group is deleted.
 * - A git project: one worktree per plan, from the same preparation as other Cindy
 *   worktree tasks (`.cindy-worktrees/<name>`, branch `cindy/<name>`).
 * - Any other folder: used directly.
 */

import { lstat, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { BOT_GROUP_STEP_FILES_MAX } from '../../shared/botGroupChat.js';

export type PreparedWorkDir =
  | { ok: true; workDir: string; branch: string | null; ownerSessionId: string | null }
  | { ok: false; message: string };

export interface BotGroupWorkDirDeps {
  ownerRoot: () => string;
  /** Whether an existing directory is inside a git repository. */
  detectRepo: (dir: string) => Promise<{ gitInstalled: boolean; isGitRepo: boolean }>;
  /** Creates the plan's worktree and returns the Session id it is registered for. */
  prepareWorktree: (projectDir: string) => Promise<
    { ok: true; sessionId: string; workingDir: string; branch: string } | { ok: false; message: string }
  >;
  git: (args: readonly string[], cwd: string) => Promise<string>;
  trashItem: (fullPath: string) => Promise<void>;
  isDirectory?: (dir: string) => Promise<boolean>;
  /** Whether `dir` or an ancestor holds a `.git` entry (independent of the git binary). */
  hasGitMarker?: (dir: string) => Promise<boolean>;
}

async function hasGitAncestor(dir: string): Promise<boolean> {
  let current = path.resolve(dir);
  for (;;) {
    try {
      await lstat(path.join(current, '.git'));
      return true;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function isExistingDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export function botGroupFolderPath(ownerRoot: string, groupId: string): string {
  return path.join(ownerRoot, 'bot-groups', groupId, 'files');
}

/** Signature per relative path (POSIX separators): mtime + size; git trees also keep HEAD. */
export type WorkDirSnapshot = Map<string, string>;

/** Snapshot key for a git tree's HEAD commit; never a real path (NUL is not allowed in one). */
const HEAD_KEY = '\0HEAD';

const SNAPSHOT_MAX_FILES = 5_000;
const SNAPSHOT_MAX_DEPTH = 8;
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.cindy-worktrees', '.xdt-worktrees']);

function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

async function signature(fullPath: string): Promise<string | null> {
  try {
    const info = await lstat(fullPath);
    return info.isFile() ? `${info.mtimeMs}:${info.size}` : null;
  } catch {
    return null;
  }
}

/** Parse `git status --porcelain=v1 -z` into paths (rename targets included). */
export function parsePorcelainPaths(output: string): string[] {
  const parts = output.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index] ?? '';
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (status.includes('D')) continue;
    paths.push(file);
    // Renames and copies are followed by their source path.
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return paths;
}

export function createBotGroupWorkDir(deps: BotGroupWorkDirDeps) {
  const isDirectory = deps.isDirectory ?? isExistingDirectory;
  const hasGitMarker = deps.hasGitMarker ?? hasGitAncestor;

  const prepare = async (input: { groupId: string; projectDir: string | null }): Promise<PreparedWorkDir> => {
    if (!input.projectDir) {
      const folder = botGroupFolderPath(deps.ownerRoot(), input.groupId);
      try {
        await mkdir(folder, { recursive: true });
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      return { ok: true, workDir: folder, branch: null, ownerSessionId: null };
    }
    if (!(await isDirectory(input.projectDir))) return { ok: false, message: '项目文件夹不存在' };
    // A git project must never be edited in place; when its state is unknown, fail closed.
    let repo: { gitInstalled: boolean; isGitRepo: boolean };
    try {
      repo = await deps.detectRepo(input.projectDir);
    } catch {
      return { ok: false, message: '无法确认项目文件夹是否是 git 仓库' };
    }
    if (repo.gitInstalled && repo.isGitRepo) {
      const prepared = await deps.prepareWorktree(input.projectDir);
      return prepared.ok
        ? { ok: true, workDir: prepared.workingDir, branch: prepared.branch, ownerSessionId: prepared.sessionId }
        : prepared;
    }
    if (await hasGitMarker(input.projectDir)) {
      return { ok: false, message: '项目文件夹在 git 仓库里，但无法创建 worktree' };
    }
    return { ok: true, workDir: input.projectDir, branch: null, ownerSessionId: null };
  };

  const isGitWorkTree = async (dir: string): Promise<boolean> => {
    try {
      return (await deps.git(['rev-parse', '--is-inside-work-tree'], dir)).trim() === 'true';
    } catch {
      return false;
    }
  };

  const walk = async (root: string): Promise<WorkDirSnapshot> => {
    const snapshot: WorkDirSnapshot = new Map();
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > SNAPSHOT_MAX_DEPTH || snapshot.size >= SNAPSHOT_MAX_FILES) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (snapshot.size >= SNAPSHOT_MAX_FILES) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRS.has(entry.name)) await visit(full, depth + 1);
        } else if (entry.isFile()) {
          const sig = await signature(full);
          if (sig) snapshot.set(toPosix(path.relative(root, full)), sig);
        }
      }
    };
    await visit(root, 0);
    return snapshot;
  };

  /**
   * Git trees list only changed and untracked files (earlier steps' uncommitted work
   * included, so the signature comparison is what isolates this step); other folders
   * are walked with a bounded budget.
   */
  const snapshot = async (workDir: string): Promise<WorkDirSnapshot> => {
    if (await isGitWorkTree(workDir)) {
      try {
        const output = await deps.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], workDir);
        const snap: WorkDirSnapshot = new Map();
        for (const file of parsePorcelainPaths(output).slice(0, SNAPSHOT_MAX_FILES)) {
          const sig = await signature(path.join(workDir, file));
          if (sig) snap.set(file, sig);
        }
        const head = (await deps.git(['rev-parse', 'HEAD'], workDir).catch(() => '')).trim();
        if (head) snap.set(HEAD_KEY, head);
        return snap;
      } catch {
        return walk(workDir);
      }
    }
    return walk(workDir);
  };

  /**
   * Files created or modified since `before`, newest first, at most BOT_GROUP_STEP_FILES_MAX.
   * A step may commit its work on the plan branch, so files in new commits count too.
   */
  const changedFiles = async (workDir: string, before: WorkDirSnapshot): Promise<string[]> => {
    const after = await snapshot(workDir);
    const changed = new Map<string, number>();
    for (const [file, sig] of after) {
      if (file !== HEAD_KEY && before.get(file) !== sig) changed.set(file, Number(sig.split(':')[0]) || 0);
    }
    const fromHead = before.get(HEAD_KEY);
    const toHead = after.get(HEAD_KEY);
    if (fromHead && toHead && fromHead !== toHead) {
      const committed = await deps
        .git(['diff', '--name-only', '-z', '--diff-filter=AMR', fromHead, toHead], workDir)
        .catch(() => '');
      for (const file of committed.split('\0').filter(Boolean).slice(0, SNAPSHOT_MAX_FILES)) {
        if (changed.has(file)) continue;
        const sig = await signature(path.join(workDir, file));
        if (sig) changed.set(file, Number(sig.split(':')[0]) || 0);
      }
    }
    return [...changed.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, BOT_GROUP_STEP_FILES_MAX)
      .map(([file]) => file);
  };

  const trashGroupFolder = async (groupId: string): Promise<void> => {
    const groupRoot = path.dirname(botGroupFolderPath(deps.ownerRoot(), groupId));
    if (await isDirectory(groupRoot)) await deps.trashItem(groupRoot);
  };

  return { prepare, snapshot, changedFiles, trashGroupFolder };
}

export type BotGroupWorkDir = ReturnType<typeof createBotGroupWorkDir>;
