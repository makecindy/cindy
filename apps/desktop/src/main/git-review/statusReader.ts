/**
 * git status --porcelain=v2 parser and reader.
 *
 * Keeps index and worktree states separate so one path can appear in both the
 * staged and unstaged sources.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { runGit } from './gitRunner.js';
import type {
  FileStatus,
  GitIndexStatus,
  GitInProgressState,
  GitOperationKind,
  GitWorktreeStatus,
  ReviewScope,
  ReviewStatus,
} from './types.js';

const STATUS_MAX_STDOUT_BYTES = 128 * 1024 * 1024;

function indexStatusFromCode(code: string): GitIndexStatus {
  switch (code) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    case 'U':
      return 'unmerged';
    default:
      return null;
  }
}

function worktreeStatusFromCode(code: string): GitWorktreeStatus {
  switch (code) {
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'T':
      return 'typechange';
    case 'U':
      return 'unmerged';
    default:
      return null;
  }
}

function splitFixedFields(record: string, fieldCount: number): { fields: string[]; rest: string } | null {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < fieldCount; i += 1) {
    const idx = record.indexOf(' ', start);
    if (idx < 0) return null;
    fields.push(record.slice(start, idx));
    start = idx + 1;
  }
  return { fields, rest: record.slice(start) };
}

function isSubmoduleField(sub: string): boolean {
  return sub.length > 0 && sub[0] === 'S';
}

function makeSources(indexStatus: GitIndexStatus, worktreeStatus: GitWorktreeStatus, isUntracked: boolean): Array<'staged' | 'unstaged'> {
  const sources: Array<'staged' | 'unstaged'> = [];
  if (indexStatus) sources.push('staged');
  if (worktreeStatus || isUntracked) sources.push('unstaged');
  return sources;
}

export function parsePorcelainV2Status(stdout: string, baseScope: ReviewScope): ReviewStatus {
  const records = stdout.split('\0');
  const files: FileStatus[] = [];
  const scope = { ...baseScope, aheadBehind: { ...baseScope.aheadBehind } };
  let i = 0;
  while (i < records.length) {
    const record = records[i];
    i += 1;
    if (!record) continue;

    if (record.startsWith('# ')) {
      const line = record.slice(2);
      if (line.startsWith('branch.oid ')) {
        const oid = line.slice('branch.oid '.length).trim();
        scope.headOid = oid === '(initial)' ? null : oid;
        scope.isUnborn = oid === '(initial)';
      } else if (line.startsWith('branch.head ')) {
        const head = line.slice('branch.head '.length).trim();
        scope.isDetached = head === '(detached)';
        scope.branch = scope.isDetached ? null : head;
      } else if (line.startsWith('branch.upstream ')) {
        scope.aheadBehind.upstream = line.slice('branch.upstream '.length).trim() || null;
      } else if (line.startsWith('branch.ab ')) {
        const m = /\+(\d+)\s+-(\d+)/.exec(line.slice('branch.ab '.length));
        if (m) {
          scope.aheadBehind.ahead = Number(m[1]);
          scope.aheadBehind.behind = Number(m[2]);
          scope.aheadBehind.stale = true;
        }
      }
      continue;
    }

    const tag = record[0];
    if (tag === '1') {
      const parsed = splitFixedFields(record, 8);
      if (!parsed) continue;
      const [, xy, sub] = parsed.fields;
      const indexStatus = indexStatusFromCode(xy[0] ?? '.');
      const worktreeStatus = worktreeStatusFromCode(xy[1] ?? '.');
      files.push({
        path: parsed.rest,
        oldPath: null,
        indexStatus,
        worktreeStatus,
        isUntracked: false,
        isUnmerged: indexStatus === 'unmerged' || worktreeStatus === 'unmerged',
        isSubmodule: isSubmoduleField(sub),
        sources: makeSources(indexStatus, worktreeStatus, false),
        rawXY: xy,
      });
      continue;
    }

    if (tag === '2') {
      const parsed = splitFixedFields(record, 9);
      if (!parsed) continue;
      const [, xy, sub] = parsed.fields;
      const newPath = parsed.rest;
      const oldPath = records[i] || null;
      i += 1;
      const indexStatus = indexStatusFromCode(xy[0] ?? '.');
      const worktreeStatus = worktreeStatusFromCode(xy[1] ?? '.');
      files.push({
        path: newPath,
        oldPath,
        indexStatus,
        worktreeStatus,
        isUntracked: false,
        isUnmerged: indexStatus === 'unmerged' || worktreeStatus === 'unmerged',
        isSubmodule: isSubmoduleField(sub),
        sources: makeSources(indexStatus, worktreeStatus, false),
        rawXY: xy,
      });
      continue;
    }

    if (tag === '?') {
      const filePath = record.slice(2);
      if (!filePath || filePath.endsWith('/')) continue;
      files.push({
        path: filePath,
        oldPath: null,
        indexStatus: null,
        worktreeStatus: 'untracked',
        isUntracked: true,
        isUnmerged: false,
        isSubmodule: false,
        sources: ['unstaged'],
        rawXY: '??',
      });
      continue;
    }

    if (tag === 'u') {
      const parsed = splitFixedFields(record, 10);
      if (!parsed) continue;
      // u 记录同样携带 XY 与 sub 字段(porcelain=2:u <XY> <sub> <m1..mW>
      // <h1..h3> <path>)。sub 不能丢:顶层 gitlink 的合并冲突(如 UU 的
      // submodule)必须保留 submodule 身份,否则不会被路由进 submodule
      // reader,gitlink 目录会被普通文件指纹器拒绝、合法冲突无法启动
      // Review(Codex review #2515)。
      const [, xy, sub] = parsed.fields;
      files.push({
        path: parsed.rest,
        oldPath: null,
        indexStatus: 'unmerged',
        worktreeStatus: 'unmerged',
        isUntracked: false,
        isUnmerged: true,
        isSubmodule: isSubmoduleField(sub),
        sources: ['staged', 'unstaged'],
        rawXY: xy,
      });
    }
  }

  const stagedCount = files.filter((f) => f.sources.includes('staged')).length;
  const unstagedCount = files.filter((f) => f.sources.includes('unstaged')).length;
  const untrackedCount = files.filter((f) => f.isUntracked).length;
  const unmergedCount = files.filter((f) => f.isUnmerged).length;
  const writeDisabledReasons: string[] = [];
  if (scope.isDetached) writeDisabledReasons.push('detached');
  if (scope.isUnborn) writeDisabledReasons.push('unborn');
  if (unmergedCount > 0) writeDisabledReasons.push('unmerged');
  if (scope.source === 'remote') writeDisabledReasons.push('remote-ssh');

  return {
    scope,
    files,
    stagedCount,
    unstagedCount,
    untrackedCount,
    unmergedCount,
    inProgress: [],
    writeDisabledReasons,
    dirty: stagedCount + unstagedCount > 0,
  };
}

const OPERATION_MARKERS: Array<{ name: string; kind: GitOperationKind }> = [
  { name: 'MERGE_HEAD', kind: 'merge' },
  { name: 'REBASE_HEAD', kind: 'rebase' },
  { name: 'rebase-merge', kind: 'rebase' },
  { name: 'rebase-apply', kind: 'rebase' },
  { name: 'CHERRY_PICK_HEAD', kind: 'cherry-pick' },
  { name: 'SQUASH_MSG', kind: 'squash' },
];

async function readGitPath(repoRoot: string, marker: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(['rev-parse', '--git-path', marker], { cwd: repoRoot });
    const p = stdout.trim();
    if (!p) return null;
    return path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readInProgressState(repoRoot: string): Promise<GitInProgressState[]> {
  const result: GitInProgressState[] = [];
  for (const marker of OPERATION_MARKERS) {
    const gitPath = await readGitPath(repoRoot, marker.name);
    if (!gitPath) continue;
    if (await exists(gitPath)) {
      result.push({ kind: marker.kind, marker: marker.name, path: gitPath });
    }
  }
  return result;
}

export async function readStatus(scope: ReviewScope): Promise<ReviewStatus> {
  if (!scope.repoRoot) {
    return {
      scope,
      files: [],
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      unmergedCount: 0,
      inProgress: [],
      writeDisabledReasons: ['disabled'],
      dirty: false,
    };
  }
  // --ignore-submodules=none:仓库配置 submodule.<name>.ignore=all/dirty 会让
  // status 直接省略脏的 submodule,dirty 内容根本进不了 Review 发现链 ——
  // 新鲜度身份绑定必须无视该配置(与 reviewSubmoduleIdentity 的子仓 status
  // 同一裁决,Codex review #2515)。
  const { stdout } = await runGit(['status', '--porcelain=2', '-z', '--branch', '--renames', '--untracked-files=all', '--ignore-submodules=none'], {
    cwd: scope.repoRoot,
    maxStdoutBytes: STATUS_MAX_STDOUT_BYTES,
  });
  const status = parsePorcelainV2Status(stdout, scope);
  // SSH review is read-only regardless of merge/rebase markers. Never probe a
  // controlled-side path with the controller's local fs APIs.
  status.inProgress = scope.source === 'remote' ? [] : await readInProgressState(scope.repoRoot);
  if (status.inProgress.length > 0) status.writeDisabledReasons.push('in-progress');
  return status;
}
