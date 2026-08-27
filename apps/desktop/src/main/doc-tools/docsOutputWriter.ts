import { promises as fs } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line no-restricted-imports -- final writes need a one-shot cwd-bound process, not a database worker.
import { utilityProcess } from 'electron';

import { DocsPathError, type WriteDocsOutputFn } from '@cindy/mcps';

import {
  relativeOutputParentPath,
  type DocsOutputWriteRequest,
  type DocsOutputWriteResult,
} from './docsOutputWriterProtocol.js';

interface DocsOutputWriterChildLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
  kill(): boolean;
  stderr?: NodeJS.ReadableStream | null;
}

function isInside(parent: string, candidate: string): boolean {
  if (parent === candidate) return true;
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function forkDocsOutputWriter(rootDir: string): DocsOutputWriterChildLike {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
  ] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return utilityProcess.fork(path.join(__dirname, 'docsOutputWriterUtilityProcess.js'), [], {
    cwd: rootDir,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    serviceName: 'cindy-docs-output-writer',
  });
}

function parseResult(value: unknown): DocsOutputWriteResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = value as Partial<DocsOutputWriteResult>;
  if (result.ok === true) return { ok: true };
  if (
    result.ok === false &&
    (result.errorCode === 'FILE_EXISTS' ||
      result.errorCode === 'PATH_NOT_ALLOWED' ||
      result.errorCode === 'ATOMIC_PUBLISH_UNSUPPORTED' ||
      result.errorCode === 'INTERNAL') &&
    typeof result.message === 'string'
  ) {
    return result as DocsOutputWriteResult;
  }
  return null;
}

function throwResultError(
  result: Exclude<DocsOutputWriteResult, { ok: true }>,
  abs: string,
): never {
  if (result.errorCode === 'FILE_EXISTS') {
    throw new DocsPathError(
      'FILE_EXISTS',
      result.message,
      '同名文件已存在。确认要覆盖就再调一次并传 overwrite: true,否则换一个文件名。',
    );
  }
  if (result.errorCode === 'PATH_NOT_ALLOWED') {
    throw new DocsPathError(
      'PATH_NOT_ALLOWED',
      result.message,
      `输出路径 "${abs}" 在最终落盘时不再属于本任务工作目录，已停止写入。请检查目录后重试。`,
    );
  }
  if (result.errorCode === 'ATOMIC_PUBLISH_UNSUPPORTED') {
    throw new DocsPathError(
      'ATOMIC_PUBLISH_UNSUPPORTED',
      result.message,
      '请换到支持硬链接的本地工作目录；如确认允许覆盖同名文件，可显式传 overwrite:true 后重试。',
    );
  }
  throw new Error(result.message);
}

export const writeDocsOutput: WriteDocsOutputFn = async (input) => {
  const parentDir = path.dirname(input.path);
  const realRoot = await fs.realpath(input.root);
  const lexicalParent = path.resolve(parentDir);
  const parentRelativePath = relativeOutputParentPath(input.root, lexicalParent);
  if (parentRelativePath === null) {
    throw new DocsPathError(
      'PATH_NOT_ALLOWED',
      `输出目录不在任务工作目录内: ${lexicalParent}`,
      '请改用任务工作目录内的输出路径。',
    );
  }
  const rootStat = await fs.lstat(realRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new DocsPathError(
      'PATH_NOT_ALLOWED',
      `任务工作目录不是可用的真实目录: ${realRoot}`,
      '请改用任务工作目录内的输出路径。',
    );
  }
  let expectedParent: DocsOutputWriteRequest['expectedParent'] = null;
  try {
    const realParent = await fs.realpath(parentDir);
    if (!isInside(realRoot, realParent)) {
      throw new DocsPathError(
        'PATH_NOT_ALLOWED',
        `输出目录不在任务工作目录内: ${realParent}`,
        '请改用任务工作目录内的输出路径。',
      );
    }
    const parentStat = await fs.lstat(realParent, { bigint: true });
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new DocsPathError(
        'PATH_NOT_ALLOWED',
        `输出目录不是可用的真实目录: ${realParent}`,
        '请改用任务工作目录内的普通目录。',
      );
    }
    expectedParent = { realPath: realParent, dev: parentStat.dev, ino: parentStat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    // Missing parents are created by the root-anchored utility process.
  }

  const request: DocsOutputWriteRequest = {
    expectedRoot: {
      realPath: realRoot,
      dev: rootStat.dev,
      ino: rootStat.ino,
    },
    expectedParent,
    parentRelativePath,
    targetName: path.basename(input.path),
    data: new Uint8Array(input.data),
    overwrite: input.overwrite,
  };
  // Anchor the utility process at the session root, not at the output parent.
  // If a parent directory is moved out of the session after validation, the
  // same relative path from this cwd no longer resolves to that outside inode.
  const child = forkDocsOutputWriter(realRoot);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let ready = false;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 8_000) stderr += String(chunk).slice(0, 8_000 - stderr.length);
    });
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // One-shot process may already have exited after sending its result.
      }
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('文档落盘隔离进程超时')), 60_000);
    timer.unref?.();

    child.on('message', (message) => {
      if (
        !ready &&
        message &&
        typeof message === 'object' &&
        (message as { type?: unknown }).type === 'ready'
      ) {
        ready = true;
        child.postMessage({ type: 'write', request });
        return;
      }
      const result = parseResult(message);
      if (!result) return;
      if (result.ok) finish();
      else {
        try {
          throwResultError(result, input.path);
        } catch (error) {
          finish(error);
        }
      }
    });
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => {
      if (!settled) {
        finish(new Error(stderr.trim() || `文档落盘隔离进程异常退出(${String(code)})`));
      }
    });
  });
};
