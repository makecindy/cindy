/** Local, read-only BASE → working-copy comparison for the Review panel. */
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { DOMParser } from '@xmldom/xmldom';
import {
  buildCappedDiffData,
  CAPPED_DIFF_CHANGED_BYTES_THRESHOLD,
  CAPPED_DIFF_CHANGED_LINES_THRESHOLD,
  createDiffSummaryEntry,
  maxPatchLineBytes,
  singleFileTooLargeReason,
  SINGLE_FILE_CHANGED_BYTES_THRESHOLD,
  summarizeDiffEntries,
} from './cappedDiff.js';
import { parseGitDiff } from './diffParser.js';
import { isSafeGitPath } from './gitPath.js';
import type {
  FileDiff,
  FileStatus,
  ReviewData,
  ReviewDiffReadOptions,
  ReviewScope,
  ReviewStatus,
} from './types.js';

const exec = promisify(execFile);

// On Windows a bare executable name can resolve against the working copy.
async function svnExecutable() {
  if (process.platform !== 'win32') return 'svn';
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    const dir = entry.replace(/^"|"$/g, '');
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'svn.exe');
    if (
      await stat(candidate).then(
        (s) => s.isFile(),
        () => false,
      )
    )
      return candidate;
  }
  throw Object.assign(new Error('svn.exe not found on PATH'), { code: 'ENOENT' });
}

async function svn(cwd: string, args: string[], maxBuffer: number) {
  return (
    await exec(await svnExecutable(), ['--non-interactive', ...args], {
      cwd,
      timeout: 30_000,
      maxBuffer,
      windowsHide: true,
      env: {
        ...process.env,
        LC_ALL: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8',
        LANGUAGE: 'C',
      },
    })
  ).stdout;
}

// Avoid spawning an optional CLI on every refresh of an ordinary directory.
// Stay in the selected subtree even when its working copy root is higher up.
export async function findSvnReviewScope(scope: ReviewScope): Promise<ReviewScope> {
  if (scope.source === 'remote' || !['non-git', 'git-unavailable'].includes(scope.disabledReason ?? ''))
    return scope;
  // Git telemetry can point at a different checkout. For SVN the task's
  // registered directory is the sole authority, including shared-task reads.
  const cwd = scope.workingDir;
  if (!cwd || !path.isAbsolute(cwd)) return scope;
  const physicalDir = await realpath(cwd).catch(() => null);
  if (!physicalDir) return scope;
  for (let dir = physicalDir; ; dir = path.dirname(dir)) {
    if (
      await stat(path.join(dir, '.svn', 'wc.db')).then(
        (s) => s.isFile(),
        () => false,
      )
    )
      break;
    if (dir === path.dirname(dir)) return scope;
  }
  try {
    await svn(cwd, ['info', '--xml', '--depth', 'empty', '.'], 64 * 1024);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ...scope,
        disabledReason: 'svn-unavailable',
        disabledMessage: 'Install the Subversion command-line client to review this working copy.',
      };
    }
    if (/W155010|E155007/.test(String(err))) return scope;
    throw err;
  }
  return {
    ...scope,
    vcs: 'svn',
    workdir: cwd,
    repoRoot: cwd,
    source: 'workingDir',
    disabledReason: null,
    disabledMessage: null,
  };
}

function diffStatus(file: FileStatus) {
  if (file.rawXY === ' A') return 'added';
  if (file.rawXY === ' D') return 'deleted';
  return 'modified';
}

function portablePath(value: string) {
  return process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
}

export async function readSvnStatus(scope: ReviewScope): Promise<ReviewStatus> {
  const xml = await svn(
    scope.repoRoot!,
    ['diff', '--summarize', '--xml', '.'],
    CAPPED_DIFF_CHANGED_BYTES_THRESHOLD,
  );
  const nodes = new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('path');
  const files: FileStatus[] = [];
  for (const node of Array.from(nodes)) {
    const name = portablePath(node.textContent ?? '');
    if (node.getAttribute('kind') !== 'file' || !isSafeGitPath(name)) continue;
    const item = node.getAttribute('item') ?? 'modified';
    files.push({
      path: name,
      oldPath: null,
      sources: ['unstaged'],
      indexStatus: null,
      worktreeStatus: item === 'deleted' ? 'deleted' : 'modified',
      isUntracked: false,
      isUnmerged: false,
      isSubmodule: false,
      rawXY: item === 'added' ? ' A' : item === 'deleted' ? ' D' : ' M',
    });
  }
  return {
    scope,
    files,
    stagedCount: 0,
    unstagedCount: files.length,
    untrackedCount: 0,
    unmergedCount: 0,
    inProgress: [],
    writeDisabledReasons: ['svn'],
    dirty: files.length > 0,
  };
}

function parseSvnPatch(file: FileStatus, patch: string, kind: FileDiff['kind'] = 'text'): FileDiff {
  const size = Buffer.byteLength(patch);
  const lines = patch.split('\n');
  if (
    singleFileTooLargeReason({
      changedLines: lines.length - 1,
      changedBytes: size,
      maxLineBytes: maxPatchLineBytes(patch),
    })
  ) {
    kind = 'too-large';
  } else if (/^Cannot display: file marked as a binary type\./m.test(patch) || patch.includes('\0')) {
    kind = 'binary';
  }
  // Property hunks use ## instead of @@. Keep the property name beside each
  // hunk and exclude SVN's separators from the preceding file-content hunk.
  let property = '';
  const body: string[] = [];
  if (kind === 'text') {
    for (const line of lines) {
      if (line.startsWith('Property changes on:')) property = '';
      else if (/^(Added|Deleted|Modified): /.test(line)) property = line;
      else if (line.startsWith('## ')) body.push(line.replace(/^## (.*) ##$/, '@@ $1 @@') + ' ' + property);
      else if (/^(@@ |[ +\\-])/.test(line)) body.push(line);
    }
  }
  const diff = parseGitDiff(body.join('\n'), {
    source: 'unstaged',
    pathHint: file.path,
    unifiedOnly: true,
    kind,
    size,
  });
  return { ...diff, rawPatch: kind === 'text' ? patch : '', status: diffStatus(file) };
}

function diffArgs(options: ReviewDiffReadOptions) {
  return [
    'diff',
    '--internal-diff',
    '--show-copies-as-adds',
    ...(options.ignoreWhitespace ? ['-x', '-w'] : []),
  ];
}

function exceedsBuffer(err: unknown) {
  return (err as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

export async function readSvnFileDiff(scope: ReviewScope, file: FileStatus, options: ReviewDiffReadOptions) {
  try {
    const patch = await svn(
      scope.repoRoot!,
      [...diffArgs(options), '--depth', 'empty', '--old=.', '--', './' + file.path],
      SINGLE_FILE_CHANGED_BYTES_THRESHOLD,
    );
    return parseSvnPatch(file, patch.replace(/\r\n/g, '\n'));
  } catch (err) {
    if (exceedsBuffer(err)) return parseSvnPatch(file, '', 'too-large');
    throw err;
  }
}

export async function readSvnDiffs(
  scope: ReviewScope,
  status: ReviewStatus,
  options: ReviewDiffReadOptions = {},
): Promise<ReviewData['diffs']> {
  const entries = status.files.map((file) =>
    createDiffSummaryEntry({ source: 'unstaged', path: file.path, oldPath: null, status: diffStatus(file) }),
  );
  const capped = buildCappedDiffData(entries);
  if (capped || entries.length === 0)
    return { staged: [], unstaged: [], capped: { staged: null, unstaged: capped } };
  let raw: string;
  let limit: 'changed-lines' | 'changed-bytes' | null = null;
  try {
    raw = await svn(scope.repoRoot!, [...diffArgs(options), '.'], CAPPED_DIFF_CHANGED_BYTES_THRESHOLD);
    let lines = 0;
    for (let i = raw.indexOf('\n'); i !== -1; i = raw.indexOf('\n', i + 1)) {
      if (++lines > CAPPED_DIFF_CHANGED_LINES_THRESHOLD) {
        limit = 'changed-lines';
        break;
      }
    }
  } catch (err) {
    if (!exceedsBuffer(err)) throw err;
    raw = '';
    limit = 'changed-bytes';
  }
  if (limit) {
    return {
      staged: [],
      unstaged: [],
      capped: {
        staged: null,
        unstaged: { reason: limit, stats: summarizeDiffEntries(entries), files: entries },
      },
    };
  }
  const patches = new Map<string, string>();
  for (const patch of raw.replace(/\r\n/g, '\n').split(/(?=^Index: )/m)) {
    const header = /^Index: (.*)\n/.exec(patch);
    if (header) patches.set(portablePath(header[1]), patch);
  }
  return {
    staged: [],
    unstaged: status.files.map((file) => parseSvnPatch(file, patches.get(file.path) ?? '')),
  };
}
