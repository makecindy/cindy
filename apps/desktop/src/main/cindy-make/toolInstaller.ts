import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { download, type DownloadOptions } from '../downloader/index.js';
import { createLogger } from '../logger.js';
import type { MakeDoctorCheck } from '../../shared/cindyMakeDoctor.js';
import type { MakeToolArtifact } from './toolCatalog.js';
import { extractMakeToolArchive } from './toolArchive.js';

const log = createLogger('cindy-make');
export type InstallProgress = Pick<MakeDoctorCheck, 'status' | 'progress'>;
export const makeToolRoot = (userData: string) => path.join(userData, 'cindy-make');
const key = (artifact: MakeToolArtifact) =>
  `${artifact.id}-${artifact.version}-${artifact.host}-${artifact.sha256.slice(0, 12)}`;
const recordPath = (root: string, artifact: MakeToolArtifact) =>
  path.join(root, 'tools', key(artifact), 'current.json');

/** A record references only a complete immutable generation, never an in-progress extraction. */
export async function installedMakeTool(
  root: string,
  artifact: MakeToolArtifact,
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
export async function installMakeTool(
  input: {
    root: string;
    artifact: MakeToolArtifact;
    signal: AbortSignal;
    onProgress: (progress: InstallProgress) => void;
    validate: (executable: string) => Promise<boolean>;
  },
  deps: {
    download?: (options: DownloadOptions) => Promise<unknown>;
    extract?: typeof extractMakeToolArchive;
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
  let lastProgressAt = 0;
  try {
    onProgress({ status: 'downloading' });
    // Each attempt has its own writable archive. The downloader retries/resumes in this
    // attempt without sharing mutable .part files with another Cindy process.
    await (deps.download ?? download)({
      url: artifact.url,
      sha256: artifact.sha256,
      targetPath: path.join(staging, 'archive'),
      signal,
      logger: log,
      onProgress: ({ loaded, total, percent }) => {
        const now = Date.now();
        // A fast connection must not produce thousands of chat-store updates per second.
        if (signal.aborted || (now - lastProgressAt < 150 && loaded !== total)) return;
        lastProgressAt = now;
        onProgress({
          status: 'downloading',
          progress: {
            loaded,
            total,
            percent: percent === null ? null : Math.max(0, Math.min(100, percent)),
          },
        });
      },
      retry: { maxAttempts: 4 },
    });
    signal.throwIfAborted();
    onProgress({ status: 'installing' });
    await mkdir(payload);
    await (deps.extract ?? extractMakeToolArchive)(
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
    await rename(recordTemp, recordPath(root, artifact));
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
