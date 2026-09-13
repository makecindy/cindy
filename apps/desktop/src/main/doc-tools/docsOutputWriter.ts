import { promises as fs } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line no-restricted-imports -- final writes need a one-shot cwd-bound process, not a database worker.
import { utilityProcess } from 'electron';

import { DocsPathError, type WriteDocsOutputFn, type WriteDocsOutputOutcome } from '@cindy/mcps';

import {
  relativeOutputParentPath,
  type DocsOutputStagedNotice,
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

function parseStagedNotice(value: unknown): DocsOutputStagedNotice | null {
  if (!value || typeof value !== 'object') return null;
  const notice = value as Partial<DocsOutputStagedNotice>;
  if (
    notice.type !== 'staged' ||
    typeof notice.stagingName !== 'string' ||
    notice.stagingName !== path.basename(notice.stagingName) ||
    (notice.stagingIn !== 'root' && notice.stagingIn !== 'parent') ||
    !notice.identity ||
    typeof notice.identity.dev !== 'bigint' ||
    typeof notice.identity.ino !== 'bigint'
  ) {
    return null;
  }
  return notice as DocsOutputStagedNotice;
}

/**
 * Timeout recovery: the writer was killed and could not run its own fail-closed path, but
 * it already told us which inode holds the private bytes. Zero that inode through an
 * O_NOFOLLOW handle under each of its names. The names themselves are left alone: this
 * parent only holds lexical paths, and unlinking by path after a check can delete an
 * unrelated entry placed there in between (no unlink-by-inode exists). A zero-byte name is
 * the conservative residue; the child's own cwd-bound cleanup is what removes names.
 */
async function reclaimStagedInode(candidates: string[], identity: { dev: bigint; ino: bigint }): Promise<void> {
  for (const candidate of candidates) {
    try {
      const handle = await fs.open(candidate, fs.constants.O_RDWR | ((fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0));
      try {
        const st = await handle.stat({ bigint: true });
        if (!st.isFile() || st.dev !== identity.dev || st.ino !== identity.ino) continue;
        await handle.truncate(0);
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch {
      // Missing, replaced or not ours: nothing of ours to reclaim under this name.
    }
  }
}

function parseResult(value: unknown): DocsOutputWriteResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = value as Partial<DocsOutputWriteResult>;
  if (result.ok === true) {
    const identity = (result as { identity?: unknown }).identity;
    return identity &&
      typeof identity === 'object' &&
      typeof (identity as { dev?: unknown }).dev === 'bigint' &&
      typeof (identity as { ino?: unknown }).ino === 'bigint'
      ? { ok: true, identity: identity as { dev: bigint; ino: bigint } }
      : { ok: true };
  }
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

/** Writer watchdog; tests shrink it. */
export const DOCS_OUTPUT_WRITER_TIMEOUT = { ms: 60_000 };
/** How long the watchdog waits for the child's own cwd-bound cleanup before killing it. */
export const DOCS_OUTPUT_WRITER_ABORT_GRACE = { ms: 2_000 };

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

  return await new Promise<WriteDocsOutputOutcome>((resolve, reject) => {
    let settled = false;
    let ready = false;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 8_000) stderr += String(chunk).slice(0, 8_000 - stderr.length);
    });
    let outcome: WriteDocsOutputOutcome = {};
    let staged: DocsOutputStagedNotice | null = null;
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
      else resolve(outcome);
    };
    // Any termination that skips the child's own fail-closed path (watchdog kill, crash,
    // external kill, spawn error) goes through here: if the child already reported the
    // staged inode, reclaim it before surfacing the error, so no private bytes survive
    // without an anchor or lifecycle.
    let aborting = false;
    let childConfirmedCleanup: ((cleaned: boolean) => void) | null = null;
    const reclaimByPath = (): Promise<void> => {
      const notice = staged;
      if (!notice) return Promise.resolve();
      // The staging name is anchored at the session root (which workdir content cannot
      // relocate), so it stays reachable even after the output directory was moved out;
      // zeroing the inode there also empties the published target, which shares it. For a
      // cross-device output directory the writer had to stage inside that directory (a link
      // cannot cross mounts): the reclaim then goes through the lexical output path.
      // overwrite: after the rename the announced inode *is* the user's replaced file, so
      // only the staging name may be reclaimed; the target name is never touched.
      const stagingDir = notice.stagingIn === 'root' ? realRoot : path.join(realRoot, parentRelativePath);
      const candidates = [path.join(stagingDir, notice.stagingName)];
      if (!request.overwrite) candidates.push(path.join(realRoot, parentRelativePath, request.targetName));
      return reclaimStagedInode(candidates, notice.identity);
    };
    const abort = (error: Error): void => {
      if (settled || aborting) return;
      aborting = true;
      try {
        child.kill();
      } catch {
        // already gone
      }
      void reclaimByPath().finally(() => finish(error));
    };
    // Watchdog: the child may merely be waiting on a slow filesystem call while its event
    // loop is free. Ask it to clean up first — its cwd is bound to the verified parent
    // inode and it holds the staging handle, so its cleanup survives a rename/move-out of
    // that directory, which the parent's lexical path cannot follow. Only if the child stays
    // silent past the grace is it killed and the parent falls back to path-based reclaim.
    const cooperativeAbort = (error: Error): void => {
      if (settled || aborting) return;
      aborting = true;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const done = new Promise<boolean>((resolveGrace) => {
        childConfirmedCleanup = (cleaned) => { clearTimeout(graceTimer); resolveGrace(cleaned); };
        graceTimer = setTimeout(() => resolveGrace(false), DOCS_OUTPUT_WRITER_ABORT_GRACE.ms);
        graceTimer.unref?.();
      });
      try {
        child.postMessage({ type: 'abort' });
      } catch {
        childConfirmedCleanup?.(false);
      }
      void done.then(async (cleaned) => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        if (!cleaned) await reclaimByPath();
      }).finally(() => finish(error));
    };
    const timer = setTimeout(() => cooperativeAbort(new Error('文档落盘隔离进程超时')), DOCS_OUTPUT_WRITER_TIMEOUT.ms);
    timer.unref?.();

    child.on('message', (message) => {
      if (
        !ready &&
        message &&
        typeof message === 'object' &&
        (message as { type?: unknown }).type === 'ready'
      ) {
        ready = true;
        // Single terminal arbitration: once an abort has started (watchdog fired before
        // the child was even ready), a late `ready` must not hand the private bytes over —
        // the abort chain owns the outcome from here on.
        if (aborting) return;
        // Last async boundary before the side effect: the caller may re-check live
        // authorization here. A rejection means the child never receives the bytes.
        void (input.beforeCommit ? input.beforeCommit() : Promise.resolve()).then(
          () => {
            if (!settled && !aborting) child.postMessage({ type: 'write', request });
          },
          (error: unknown) => { if (!aborting) finish(error); },
        );
        return;
      }
      const notice = parseStagedNotice(message);
      if (notice) {
        staged = notice;
        return;
      }
      if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'aborted') {
        childConfirmedCleanup?.((message as { cleaned?: unknown }).cleaned === true);
        return;
      }
      const result = parseResult(message);
      if (!result) return;
      // Once an abort has started, the abort chain owns the terminal state: a result that
      // races in during the grace window (e.g. {ok:true} right before the child is killed
      // and its inode reclaimed) must not be surfaced as success to the caller.
      if (aborting) return;
      if (result.ok) {
        // Identity is read by the writer through its own handle; carried as decimal
        // strings (64-bit file ids do not survive as JS numbers).
        if (result.identity) outcome = { identity: { dev: result.identity.dev.toString(), ino: result.identity.ino.toString() } };
        finish();
      }
      else {
        try {
          throwResultError(result, input.path);
        } catch (error) {
          finish(error);
        }
      }
    });
    child.on('error', (error) => abort(error instanceof Error ? error : new Error(String(error))));
    child.on('exit', (code) => {
      if (!settled) {
        abort(new Error(stderr.trim() || `文档落盘隔离进程异常退出(${String(code)})`));
      }
    });
  });
};
