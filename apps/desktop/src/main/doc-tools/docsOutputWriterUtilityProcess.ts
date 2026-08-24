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

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function verifyParent(request: DocsOutputWriteRequest, workingDir: string): Promise<void> {
  const stat = await fs.promises.lstat(workingDir, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== request.expectedParent.dev ||
    stat.ino !== request.expectedParent.ino ||
    !samePath(await fs.promises.realpath(workingDir), request.expectedParent.realPath)
  ) {
    throw new OutputWriteError('PATH_NOT_ALLOWED', '输出目录身份在最终落盘前发生变化');
  }
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
  const backup = `.cindy-docs-backup-${randomUUID()}-${request.targetName}`;
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

export async function runDocsOutputWrite(
  request: DocsOutputWriteRequest,
  workingDir?: string,
): Promise<void> {
  if (
    !request ||
    !request.expectedParent ||
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
  // Production deliberately uses `.`: the utility process cwd is the OS-held
  // directory capability. Tests may pass an explicit directory without
  // changing the test runner's process-global cwd.
  const anchoredWorkingDir = workingDir ?? '.';
  await verifyParent(request, anchoredWorkingDir);
  const outputPath = (name: string): string =>
    workingDir === undefined ? name : path.join(workingDir, name);
  const target = outputPath(request.targetName);

  if (!request.overwrite) {
    await writeExclusive(target, request.data);
    await verifyParent(request, anchoredWorkingDir);
    return;
  }

  const stagingName = `.cindy-docs-staging-${randomUUID()}-${request.targetName}`;
  const staging = outputPath(stagingName);
  try {
    await writeExclusive(staging, request.data);
    await replaceFile(request, anchoredWorkingDir, staging, target);
    await verifyParent(request, anchoredWorkingDir);
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
