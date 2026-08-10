/**
 * SSH execution backend for the workspace review panel.
 *
 * The renderer continues to send only a session id and structured review
 * requests. Main resolves the authoritative host/workdir from the session row,
 * then runs a fixed, read-only Git wrapper on that host. Paths and Git args are
 * base64-encoded positional data, never interpolated as shell syntax.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Stats } from 'node:fs';
import path from 'node:path';

import type { ExecOpts, ExecResult } from '@cindy/maker-remote-ssh';

import { getRemoteFileBrowser } from '../file-browser/remote-deps.js';
import { ensureRemoteHostReady, getRemoteSshPool } from '../remote-ssh/index.js';
import {
  GitRunError,
  type GitExecutionBackend,
  type GitRunBufferOptions,
  type GitRunBufferResult,
  type GitRunOptions,
  type GitRunResult,
  withGitExecutionBackend,
} from './gitRunner.js';
import { repoRelativeFsPath } from './fsPathGuard.js';
import { ImagePreviewDataUrlCache, type ImagePreviewReaderDeps } from './imageReader.js';
import type { MarkdownPreviewReaderDeps } from './markdownReader.js';
import {
  type ReviewFileExecutionBackend,
  withReviewFileExecutionBackend,
} from './reviewFileRunner.js';
import {
  defaultScopeResolverDeps,
  type SessionReviewRow,
  withSessionReviewRowSnapshot,
} from './scopeResolver.js';
import type { ReviewScope } from './types.js';

const DEFAULT_REMOTE_STDOUT_BYTES = 64 * 1024 * 1024;
const REMOTE_PREVIEW_CHUNK_BYTES = 1024 * 1024;
const REMOTE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

const READ_ONLY_GIT_COMMANDS = new Set([
  'cat-file',
  'check-attr',
  'check-ref-format',
  'config',
  'diff',
  'diff-tree',
  'for-each-ref',
  'log',
  'ls-files',
  'merge-base',
  'rev-list',
  'rev-parse',
  'status',
  'symbolic-ref',
]);

const REMOTE_GIT_SCRIPT = [
  'set -o pipefail',
  'decode() { if printf %s "$1" | base64 --decode 2>/dev/null; then return 0; fi; printf %s "$1" | base64 -D; }',
  'cwd=$(decode "$1") || exit 125',
  'shift',
  'argv=()',
  'for item in "$@"; do argv+=("$(decode "$item")") || exit 125; done',
  'cd -- "$cwd" || exit 126',
  'export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= SSH_ASKPASS= GIT_PAGER=cat GIT_EXTERNAL_DIFF= GIT_OPTIONAL_LOCKS=0 LC_ALL=C',
  'git -c core.fsmonitor=false "${argv[@]}" | base64 | tr -d "\\r\\n"',
].join('; ');

export interface SshReviewHost {
  exec(command: string, options?: ExecOpts): Promise<ExecResult>;
}

interface RemoteFileBrowser {
  request(
    hostId: string,
    method: 'stat' | 'readFileChunk',
    params: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface SshReviewBackendDeps {
  getSessionRow(sessionId: string): Promise<SessionReviewRow | null>;
  ensureHostReady(hostId: string): Promise<void>;
  getHost(hostId: string): SshReviewHost;
  getFileBrowser(): RemoteFileBrowser;
}

interface SshReviewContext {
  hostId: string;
  workdir: string;
  host: SshReviewHost;
  fileBrowser: RemoteFileBrowser;
  imageCache: ImagePreviewDataUrlCache;
}

const sshReviewContext = new AsyncLocalStorage<SshReviewContext>();

function defaultDeps(): SshReviewBackendDeps {
  return {
    getSessionRow: defaultScopeResolverDeps().getSessionRow,
    ensureHostReady: ensureRemoteHostReady,
    getHost: (hostId) => {
      const host = getRemoteSshPool().get(hostId);
      if (!host) throw new Error('SSH review host is not available');
      return host;
    },
    getFileBrowser: () => getRemoteFileBrowser() as RemoteFileBrowser,
  };
}

function encodeArg(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function shellQuoteBase64(value: string): string {
  // Base64 cannot contain a single quote, but keep the assertion close to the
  // command boundary so future encoding changes fail closed.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('invalid encoded SSH review argument');
  return `'${value}'`;
}

export function buildRemoteGitCommand(cwd: string, args: readonly string[]): string {
  const encoded = [cwd, ...args].map((value) => shellQuoteBase64(encodeArg(value)));
  return `bash -c '${REMOTE_GIT_SCRIPT}' -- ${encoded.join(' ')}`;
}

export function assertReadOnlyRemoteGitArgs(
  args: readonly string[],
  opts: GitRunOptions = {},
): void {
  const command = args[0] ?? '';
  if (!READ_ONLY_GIT_COMMANDS.has(command)) {
    throw new GitRunError({
      args,
      cwd: opts.cwd,
      exitCode: null,
      stdout: '',
      stderr: '',
      message: 'SSH workspace review only supports read-only Git operations',
    });
  }
  if (command === 'config' && args[1] !== '--get') {
    throw new GitRunError({
      args,
      cwd: opts.cwd,
      exitCode: null,
      stdout: '',
      stderr: '',
      message: 'SSH workspace review only supports read-only Git config queries',
    });
  }
  if (command === 'symbolic-ref' && args.some((arg) => arg === '--delete' || arg === '-d')) {
    throw new GitRunError({
      args,
      cwd: opts.cwd,
      exitCode: null,
      stdout: '',
      stderr: '',
      message: 'SSH workspace review only supports read-only Git operations',
    });
  }
  if (
    args.some(
      (arg) =>
        arg === '--ext-diff' ||
        arg === '--filters' ||
        arg === '--textconv' ||
        arg === '--output' ||
        arg.startsWith('--output='),
    )
  ) {
    throw new GitRunError({
      args,
      cwd: opts.cwd,
      exitCode: null,
      stdout: '',
      stderr: '',
      message: 'SSH workspace review rejected a Git option with external side effects',
    });
  }
  if (opts.extraEnv && Object.keys(opts.extraEnv).length > 0) {
    throw new GitRunError({
      args,
      cwd: opts.cwd,
      exitCode: null,
      stdout: '',
      stderr: '',
      message: 'SSH workspace review does not accept custom Git environment variables',
    });
  }
}

function hardenedRemoteGitArgs(args: readonly string[]): readonly string[] {
  if (args[0] === 'diff' || args[0] === 'diff-tree' || args[0] === 'log') {
    // Porcelain diff/log can enable repository-configured textconv or external
    // diff helpers. Force both off on the controlled side even when callers do
    // not request those flags explicitly.
    return [args[0], '--no-ext-diff', '--no-textconv', ...args.slice(1)];
  }
  return args;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function remoteWorkspacePathPrefixes(cwd: string): string[] {
  const normalized = path.posix.normalize(cwd);
  const prefixes: string[] = [];
  let candidate = normalized;
  while (candidate !== '/') {
    // Avoid redacting generic mount roots such as `/Users` or `/srv`, which
    // could hide unrelated paths in an otherwise ordinary Git diagnostic.
    if (candidate.split('/').filter(Boolean).length >= 2) prefixes.push(candidate);
    const parent = path.posix.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return prefixes;
}

function sanitizeRemoteStderr(stderr: string, cwd: string): string {
  const redacted = remoteWorkspacePathPrefixes(cwd).reduce(
    (message, prefix) =>
      message.replace(
        new RegExp(`${escapeRegExp(prefix)}(?=$|[/\\s'\"\\)\\]\\},:;])`, 'g'),
        '<workspace>',
      ),
    stderr,
  );
  return redacted.length <= 4_096 ? redacted : `${redacted.slice(0, 4_096)}…`;
}

function decodedOutput(
  result: ExecResult,
  maxStdoutBytes: number,
  args: readonly string[],
  cwd: string,
): Buffer {
  if (result.truncated) {
    throw new GitRunError({
      args,
      cwd,
      exitCode: result.exitCode,
      stdout: '',
      stderr: sanitizeRemoteStderr(result.stderr, cwd),
      message: `Remote Git output exceeded the ${maxStdoutBytes}-byte review limit`,
    });
  }
  const encoded = result.stdout.trim();
  if (encoded && !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new GitRunError({
      args,
      cwd,
      exitCode: result.exitCode,
      stdout: '',
      stderr: sanitizeRemoteStderr(result.stderr, cwd),
      message: 'Remote Git returned an invalid binary response',
    });
  }
  const stdout = Buffer.from(encoded, 'base64');
  if (stdout.length > maxStdoutBytes) {
    throw new GitRunError({
      args,
      cwd,
      exitCode: result.exitCode,
      stdout: stdout.subarray(0, maxStdoutBytes).toString('utf8'),
      stderr: sanitizeRemoteStderr(result.stderr, cwd),
      message: `Remote Git output exceeded the ${maxStdoutBytes}-byte review limit`,
    });
  }
  return stdout;
}

function createGitBackend(host: SshReviewHost): GitExecutionBackend {
  const execute = async (
    args: readonly string[],
    opts: GitRunOptions,
  ): Promise<{ stdout: Buffer; stderr: string; exitCode: number }> => {
    assertReadOnlyRemoteGitArgs(args, opts);
    const cwd = opts.cwd;
    if (!cwd || !path.posix.isAbsolute(cwd)) {
      throw new GitRunError({
        args,
        cwd,
        exitCode: null,
        stdout: '',
        stderr: '',
        message: 'SSH workspace review requires an absolute remote working directory',
      });
    }
    if (opts.signal?.aborted) {
      throw new GitRunError({
        args,
        cwd,
        exitCode: null,
        stdout: '',
        stderr: '',
        message: 'Remote Git review request was cancelled',
      });
    }
    const safeArgs = hardenedRemoteGitArgs(args);
    const maxStdoutBytes = opts.maxStdoutBytes ?? DEFAULT_REMOTE_STDOUT_BYTES;
    const encodedLimit = Math.ceil(maxStdoutBytes / 3) * 4 + 4_096;
    const result = await host.exec(buildRemoteGitCommand(cwd, safeArgs), {
      input: opts.stdin,
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxOutputBytes: encodedLimit,
      label: 'git-review-read',
    });
    if (opts.signal?.aborted) {
      throw new GitRunError({
        args,
        cwd,
        exitCode: result.exitCode,
        stdout: '',
        stderr: '',
        message: 'Remote Git review request was cancelled',
      });
    }
    const exitCode = result.exitCode ?? 128;
    const stderr = sanitizeRemoteStderr(result.stderr, cwd);
    const stdout = decodedOutput(result, maxStdoutBytes, args, cwd);
    const allowed = new Set(opts.allowedExitCodes ?? [0]);
    if (!allowed.has(exitCode)) {
      throw new GitRunError({
        args,
        cwd,
        exitCode,
        stdout: stdout.toString('utf8'),
        stderr,
        message: `Remote Git command failed with exit code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
      });
    }
    return { stdout, stderr, exitCode };
  };

  return {
    async run(args: readonly string[], opts: GitRunOptions = {}): Promise<GitRunResult> {
      const result = await execute(args, opts);
      return { ...result, stdout: result.stdout.toString('utf8') };
    },
    async runBuffer(
      args: readonly string[],
      opts: GitRunBufferOptions = {},
    ): Promise<GitRunBufferResult> {
      return execute(args, opts);
    },
  };
}

/** Run one complete review request against the session's authoritative backend. */
export async function withSessionReviewExecution<T>(
  sessionId: string,
  task: () => Promise<T>,
  deps: SshReviewBackendDeps = defaultDeps(),
): Promise<T> {
  const row = await deps.getSessionRow(sessionId);
  if (!row) return task();
  if (!row.remoteHostId || !row.workingDir) {
    return withSessionReviewRowSnapshot(row, task);
  }
  try {
    await deps.ensureHostReady(row.remoteHostId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = /\[(SSH_[A-Z_]+)\]/.exec(message)?.[1] ?? 'SSH_CONNECT_FAILED';
    throw new Error(`[${code}] SSH workspace review could not connect to the remote host`);
  }
  const context: SshReviewContext = {
    hostId: row.remoteHostId,
    workdir: row.workingDir,
    host: deps.getHost(row.remoteHostId),
    fileBrowser: deps.getFileBrowser(),
    imageCache: new ImagePreviewDataUrlCache(),
  };
  return withSessionReviewRowSnapshot(row, () =>
    sshReviewContext.run(context, () =>
      withGitExecutionBackend(createGitBackend(context.host), () =>
        withReviewFileExecutionBackend(createFileBackend(context), task)),
    ),
  );
}

function currentRemoteContext(scope: ReviewScope): SshReviewContext {
  const context = sshReviewContext.getStore();
  if (
    !context ||
    scope.source !== 'remote' ||
    scope.workingDir !== context.workdir
  )
    throw new Error('SSH review execution context is unavailable');
  return context;
}

function remoteRelativePath(repoRoot: string, filePath: string): string {
  const relative = path.posix.relative(repoRoot, filePath);
  if (!relative || relative.startsWith('..') || path.posix.isAbsolute(relative)) {
    throw new Error('Remote preview path is outside the repository');
  }
  return relative;
}

function statsLike(type: 'file' | 'directory', size: number, mtimeMs: number): Stats {
  return {
    size,
    mtimeMs,
    isFile: () => type === 'file',
    isDirectory: () => type === 'directory',
    // The remote file service follows symlinks only after enforcing realpath
    // containment, so presenting the contained target as non-symlink is safe.
    isSymbolicLink: () => false,
  } as Stats;
}

type RemoteStatResult = { type: 'file' | 'directory'; size: number; mtimeMs: number };
type RemoteChunkResult = { dataBase64: string; eof: boolean; size: number; mtimeMs: number };

function decodeRemoteChunk(result: RemoteChunkResult, maxChunkBytes: number): Buffer {
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 0) {
    throw new Error('Remote review requested an invalid file chunk length');
  }
  if (typeof result.dataBase64 !== 'string') {
    throw new Error('Remote review file service returned an invalid chunk');
  }
  // Check the encoded response before decoding so a compromised or broken
  // controlled side cannot force Main to allocate an arbitrarily large Buffer.
  const maxEncodedChars = Math.ceil(maxChunkBytes / 3) * 4;
  if (
    result.dataBase64.length > maxEncodedChars ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      result.dataBase64,
    )
  ) {
    throw new Error('Remote review file service returned an oversized or invalid chunk');
  }
  const chunk = Buffer.from(result.dataBase64, 'base64');
  if (chunk.length > maxChunkBytes) {
    throw new Error('Remote review file service returned an oversized chunk');
  }
  return chunk;
}

async function readRemoteStat(
  context: SshReviewContext,
  repoRoot: string,
  filePath: string,
): Promise<Stats> {
  const result = (await context.fileBrowser.request(context.hostId, 'stat', {
    workdir: repoRoot,
    relPath: remoteRelativePath(repoRoot, filePath),
  })) as RemoteStatResult;
  return statsLike(result.type, result.size, result.mtimeMs);
}

async function readRemoteFile(
  context: SshReviewContext,
  repoRoot: string,
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const relPath = remoteRelativePath(repoRoot, filePath);
  const chunks: Buffer[] = [];
  let offset = 0;
  while (true) {
    const requestedLength = Math.min(REMOTE_PREVIEW_CHUNK_BYTES, Math.max(0, maxBytes - offset));
    const result = (await context.fileBrowser.request(context.hostId, 'readFileChunk', {
      workdir: repoRoot,
      relPath,
      offset,
      length: requestedLength,
    })) as RemoteChunkResult;
    if (result.size > maxBytes) throw new Error('Remote review file exceeds the read limit');
    const chunk = decodeRemoteChunk(result, requestedLength);
    if (offset + chunk.length > maxBytes) {
      throw new Error('Remote review file exceeds the read limit');
    }
    chunks.push(chunk);
    offset += chunk.length;
    if (result.eof) break;
    if (chunk.length === 0 || offset >= maxBytes) {
      throw new Error('Remote review file changed while it was being read');
    }
  }
  return Buffer.concat(chunks);
}

async function readRemotePrefix(
  context: SshReviewContext,
  repoRoot: string,
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const requestedLength = Math.min(maxBytes, REMOTE_PREVIEW_CHUNK_BYTES);
  const result = (await context.fileBrowser.request(context.hostId, 'readFileChunk', {
    workdir: repoRoot,
    relPath: remoteRelativePath(repoRoot, filePath),
    offset: 0,
    length: requestedLength,
  })) as RemoteChunkResult;
  return decodeRemoteChunk(result, requestedLength);
}

function createFileBackend(context: SshReviewContext): ReviewFileExecutionBackend {
  const absolutePath = (repoRoot: string, gitPath: string) =>
    repoRelativeFsPath(repoRoot, gitPath);
  return {
    async lstat(repoRoot, gitPath) {
      const stat = await readRemoteStat(context, repoRoot, absolutePath(repoRoot, gitPath));
      return { size: stat.size, isSymlink: false };
    },
    readFile: (repoRoot, gitPath, maxBytes) =>
      readRemoteFile(context, repoRoot, absolutePath(repoRoot, gitPath), maxBytes),
    readPrefix: (repoRoot, gitPath, maxBytes) =>
      readRemotePrefix(context, repoRoot, absolutePath(repoRoot, gitPath), maxBytes),
  };
}

export type SshPreviewReaderDeps = Pick<
  ImagePreviewReaderDeps & MarkdownPreviewReaderDeps,
  'lstat' | 'realpath' | 'stat' | 'readFile'
> &
  Pick<ImagePreviewReaderDeps, 'cache'>;

/** Remote worktree reader used only for image/Markdown rich previews. */
export function createSshPreviewReaderDeps(scope: ReviewScope): SshPreviewReaderDeps {
  const context = currentRemoteContext(scope);
  const repoRoot = scope.repoRoot;
  if (!repoRoot) throw new Error('SSH review repository is unavailable');
  return {
    lstat: (filePath) => readRemoteStat(context, repoRoot, filePath),
    // The daemon's stat/read calls perform canonical realpath containment on
    // the controlled side. Identity here prevents local fs.realpath from ever
    // touching a POSIX path that belongs to the SSH host.
    realpath: async (filePath) => filePath,
    stat: (filePath) => readRemoteStat(context, repoRoot, filePath),
    readFile: (filePath) => readRemoteFile(
      context,
      repoRoot,
      filePath,
      REMOTE_PREVIEW_MAX_BYTES,
    ),
    cache: context.imageCache,
  };
}

export const __sshReviewBackendTesting = {
  createGitBackend,
  hardenedRemoteGitArgs,
  remoteRelativePath,
};
