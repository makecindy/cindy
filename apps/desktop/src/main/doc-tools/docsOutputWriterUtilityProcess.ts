import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { DocsOutputWriteRequest, DocsOutputWriteResult } from './docsOutputWriterProtocol.js';

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

class OutputWriteError extends Error {
  constructor(
    readonly code: 'FILE_EXISTS' | 'PATH_NOT_ALLOWED' | 'INTERNAL',
    message: string,
  ) {
    super(message);
  }
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
const hasCode = (error: unknown, code: string): boolean =>
  Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code);
const HARD_LINK_UNSUPPORTED_CODES = new Set([
  'EACCES',
  'EMLINK',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV',
]);

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export function sameRelativePath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const normalize = (value: string) => pathApi.normalize(value);
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function relativePathSegments(
  relative: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return pathApi.normalize(relative).split(pathApi.sep).filter(Boolean);
}

async function verifyParent(request: DocsOutputWriteRequest, workingDir: string): Promise<void> {
  try {
    const rootStat = await fs.promises.lstat(request.expectedRoot.realPath, { bigint: true });
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      rootStat.dev !== request.expectedRoot.dev ||
      rootStat.ino !== request.expectedRoot.ino
    ) {
      throw new OutputWriteError('PATH_NOT_ALLOWED', '任务工作目录身份在最终落盘前发生变化');
    }
    const stat = await fs.promises.lstat(workingDir, { bigint: true });
    const realParent = await fs.promises.realpath(workingDir);
    const relative = path.relative(request.expectedRoot.realPath, realParent);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (request.expectedParent !== null &&
        (stat.dev !== request.expectedParent.dev ||
          stat.ino !== request.expectedParent.ino ||
          !samePath(realParent, request.expectedParent.realPath))) ||
      !sameRelativePath(relative, request.parentRelativePath) ||
      relative.startsWith('..') ||
      path.isAbsolute(relative)
    ) {
      throw new OutputWriteError(
        'PATH_NOT_ALLOWED',
        '输出目录与任务工作目录的从属关系在最终落盘前发生变化',
      );
    }
  } catch (error) {
    if (error instanceof OutputWriteError) throw error;
    throw new OutputWriteError('PATH_NOT_ALLOWED', '任务工作目录或输出目录在最终落盘前不可用');
  }
}

/**
 * Create an output parent one path component at a time while the utility
 * process is anchored at the session root.  The main process deliberately
 * never calls recursive mkdir on a user-controlled path: all directory
 * creation and identity checks happen in this root-bound process.
 */
async function ensureParent(request: DocsOutputWriteRequest, workingDir: string): Promise<void> {
  const relative = request.parentRelativePath;
  if (relative === '' || relative === '.') {
    await verifyParent(request, workingDir);
    return;
  }
  // Normalize separators with the current platform before walking each
  // component. Windows accepts both slash forms, while POSIX keeps a
  // backslash as a literal filename character.
  const segments = relativePathSegments(relative);
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.includes('\0'))) {
    throw new OutputWriteError('PATH_NOT_ALLOWED', '输出目录相对路径不合法');
  }
  let current = request.expectedRoot.realPath;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.promises.lstat(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new OutputWriteError('PATH_NOT_ALLOWED', '输出目录包含符号链接或非目录成员');
      }
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      await fs.promises.mkdir(current);
      const created = await fs.promises.lstat(current, { bigint: true });
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new OutputWriteError('PATH_NOT_ALLOWED', '输出目录创建后不是普通目录');
      }
    }
  }
  await verifyParent(request, workingDir);
}

async function writeExclusive(target: string, data: Uint8Array): Promise<void> {
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(target, flags, 0o600);
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    if (hasCode(error, 'EEXIST')) {
      throw new OutputWriteError('FILE_EXISTS', `目标文件已存在: ${target}`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function removeIncompleteExclusiveTarget(
  target: string,
  identity: Pick<fs.BigIntStats, 'dev' | 'ino'>,
): Promise<void> {
  try {
    const current = await fs.promises.lstat(target, { bigint: true });
    if (
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.dev === identity.dev &&
      current.ino === identity.ino
    ) {
      await fs.promises.rm(target, { force: true });
    }
  } catch {
    // The path was already removed or replaced; never delete an unknown entry.
  }
}

async function publishExclusiveWithoutHardLinks(target: string, data: Uint8Array): Promise<void> {
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);
  let handle: fs.promises.FileHandle | undefined;
  let identity: Pick<fs.BigIntStats, 'dev' | 'ino'> | undefined;
  let contentComplete = false;
  let failed = false;
  let failure: unknown;
  try {
    handle = await fs.promises.open(target, flags, 0o600);
    const opened = await handle.stat({ bigint: true });
    identity = { dev: opened.dev, ino: opened.ino };
    await handle.writeFile(data);
    contentComplete = true;
    await handle.sync();
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      await handle?.close();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }

  if (failed) {
    if (hasCode(failure, 'EEXIST')) {
      throw new OutputWriteError('FILE_EXISTS', `目标文件已存在: ${target}`);
    }
    // Hard-link-free filesystems cannot provide "visible only when complete".
    // O_EXCL still preserves no-clobber; on a short/failed write, remove only
    // the regular file inode created by this attempt. A fully written file is
    // retained if fsync/close fails so a complete artifact is never erased.
    if (!contentComplete && identity) {
      await removeIncompleteExclusiveTarget(target, identity);
    }
    throw failure;
  }
}

async function publishExclusive(staging: string, target: string, data: Uint8Array): Promise<void> {
  try {
    // A same-directory hard link publishes the fully synced staging inode in
    // one step and never replaces an existing destination. If the utility is
    // terminated while writing, only the hidden staging name can be partial.
    await fs.promises.link(staging, target);
  } catch (error) {
    if (hasCode(error, 'EEXIST')) {
      throw new OutputWriteError('FILE_EXISTS', `目标文件已存在: ${target}`);
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code && HARD_LINK_UNSUPPORTED_CODES.has(code)) {
      await publishExclusiveWithoutHardLinks(target, data);
      return;
    }
    throw error;
  }
}

async function assertReplaceableTarget(target: string): Promise<void> {
  try {
    const stat = await fs.promises.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new OutputWriteError('PATH_NOT_ALLOWED', `覆盖目标不是普通文件: ${target}`);
    }
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw error;
  }
}

async function replaceFile(
  request: DocsOutputWriteRequest,
  workingDir: string,
  staging: string,
  target: string,
): Promise<void> {
  await verifyParent(request, workingDir);
  await assertReplaceableTarget(target);
  try {
    await fs.promises.rename(staging, target);
    return;
  } catch (error) {
    if (!hasCode(error, 'EEXIST') && !hasCode(error, 'EPERM')) throw error;
  }

  // Windows exFAT / network shares may reject rename-over-existing. Keep the
  // previous file recoverable until the new file has been committed.
  const backup = path.join(workingDir, `.cindy-docs-backup-${randomUUID()}-${request.targetName}`);
  let movedExisting = false;
  try {
    await assertReplaceableTarget(target);
    try {
      await fs.promises.rename(target, backup);
      movedExisting = true;
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    await verifyParent(request, workingDir);
    await fs.promises.rename(staging, target);
    if (movedExisting) {
      movedExisting = false;
      await fs.promises.rm(backup, { force: true }).catch(() => undefined);
    }
  } catch (error) {
    if (movedExisting) {
      try {
        await verifyParent(request, workingDir);
        await fs.promises.rename(backup, target);
        movedExisting = false;
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `替换目标失败，旧文件保留在可恢复备份: ${backup}`,
        );
      }
    }
    throw error;
  }
}

async function writeWithinVerifiedParent(
  request: DocsOutputWriteRequest,
  workingDir: string,
  outputPath: (name: string) => string,
): Promise<void> {
  const target = outputPath(request.targetName);
  const staging = outputPath(`.cindy-docs-staging-${randomUUID()}-${request.targetName}`);
  try {
    await writeExclusive(staging, request.data);
    await verifyParent(request, workingDir);
    if (request.overwrite) {
      await replaceFile(request, workingDir, staging, target);
    } else {
      await publishExclusive(staging, target, request.data);
    }
    await verifyParent(request, workingDir);
  } finally {
    try {
      const stat = await fs.promises.lstat(staging);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        await fs.promises.rm(staging, { force: true });
      }
    } catch {
      // Unknown/replaced staging paths are deliberately left untouched.
    }
  }
}

function assertValidRequest(request: DocsOutputWriteRequest): void {
  if (
    !request ||
    typeof request.targetName !== 'string' ||
    request.targetName !== path.basename(request.targetName) ||
    request.targetName === '.' ||
    request.targetName === '..' ||
    request.targetName.includes('\0') ||
    !(request.data instanceof Uint8Array) ||
    typeof request.overwrite !== 'boolean'
  ) {
    throw new OutputWriteError('INTERNAL', '文档落盘请求不合法');
  }
}

/** Direct-unit-test entry: Vitest runs in worker threads where chdir is unavailable. */
export async function runDocsOutputWriteForTest(
  request: DocsOutputWriteRequest,
  rootDir: string,
): Promise<void> {
  assertValidRequest(request);
  const workingDir = path.join(rootDir, request.parentRelativePath);
  await ensureParent(request, workingDir);
  await writeWithinVerifiedParent(request, workingDir, (name) => path.join(workingDir, name));
}

export async function runDocsOutputWrite(request: DocsOutputWriteRequest): Promise<void> {
  assertValidRequest(request);
  // Production starts with `.` bound to the session root. Resolve and verify
  // the parent from that capability, then chdir into the verified directory so
  // final file operations no longer re-resolve its mutable lexical path.
  const anchoredWorkingDir = path.join('.', request.parentRelativePath);
  await ensureParent(request, anchoredWorkingDir);
  const previousCwd = process.cwd();
  try {
    // chdir binds subsequent relative path operations to the directory inode
    // selected above. If the lexical parent is rebound before chdir, the
    // immediate identity check rejects it before any bytes are written; if it
    // is rebound afterwards, open/rename continue through the verified inode
    // instead of following the replacement symlink.
    process.chdir(anchoredWorkingDir);
    await verifyParent(request, '.');
    await writeWithinVerifiedParent(request, '.', (name) => name);
  } finally {
    try {
      process.chdir(previousCwd);
    } catch {
      // The production utility handles one request and never reuses cwd. A
      // vanished caller cwd must not turn a safely completed write into an
      // unrelated failure.
    }
  }
}

if (parentPort) {
  let handled = false;
  parentPort.postMessage({ type: 'ready' });
  parentPort.on('message', (event) => {
    const message = event.data as { type?: unknown; request?: DocsOutputWriteRequest };
    if (handled || message?.type !== 'write' || !message.request) return;
    handled = true;
    void runDocsOutputWrite(message.request)
      .then<DocsOutputWriteResult, DocsOutputWriteResult>(
        () => ({ ok: true }),
        (error) => ({
          ok: false,
          errorCode: error instanceof OutputWriteError ? error.code : 'INTERNAL',
          message: (error instanceof Error ? error.message : String(error)).slice(0, 8_000),
        }),
      )
      .then((result) => parentPort.postMessage(result));
  });
}
