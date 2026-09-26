import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  DocsOutputStagedNotice,
  DocsOutputWriteRequest,
  DocsOutputWriteResult,
  DocsOutputWrittenIdentity,
} from './docsOutputWriterProtocol.js';

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

/**
 * Create the staging file exclusively and hand back the still-open handle before any
 * byte is written: it is the only capability bound to the inode itself, used to announce
 * the identity to the parent (so a timeout kill can still be cleaned up), to report the
 * published identity, and to zero the content if publication must be withdrawn.
 */
async function openExclusive(target: string): Promise<fs.promises.FileHandle> {
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);
  try {
    return await fs.promises.open(target, flags, 0o600);
  } catch (error) {
    if (hasCode(error, 'EEXIST')) {
      throw new OutputWriteError('FILE_EXISTS', `目标文件已存在: ${target}`);
    }
    throw error;
  }
}

const DIR_SYNC_UNSUPPORTED = new Set(['EPERM', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF', 'EACCES']);

/**
 * Make directory-entry changes (link / unlink) durable by fsyncing the directory itself.
 * Platforms that cannot fsync a directory handle (Windows) are skipped; a real I/O error
 * propagates so success is never reported for a publish that may not survive a crash.
 */
async function syncDirectory(dirPath: string): Promise<void> {
  let dir: fs.promises.FileHandle;
  try {
    dir = await fs.promises.open(dirPath, 'r');
  } catch (error) {
    if (DIR_SYNC_UNSUPPORTED.has((error as NodeJS.ErrnoException)?.code ?? '')) return;
    throw error;
  }
  try {
    await dir.sync();
  } catch (error) {
    if (!DIR_SYNC_UNSUPPORTED.has((error as NodeJS.ErrnoException)?.code ?? '')) throw error;
  } finally {
    await dir.close().catch(() => undefined);
  }
}

/**
 * Remove a name only if it still carries our inode; 'foreign' = something else sits (or sat)
 * there. POSIX has no unlink-by-inode, so the lstat→unlink gap is closed *after* the fact
 * through the retained handle: our inode's link count must have dropped by exactly one. If
 * it did not, the name had been swapped in between (the unlink hit someone else's entry and
 * our link still exists elsewhere) — reported as 'foreign' so the caller withdraws and zeroes.
 */
async function removeOwnName(
  name: string,
  handle: fs.promises.FileHandle,
): Promise<'removed' | 'absent' | 'foreign' | 'error'> {
  try {
    const own = await handle.stat({ bigint: true });
    let current: fs.BigIntStats;
    try {
      current = await fs.promises.lstat(name, { bigint: true });
    } catch (error) {
      return hasCode(error, 'ENOENT') ? 'absent' : 'error';
    }
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== own.dev || current.ino !== own.ino) {
      return 'foreign';
    }
    await fs.promises.unlink(name);
    const after = await handle.stat({ bigint: true });
    if (after.nlink !== own.nlink - 1n) return 'foreign';
    return 'removed';
  } catch {
    return 'error';
  }
}

/**
 * Remove `target` only if it still names the inode behind `handle`. Returns whether the
 * name is now known not to carry our inode (removed, absent, or pointing elsewhere);
 * false means an I/O error left that unknown.
 */
async function unlinkIfOurs(target: string, handle: fs.promises.FileHandle): Promise<boolean> {
  try {
    const own = await handle.stat({ bigint: true });
    let current: fs.BigIntStats;
    try {
      current = await fs.promises.lstat(target, { bigint: true });
    } catch (error) {
      return hasCode(error, 'ENOENT');
    }
    if (current.isFile() && !current.isSymbolicLink() && current.dev === own.dev && current.ino === own.ino) {
      try {
        await fs.promises.unlink(target);
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error; // gone meanwhile (our other cleanup path)
        return true;
      }
      // Same post-unlink link-count check as removeOwnName: a swap in the gap means our
      // link is still out there, so the name is not known to be clear.
      const after = await handle.stat({ bigint: true });
      if (after.nlink !== own.nlink - 1n) return false;
    }
    return true;
  } catch {
    return false;
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

/**
 * The write currently in flight, kept so a cooperative abort from the parent can run the
 * same fail-closed cleanup this process would run itself. Names are cwd-relative in
 * production (cwd is bound to the verified parent inode), so the cleanup keeps working
 * even if that directory has since been renamed or moved out of the session root —
 * something the parent, holding only a lexical path, cannot do.
 */
let inFlight: {
  handle: fs.promises.FileHandle;
  staging: string;
  target: string;
  published: () => boolean;
  committedOverwrite: () => boolean;
  /** Settles when an in-progress overwrite rename has a known outcome (either way). */
  commitPending: () => Promise<void> | null;
  /**
   * Fail-closed cleanup of this write (zero the inode, drop our names), memoized so the
   * writer's own failure path and a cooperative abort share one run instead of racing each
   * other over the same handle and names.
   */
  cleanup: () => Promise<boolean>;
} | null = null;
let abortRequested = false;
/** Settles (either way) once the staging open in progress has finished; null when none. */
let stagingOpenPending: Promise<void> | null = null;

/** Cooperative abort: zero the private inode and drop our names, through capabilities bound to it. */
export async function abortInFlightWrite(): Promise<{ cleaned: boolean }> {
  abortRequested = true;
  // A staging open may be in progress: its outcome decides whether there is an inode to
  // clean. Wait for it to settle instead of answering "nothing to clean" while a private
  // staging file is about to appear. After the open, the writer checks abortRequested
  // before writing any byte, so the file it created stays empty and is removed here.
  if (stagingOpenPending) await stagingOpenPending;
  const current = inFlight;
  if (!current) return { cleaned: false };
  // An overwrite rename may be in flight: its outcome decides whether this inode is now the
  // user's only copy. Never zero it while that outcome is unknown — wait for the rename to
  // settle (success or failure) and then re-read the commit flag.
  const pending = current.commitPending();
  if (pending) await pending;
  if (current.committedOverwrite()) return { cleaned: false }; // the replacement is the user's file
  // Only a confirmed erasure + name removal counts; any I/O failure reports false so the
  // parent runs its own reclaim instead of trusting a partial cleanup. The run is shared
  // with the writer's own fail-closed path (it observes abortRequested at its next checkpoint).
  return { cleaned: await current.cleanup() };
}

/** Test hook: clear abort state between runs. */
export function resetAbortStateForTest(): void {
  abortRequested = false;
  inFlight = null;
  stagingOpenPending = null;
}

async function writeWithinVerifiedParent(
  request: DocsOutputWriteRequest,
  workingDir: string,
  outputPath: (name: string) => string,
  onStaged?: (notice: DocsOutputStagedNotice) => void,
): Promise<DocsOutputWrittenIdentity> {
  const target = outputPath(request.targetName);
  const stagingName = `.cindy-docs-staging-${randomUUID()}-${request.targetName}`;
  // The staging inode lives at the *session root*, not in the output directory: content
  // inside the workdir cannot relocate the root, so the root-anchored staging name stays
  // reachable to the parent (timeout / crash reclaim) even when the output directory has
  // been moved out — the published target shares the inode, so zeroing it there suffices.
  // Exception (round 29): a hard link / rename cannot cross filesystems. When the verified
  // output directory is a nested mount (its device differs from the root's), the staging
  // inode is placed inside that directory instead, and the parent is told so; the reclaim
  // capability then degrades to the target's own filesystem (documented limitation).
  const parentDevice = (await fs.promises.lstat(workingDir, { bigint: true })).dev;
  const stagingIn = chooseStagingLocation(request.expectedRoot.dev, parentDevice);
  const staging = stagingIn === 'root' ? path.join(request.expectedRoot.realPath, stagingName) : outputPath(stagingName);
  let handle: fs.promises.FileHandle | undefined;
  let published = false;
  let inFlightCleanup: (() => Promise<boolean>) | null = null;
  // overwrite: once the rename over the old target has happened, the old inode is gone
  // for good; the replacement is the user's only copy and must never be withdrawn.
  let committedOverwrite = false;
  const assertNotAborted = (): void => {
    if (abortRequested) throw new OutputWriteError('INTERNAL', '文档落盘已被父进程中止');
  };
  try {
    let openSettled: () => void = () => {};
    stagingOpenPending = new Promise<void>((resolve) => { openSettled = resolve; });
    try {
      handle = await openExclusive(staging);
    } finally {
      // inFlight is published below in the same synchronous segment as this resolve, so an
      // abort awaiting the open observes the handle.
      queueMicrotask(openSettled);
      stagingOpenPending = null;
    }
    let commitPending: Promise<void> | null = null;
    const ownHandle = handle;
    let cleanupRun: Promise<boolean> | null = null;
    const cleanup = (): Promise<boolean> => {
      cleanupRun ??= (async () => {
        let cleaned = true;
        try {
          await ownHandle.truncate(0);
        } catch {
          cleaned = false;
        }
        if (published) cleaned = (await unlinkIfOurs(target, ownHandle)) && cleaned;
        cleaned = (await unlinkIfOurs(staging, ownHandle)) && cleaned;
        return cleaned;
      })();
      return cleanupRun;
    };
    inFlight = {
      handle,
      staging,
      target,
      published: () => published,
      committedOverwrite: () => committedOverwrite,
      commitPending: () => commitPending,
      cleanup,
    };
    inFlightCleanup = cleanup;
    // Announce the inode *before* the first private byte is written: if writeFile/sync
    // hang past the parent's watchdog and this process is killed, the parent can still
    // reclaim exactly this inode.
    const staged = await handle.stat({ bigint: true });
    onStaged?.({ type: 'staged', identity: { dev: staged.dev, ino: staged.ino }, stagingName, stagingIn });
    // An abort that landed while the exclusive open was pending: no private byte may be
    // written; the empty staging inode is cleaned in the catch / finally below.
    assertNotAborted();
    await handle.writeFile(request.data);
    await handle.sync();
    assertNotAborted();
    await verifyParent(request, workingDir);
    if (request.overwrite) {
      // Re-check *synchronously* right before the commit is started: an abort that ran
      // during the verifyParent await above has already zeroed the staging inode and set
      // abortRequested; starting the rename now would publish a zero-byte replacement over
      // the user's file. From here on, an abort sees commitPending and waits for it instead.
      assertNotAborted();
      // The commit flag is set inside the same continuation the abort path awaits, so the
      // abort can never observe "not committed" while the rename has actually succeeded.
      commitPending = replaceFile(request, workingDir, staging, target).then(
        () => { committedOverwrite = true; },
        (error: unknown) => { throw error; },
      );
      try {
        await commitPending;
      } finally {
        commitPending = null;
      }
    } else {
      await publishExclusive(staging, target);
    }
    published = true;
    assertNotAborted();
    await verifyParent(request, workingDir);
    const st = await handle.stat({ bigint: true });
    // Durability of the directory entries (link + staging removal): the file bytes were
    // fsynced in writeExclusive, but the names only survive a crash once the parent
    // directory is synced. Do it before success is reported and the caller books refs.
    if (!request.overwrite) {
      // Remove the staging name only if it still carries our inode. If a workdir process
      // renamed the link away and put an unrelated file there, withdraw the publish: the
      // moved link is an untracked private copy (zeroed through the handle in the catch).
      const removed = await removeOwnName(staging, handle);
      if (removed === 'foreign') {
        throw new OutputWriteError('PATH_NOT_ALLOWED', 'staging 名在发布后被替换或移走，已撤回本次输出');
      }
      if (removed === 'error') throw new Error('无法移除 staging 名');
      // Removed by us or already absent (bare rename by a workdir process): either way the
      // inode must now be reachable through the target only; an extra link is an untracked
      // private copy and the publish is withdrawn (the catch zeroes it through the handle).
      const links = await handle.stat({ bigint: true });
      if (links.nlink !== 1n) {
        throw new OutputWriteError('PATH_NOT_ALLOWED', 'staging 名在发布后被移走，已撤回本次输出');
      }
    }
    await syncDirectory(workingDir);
    return { dev: st.dev, ino: st.ino };
  } catch (error) {
    // `inFlight` stays registered until the finally below: a cooperative abort arriving
    // while this fail-closed cleanup is still running must join the same (memoized) run
    // through the retained handle instead of reporting "nothing to clean".
    if (committedOverwrite) {
      // The rename already replaced the user's file; destroying the replacement now would
      // lose both versions. Report the failure and keep the published replacement.
      throw error;
    }
    // Fail closed: no private content may remain, least of all outside the session
    // root. Zero it through the inode-bound handle (follows the file wherever its
    // directory went) and withdraw the published name only if it is still ours.
    if (inFlightCleanup) await inFlightCleanup();
    else await handle?.truncate(0).catch(() => undefined);
    throw error;
  } finally {
    inFlight = null;
    // Drop our staging name only while it still carries our inode; anything else at that
    // path belongs to someone else and is left untouched.
    if (handle) await removeOwnName(staging, handle).catch(() => undefined);
    await handle?.close().catch(() => undefined);
  }
}

/** Root-anchored staging whenever the output directory shares the root's filesystem. */
export function chooseStagingLocation(rootDev: bigint, parentDev: bigint): 'root' | 'parent' {
  return rootDev === parentDev ? 'root' : 'parent';
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
  onStaged?: (notice: DocsOutputStagedNotice) => void,
): Promise<DocsOutputWrittenIdentity> {
  assertValidRequest(request);
  const workingDir = path.join(rootDir, request.parentRelativePath);
  await ensureParent(request, workingDir);
  return writeWithinVerifiedParent(request, workingDir, (name) => path.join(workingDir, name), onStaged);
}

export async function runDocsOutputWrite(
  request: DocsOutputWriteRequest,
  onStaged?: (notice: DocsOutputStagedNotice) => void,
): Promise<DocsOutputWrittenIdentity> {
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
    return await writeWithinVerifiedParent(request, '.', (name) => name, onStaged);
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
    if (message?.type === 'abort') {
      // Parent watchdog: clean up through our inode-bound handle and cwd-relative names,
      // then confirm; the parent only falls back to path-based reclaim if we stay silent.
      void abortInFlightWrite().then(
        (r) => parentPort.postMessage({ type: 'aborted', cleaned: r.cleaned }),
        () => parentPort.postMessage({ type: 'aborted', cleaned: false }),
      );
      return;
    }
    if (handled || message?.type !== 'write' || !message.request) return;
    handled = true;
    void runDocsOutputWrite(message.request, (notice) => parentPort.postMessage(notice))
      .then<DocsOutputWriteResult, DocsOutputWriteResult>(
        (identity) => ({ ok: true, identity }),
        (error) => ({
          ok: false,
          errorCode: error instanceof OutputWriteError ? error.code : 'INTERNAL',
          message: (error instanceof Error ? error.message : String(error)).slice(0, 8_000),
        }),
      )
      .then((result) => parentPort.postMessage(result));
  });
}
