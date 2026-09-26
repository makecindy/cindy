import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { llamaCppProcessCommand } from './llamaCppProcess.js';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  LLAMACPP_DEFAULT_CONTEXT,
  llamaCppModelPreset,
  LLAMACPP_MANAGED_ORIGIN,
  LLAMACPP_MANAGED_PORT,
  type LlamaCppDownloadInput,
  type LlamaCppModel,
  type LlamaCppSnapshot,
} from '../../shared/llamaCpp.js';
import {
  downloadLlamaCppAsset,
  hfDownloadUrl,
  llamaCppPlatform,
  resolveHfRepository,
  resolveLlamaCppRelease,
  selectGgufShards,
} from './llamaCppDownloads.js';
import { windowsTarBin } from './ollamaInstall.js';
import { readModelContextLimits } from '../maker-host/model-context-limit-store.js';
import { killProcessTree } from '../scheduler-host/proc-util.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import {
  startReviewOwnerLiveness,
  probeReviewOwnerLiveness,
  type ReviewOwnerLivenessHandle,
} from '../reviewer/reviewOwnerLiveness.js';

const exec = promisify(execFile);
export function managedModelId(repo: string, file: string): string {
  return `model-${createHash('sha256')
    .update(`${repo}/${file.replace(/-\d{5}-of-\d{5}\.gguf$/, '.gguf')}`)
    .digest('hex')
    .slice(0, 24)}`;
}

export async function findLlamaServer(root: string, depth = 0): Promise<string | undefined> {
  if (depth > 4) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(root, entry.name);
    if (
      entry.isFile() &&
      entry.name === (process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')
    )
      return file;
    if (entry.isDirectory()) {
      const found = await findLlamaServer(file, depth + 1);
      if (found) return found;
    }
  }
}

export function createLlamaCppService(
  userDataDir: string,
  contextLimits: () => Record<string, number> = () => ({}),
) {
  const root = path.join(userDataDir, 'llamacpp-runtime');
  const modelsRoot = path.join(root, 'models');
  let child: ChildProcess | undefined;
  let operation: LlamaCppSnapshot['operation'];
  let controller: AbortController | undefined;
  let ready = false;
  let modelsChanged = false;
  let activePreset: string | undefined;
  let starting: Promise<void> | undefined;
  let transfer: AbortController | undefined;
  let wakeDownload: (() => void) | undefined;
  let settled: Promise<void> | undefined;
  let ownerProof: ReviewOwnerLivenessHandle | undefined;
  let borrowed = false;
  let disposing = false;
  let stopping: Promise<void> | undefined;

  async function installed(): Promise<{ binary: string; version: string } | undefined> {
    try {
      const saved = JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8'));
      if (typeof saved.binary !== 'string' || typeof saved.version !== 'string') return;
      const binary = path.resolve(root, saved.binary);
      if (!binary.startsWith(`${root}${path.sep}`) || !(await stat(binary)).isFile()) return;
      return { binary, version: saved.version };
    } catch {
      return;
    }
  }
  async function models(): Promise<LlamaCppModel[]> {
    let dirs;
    try {
      dirs = await readdir(modelsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const result: LlamaCppModel[] = [];
    for (const dir of dirs) {
      if (!dir.isDirectory() || !/^model-[a-f0-9]{24}$/.test(dir.name)) continue;
      try {
        const record = JSON.parse(
          await readFile(path.join(modelsRoot, dir.name, 'model.json'), 'utf8'),
        ) as LlamaCppModel;
        if (record.id === dir.name && managedModelId(record.repo, record.file) === dir.name)
          result.push(record);
      } catch (error) {
        // Missing/corrupt records are not models; I/O failures are not evidence
        // of removal and must never publish a partial authoritative inventory.
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error;
      }
    }
    return result;
  }
  async function snapshot(): Promise<LlamaCppSnapshot> {
    const runtime = await installed();
    return {
      installed: !!runtime,
      supported: !!llamaCppPlatform(process.platform, process.arch),
      running: ready && (!!child || borrowed),
      canManageRuntime: ready && !!child,
      canPauseDownload: true,
      version: runtime?.version,
      models: await models(),
      ...(operation ? { operation: { ...operation } } : {}),
    };
  }
  async function exclusive<T>(
    kind: NonNullable<LlamaCppSnapshot['operation']>['kind'],
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (operation || disposing || stopping) throw new Error('BUSY');
    const current = new AbortController();
    controller = current;
    operation = { kind, completed: 0, total: 0 };
    let resolveSettled!: () => void;
    settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    try {
      if (kind === 'start') return await fn(current.signal);
      await mkdir(root, { recursive: true });
      return await withCrossProcessLock(
        path.join(root, 'server-start.lock'),
        { label: 'llamacpp operation', waitMs: 0 },
        async (lock) => {
          if (!lock.held) throw new Error('BUSY');
          return fn(current.signal);
        },
        current.signal,
      );
    } finally {
      controller = undefined;
      operation = undefined;
      resolveSettled();
      settled = undefined;
    }
  }
  function cancel() {
    controller?.abort();
    wakeDownload?.();
  }
  function pause() {
    if (operation?.kind !== 'download') return;
    operation.paused = true;
    operation.bytesPerSecond = 0;
    transfer?.abort('DOWNLOAD_PAUSED');
  }
  function resume() {
    if (operation?.kind !== 'download') return;
    operation.paused = false;
    wakeDownload?.();
  }
  function closeOwnerProof() {
    const proof = ownerProof;
    ownerProof = undefined;
    void proof?.close().catch(() => {});
  }
  async function stopAndWait(): Promise<void> {
    ready = false;
    borrowed = false;
    closeOwnerProof();
    const previous = child;
    if (!previous) return;
    await new Promise<void>((resolve, reject) => {
      const windows = process.platform === 'win32';
      let exited = false;
      let treeSettled = !windows;
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('STOP_TIMEOUT'));
      }, 4_000);
      const force = windows
        ? undefined
        : setTimeout(() => {
            if (child === previous) killProcessTree(previous.pid, previous);
          }, 1_500);
      const done = () => {
        if (!exited || !treeSettled) return;
        cleanup();
        resolve();
      };
      const onExit = () => {
        exited = true;
        done();
      };
      const cleanup = () => {
        clearTimeout(timeout);
        clearTimeout(force);
        previous.off('exit', onExit);
      };
      previous.once('exit', onExit);
      if (windows) {
        // Do not kill the router first: taskkill needs its live parent identity
        // to enumerate workers. Router exit alone does not settle tree cleanup.
        killProcessTree(previous.pid, previous, () => {
          treeSettled = true;
          done();
        });
      } else previous.kill('SIGTERM');
    });
  }
  async function install(): Promise<void> {
    return exclusive('install', async (signal) => {
      if (await installed()) return;
      const asset = await resolveLlamaCppRelease(signal);
      await mkdir(root, { recursive: true });
      const staging = await mkdtemp(path.join(root, 'install-'));
      try {
        const archive = path.join(staging, asset.name);
        operation!.total = asset.size;
        await downloadLlamaCppAsset(asset, archive, 'github', signal, (n) => {
          operation!.completed = n;
        });
        const unpacked = path.join(staging, 'unpacked');
        await mkdir(unpacked);
        const tar = process.platform === 'win32' ? windowsTarBin() : '/usr/bin/tar';
        await exec(tar, ['-xf', archive, '-C', unpacked], { signal, timeout: 120_000 });
        const executable = await findLlamaServer(unpacked);
        if (!executable) throw new Error('INSTALL_FAILED');
        if (process.platform !== 'win32') await chmod(executable, 0o755);
        const relative = path.relative(unpacked, executable);
        const destination = path.join(root, `${asset.version}-${path.basename(staging)}`);
        signal.throwIfAborted();
        await rename(unpacked, destination);
        const manifest = path.join(root, 'current.json');
        await writeFile(
          path.join(staging, 'current.json'),
          JSON.stringify({
            version: asset.version,
            binary: path.relative(root, path.join(destination, relative)),
          }),
        );
        await rename(path.join(staging, 'current.json'), manifest);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  }
  async function download(input: LlamaCppDownloadInput): Promise<void> {
    return exclusive('download', async (signal) => {
      operation!.model = input;
      const repository = await resolveHfRepository(input.repo, signal);
      const shards = selectGgufShards(repository.files, input.file);
      const id = managedModelId(input.repo, shards[0]!.name);
      if ((await models()).some((m) => m.id === id)) return;
      await mkdir(root, { recursive: true });
      await mkdir(modelsRoot, { recursive: true });
      const staging = await mkdtemp(path.join(root, 'model-download-'));
      try {
        const total = shards.reduce((sum, f) => sum + f.size, 0);
        const disk = await statfs(root);
        if (disk.bavail * disk.bsize < total + 512 * 1024 * 1024) throw new Error('DISK_SPACE');
        operation!.total = total;
        let completed = 0;
        for (const shard of shards) {
          for (;;) {
            if (operation!.paused && !signal.aborted)
              await new Promise<void>((resolve) => {
                wakeDownload = resolve;
              });
            wakeDownload = undefined;
            signal.throwIfAborted();
            const attempt = new AbortController();
            transfer = attempt;
            const beganAt = Date.now();
            const initialBytes = operation!.completed;
            try {
              await downloadLlamaCppAsset(
                {
                  url: hfDownloadUrl(input.repo, repository.revision, shard.name),
                  size: shard.size,
                  sha256: shard.sha256,
                },
                path.join(staging, path.basename(shard.name)),
                'hf',
                AbortSignal.any([signal, attempt.signal]),
                (n) => {
                  operation!.completed = completed + n;
                  operation!.bytesPerSecond =
                    Math.max(0, operation!.completed - initialBytes) /
                    Math.max((Date.now() - beganAt) / 1000, 1);
                },
                true,
              );
              break;
            } catch (error) {
              if (signal.aborted || attempt.signal.reason !== 'DOWNLOAD_PAUSED') throw error;
            } finally {
              transfer = undefined;
            }
          }
          completed += shard.size;
        }
        signal.throwIfAborted();
        const model: LlamaCppModel = { id, repo: input.repo, file: shards[0]!.name, size: total };
        await writeFile(path.join(staging, 'model.json'), JSON.stringify(model));
        try {
          await rename(staging, path.join(modelsRoot, id));
        } catch (error) {
          // Another instance may have atomically published this model first.
          // Never remove its directory; only our private staging is disposable.
          if (
            !['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            ) ||
            !(await models()).some((m) => m.id === id)
          )
            throw error;
        }
        modelsChanged = true;
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  }
  async function start(reload = false): Promise<void> {
    if (disposing || stopping) throw new Error('BUSY');
    if (starting) {
      await starting;
      return start(reload);
    }
    starting = exclusive('start', async (signal) => {
      await mkdir(root, { recursive: true });
      return withCrossProcessLock(
        path.join(root, 'server-start.lock'),
        { label: 'llamacpp startup', waitMs: 35_000 },
        async (lock) => {
          if (!lock.held) throw new Error('BUSY');
          // Own the entire startup, including its first filesystem read. Stop
          // cancels this same operation; late scans cannot resurrect a runtime.
          signal.throwIfAborted();
          const installedModels = await models();
          signal.throwIfAborted();
          const limits = contextLimits();
          const preset = [
            'version = 1',
            '[*]',
            `ctx-size = ${LLAMACPP_DEFAULT_CONTEXT}`,
            ...installedModels.flatMap((model) => llamaCppModelPreset(model, limits)),
            '',
          ].join('\n');
          if (ready && child && !reload && !modelsChanged && preset === activePreset) return;
          const runtime = await installed();
          if (!runtime) throw new Error('NOT_INSTALLED');
          if (!child) {
            let owner;
            try {
              owner = JSON.parse(await readFile(path.join(root, 'server-owner.json'), 'utf8'));
            } catch {
              /* no published owner */
            }
            if (
              owner?.identity?.version === 1 &&
              Number.isInteger(owner.identity.port) &&
              owner.identity.port > 0 &&
              owner.identity.port < 65536 &&
              typeof owner.identity.token === 'string' &&
              (await probeReviewOwnerLiveness(owner.identity)) === 'alive'
            ) {
              if (reload || owner.preset !== preset) throw new Error('BUSY');
              const health = await fetch(`${LLAMACPP_MANAGED_ORIGIN}/health`, {
                signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
                redirect: 'error',
              });
              await health.body?.cancel();
              if (!health.ok) throw new Error('BUSY');
              borrowed = true;
              ready = true;
              return;
            }
          }
          // Preference changes apply on demand. Never kill another task's active generation.
          if (ready && child && !reload) {
            const response = await fetch(`${LLAMACPP_MANAGED_ORIGIN}/v1/models`, {
              signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
              redirect: 'error',
            });
            if (!response.ok) throw new Error('BUSY');
            const listing = (await response.json()) as {
              data?: Array<{ id: string; status?: { value?: string } }>;
            };
            if (!Array.isArray(listing.data)) throw new Error('BUSY');
            for (const model of listing.data) {
              if (model.status?.value === 'unloaded') continue;
              if (model.status?.value !== 'loaded') throw new Error('BUSY');
              const slotsResponse = await fetch(
                `${LLAMACPP_MANAGED_ORIGIN}/slots?model=${encodeURIComponent(model.id)}&autoload=false`,
                {
                  signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
                  redirect: 'error',
                },
              );
              if (!slotsResponse.ok) throw new Error('BUSY');
              const slots = (await slotsResponse.json()) as Array<{ is_processing?: boolean }>;
              if (!Array.isArray(slots) || slots.some((slot) => slot.is_processing !== false))
                throw new Error('BUSY');
            }
          }
          await stopAndWait();
          await mkdir(modelsRoot, { recursive: true });
          const presets = path.join(root, 'models.ini');
          await writeFile(presets, preset);
          // Never claim or stop another application's server on the managed port.
          await new Promise<void>((resolve, reject) => {
            const probe = createServer();
            probe.once('error', () => reject(new Error('PORT_CONFLICT')));
            probe.listen(LLAMACPP_MANAGED_PORT, '127.0.0.1', () => probe.close(() => resolve()));
          });
          signal.throwIfAborted();
          const env = Object.fromEntries(
            Object.entries(process.env).filter(([key]) => {
              const normalized = key.toUpperCase();
              return (
                !normalized.startsWith('LLAMA_') &&
                !['HF_TOKEN', 'ENV', 'BASH_ENV'].includes(normalized)
              );
            }),
          );
          const command = llamaCppProcessCommand(runtime.binary, [
            '--host',
            '127.0.0.1',
            '--port',
            String(LLAMACPP_MANAGED_PORT),
            '--models-dir',
            modelsRoot,
            '--models-max',
            '1',
            '--models-preset',
            presets,
            '--parallel',
            '1',
            '--jinja',
          ]);
          const running = spawn(command.binary, command.args, {
            cwd: path.dirname(runtime.binary),
            env: { ...env, LLAMA_CACHE: path.join(root, 'cache') },
            stdio: ['pipe', 'ignore', 'ignore'],
            windowsHide: true,
            detached: process.platform !== 'win32',
          });
          child = running;
          let failed = false;
          running.once('error', () => {
            failed = true;
            if (child === running) {
              child = undefined;
              ready = false;
              closeOwnerProof();
            }
          });
          running.once('exit', () => {
            failed = true;
            if (child === running) {
              child = undefined;
              ready = false;
              closeOwnerProof();
            }
          });
          try {
            for (let attempt = 0; attempt < 120; attempt++) {
              signal.throwIfAborted();
              if (failed) throw new Error('START_FAILED');
              try {
                const res = await fetch(`${LLAMACPP_MANAGED_ORIGIN}/health`, {
                  signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
                  redirect: 'error',
                });
                await res.body?.cancel();
                if (res.ok && child === running && !failed) {
                  ownerProof = await startReviewOwnerLiveness();
                  await writeFile(
                    path.join(root, 'server-owner.json'),
                    JSON.stringify({ identity: ownerProof.identity, preset }),
                    { mode: 0o600 },
                  );
                  if (failed || child !== running) {
                    closeOwnerProof();
                    throw new Error('START_FAILED');
                  }
                  ready = true;
                  activePreset = preset;
                  modelsChanged = false;
                  return;
                }
              } catch {
                /* wait for owned child to bind */
              }
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
            throw new Error('START_TIMEOUT');
          } catch (error) {
            await stopAndWait();
            throw error;
          }
        },
        signal,
      );
    });
    try {
      await starting;
    } finally {
      starting = undefined;
    }
  }
  async function stopRequested(afterStop?: () => Promise<void>): Promise<void> {
    if (stopping) {
      await stopping;
      if (afterStop) return stopRequested(afterStop);
      return;
    }
    stopping = (async () => {
      cancel();
      await settled;
      await starting?.catch(() => {});
      await stopAndWait();
      await afterStop?.();
    })();
    try {
      await stopping;
    } finally {
      stopping = undefined;
    }
  }
  return {
    remove: (deleteConnection: () => Promise<void>) =>
      stopRequested(async () => {
        await mkdir(root, { recursive: true });
        await withCrossProcessLock(
          path.join(root, 'server-start.lock'),
          { label: 'llamacpp removal', waitMs: 0 },
          async (lock) => {
            if (!lock.held) throw new Error('BUSY');
            let owner;
            try {
              owner = JSON.parse(await readFile(path.join(root, 'server-owner.json'), 'utf8'));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('BUSY');
            }
            if (owner && (await probeReviewOwnerLiveness(owner.identity)) !== 'ended')
              throw new Error('BUSY');
            await deleteConnection();
          },
        );
      }),
    snapshot,
    install,
    download,
    start,
    stop: stopRequested,
    cancel,
    pause,
    resume,
    dispose: async () => {
      disposing = true;
      cancel();
      await settled;
      await stopRequested();
      if (!child) {
        ready = false;
        borrowed = false;
      }
    },
  };
}
export type LlamaCppService = ReturnType<typeof createLlamaCppService>;
let current: LlamaCppService | undefined;
export function getManagedLlamaCppService(userDataDir: string): LlamaCppService {
  return (current ??= createLlamaCppService(userDataDir, readModelContextLimits));
}
/** Deletion must not create a runtime merely to stop it. */
export async function stopManagedLlamaCppService(
  deleteConnection: () => Promise<void>,
): Promise<void> {
  if (!current) throw new Error('BUSY');
  await current.remove(deleteConnection);
}
