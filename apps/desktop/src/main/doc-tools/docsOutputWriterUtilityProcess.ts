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
    readonly code: 'FILE_EXISTS' | 'PATH_NOT_ALLOWED' | 'ATOMIC_PUBLISH_UNSUPPORTED' | 'INTERNAL',
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

async function publishExclusive(staging: string, target: string): Promise<void> {
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
      throw new OutputWriteError(
        'ATOMIC_PUBLISH_UNSUPPORTED',
        '当前输出位置不支持安全的原子防覆盖发布，目标文件未创建',
      );
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
  // Some Windows, exFAT, and network filesystems reject rename-over-existing.
  // Moving the old target aside before publishing creates an interruptible
  // window where a killed utility process makes the user's file disappear.
  // Fail closed instead: the synced staging file is cleaned by the caller and
  // the original target remains at its stable name.
  throw new OutputWriteError(
    'ATOMIC_PUBLISH_UNSUPPORTED',
    '当前输出位置不支持安全的原子覆盖，原文件未移动',
  );
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
      await publishExclusive(staging, target);
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
