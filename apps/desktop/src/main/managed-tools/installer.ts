import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createDownloadProgressReporter,
  download,
  type DownloadOptions,
} from '../downloader/index.js';
import { createLogger } from '../logger.js';
import { replaceFile } from '../utils/replaceFile.js';
import type { ToolArtifact, ToolInstallProgress } from './types.js';
import { extractToolArchive, safeArchivePath, MAX_ARCHIVE_BYTES } from './archive.js';

const log = createLogger('managed-tools');
const key = (artifact: ToolArtifact) => {
  for (const part of [artifact.id, artifact.version, artifact.host]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part)) throw new Error('Invalid tool identity');
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('Invalid tool digest');
  safeArchivePath(artifact.executable);
  return `${artifact.id}-${artifact.version}-${artifact.host}-${artifact.sha256.slice(0, 12)}`;
};
const recordPath = (root: string, artifact: ToolArtifact) =>
  path.join(root, 'tools', key(artifact), 'current.json');

/** A record references only a complete immutable generation, never an in-progress extraction. */
export async function installedTool(
  root: string,
  artifact: ToolArtifact,
): Promise<string | undefined> {
  try {
    const record = JSON.parse(await readFile(recordPath(root, artifact), 'utf8'));
    if (
      record.sha256 !== artifact.sha256 ||
      typeof record.generation !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(record.generation)
    )
      return;
    const executable = path.join(
      root,
      'tools',
      key(artifact),
      record.generation,
      ...artifact.executable.split('/'),
    );
    if ((await stat(executable)).isFile()) return executable;
  } catch {
    /* Missing/corrupt records are not installed tools. */
  }
}

/** Installs to Cindy's private directory; never invokes a system installer or writes global config.
 * Generations stay immutable so a failed repair cannot break an existing consumer. A concurrent
 * instance may promote another valid generation; either result has the same pinned contents.
 */
export async function installTool(
  input: {
    root: string;
    artifact: ToolArtifact;
    signal: AbortSignal;
    onProgress: (progress: ToolInstallProgress) => void;
    validate: (executable: string) => Promise<boolean>;
  },
  deps: {
    download?: (options: DownloadOptions) => Promise<unknown>;
    extract?: typeof extractToolArchive;
  } = {},
): Promise<string> {
  const { root, artifact, signal, onProgress } = input;
  signal.throwIfAborted();
  const parent = path.join(root, 'tools', key(artifact));
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, '.staging-'));
  const payload = path.join(staging, 'payload');
  const generation = randomUUID();
  const target = path.join(parent, generation);
  const recordTemp = path.join(parent, `${generation}.json.tmp`);
  let promoted = false;
  // Throttled: a fast connection must not produce thousands of chat-store updates per second.
  const reporter = createDownloadProgressReporter({
    initialPhase: 'downloading',
    throttleMs: 150,
    emit: (progress) => {
      if (signal.aborted) return;
      onProgress({
        status: progress.phase === 'installing' ? 'installing' : 'downloading',
        ...(progress.loaded > 0
          ? {
              progress: {
                loaded: progress.loaded,
                total: progress.total,
                percent: progress.percent,
              },
            }
          : {}),
        download: progress,
      });
    },
  });
  try {
    onProgress({ status: 'downloading', download: reporter.snapshot() });
    // Each attempt has its own writable archive. The downloader retries/resumes in this
    // attempt without sharing mutable .part files with another Cindy process.
    await (deps.download ?? download)({
      url: artifact.url,
      sha256: artifact.sha256,
      maxBytes: MAX_ARCHIVE_BYTES,
      targetPath: path.join(staging, 'archive'),
      signal,
      logger: log,
      ...reporter.callbacks,
      retry: { maxAttempts: 4 },
    });
    signal.throwIfAborted();
    reporter.setPhase('installing');
    await mkdir(payload);
    await (deps.extract ?? extractToolArchive)(
      path.join(staging, 'archive'),
      payload,
      artifact,
      signal,
    );
    const executable = path.join(payload, ...artifact.executable.split('/'));
    if (!(await stat(executable)).isFile()) throw new Error('Tool executable missing');
    await chmod(executable, 0o755);
    if (!(await input.validate(executable)))
      throw new Error('Installed tool did not pass its version check');
    signal.throwIfAborted();
    await rename(payload, target);
    await writeFile(recordTemp, JSON.stringify({ generation, sha256: artifact.sha256 }), {
      flag: 'wx',
    });
    signal.throwIfAborted();
    await replaceFile(recordTemp, recordPath(root, artifact));
    promoted = true;
    return path.join(target, ...artifact.executable.split('/'));
  } finally {
    // Only paths created by this attempt are removed; previous generations are untouched.
    for (const file of [staging, recordTemp, ...(!promoted ? [target] : [])]) {
      try {
        await rm(file, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // Antivirus/file locks may briefly keep a temp file open on Windows. An unused
        // staging folder is never a valid install and must not mask the real outcome.
        log.warn('Tool staging cleanup deferred', { tool: artifact.id });
      }
    }
  }
}
