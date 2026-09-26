import { createHash } from 'node:crypto';
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
    } catch {
      return [];
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
      } catch {
        /* incomplete/corrupt folders are not models */
      }
    }
    return result;
  }
  async function snapshot(): Promise<LlamaCppSnapshot> {
    const runtime = await installed();
    return {
      installed: !!runtime,
      supported: !!llamaCppPlatform(process.platform, process.arch),
      running: ready && !!child,
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
    if (operation) throw new Error('BUSY');
    const current = new AbortController();
    controller = current;
    operation = { kind, completed: 0, total: 0 };
    try {
      if (kind === 'install' || kind === 'download') {
        // This service owns its userData root. No other operation can hold a
        // staging directory here; keep installed versions and models untouched.
        const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
        for (const entry of entries) {
          if (
            entry.isDirectory() &&
            /^(install-|model-download-)[A-Za-z0-9]{6}$/.test(entry.name)
          ) {
            current.signal.throwIfAborted();
            await rm(path.join(root, entry.name), { recursive: true, force: true });
          }
        }
      }
      return await fn(current.signal);
    } finally {
      controller = undefined;
      operation = undefined;
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
  function stop() {
    ready = false;
    child?.kill('SIGTERM');
  }
  async function stopAndWait(): Promise<void> {
    const previous = child;
    if (!previous) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('STOP_TIMEOUT'));
      }, 4_000);
      const force = setTimeout(() => {
        if (child === previous) killProcessTree(previous.pid, previous);
      }, 1_500);
      const done = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timeout);
        clearTimeout(force);
        previous.off('exit', done);
      };
      previous.once('exit', done);
      stop();
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
        const destination = path.join(root, `${asset.version}-${Date.now()}`);
        signal.throwIfAborted();
        await rename(unpacked, destination);
        const manifest = path.join(root, 'current.json');
        await writeFile(
          `${manifest}.tmp`,
          JSON.stringify({
            version: asset.version,
            binary: path.relative(root, path.join(destination, relative)),
          }),
        );
        await rename(`${manifest}.tmp`, manifest);
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
        await rename(staging, path.join(modelsRoot, id));
        modelsChanged = true;
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  }
  async function start(reload = false): Promise<void> {
    if (starting) {
      await starting;
      return start(reload);
    }
    const installedModels = await models();
    if (starting) {
      await starting;
      return start(reload);
    }
    const limits = contextLimits();
    const preset = [
      'version = 1',
      '[*]',
      `ctx-size = ${LLAMACPP_DEFAULT_CONTEXT}`,
      ...installedModels.flatMap((model) => llamaCppModelPreset(model, limits)),
      '',
    ].join('\n');
    if (ready && child && !reload && !modelsChanged && preset === activePreset) return;
    starting = exclusive('start', async (signal) => {
      const runtime = await installed();
      if (!runtime) throw new Error('NOT_INSTALLED');
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
      const { createServer } = await import('node:net');
      await new Promise<void>((resolve, reject) => {
        const probe = createServer();
        probe.once('error', () => reject(new Error('PORT_CONFLICT')));
        probe.listen(LLAMACPP_MANAGED_PORT, '127.0.0.1', () => probe.close(() => resolve()));
      });
      signal.throwIfAborted();
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith('LLAMA_') && key !== 'HF_TOKEN',
        ),
      );
      const running = spawn(
        runtime.binary,
        [
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
        ],
        {
          cwd: path.dirname(runtime.binary),
          env: { ...env, LLAMA_CACHE: path.join(root, 'cache') },
          stdio: 'ignore',
          windowsHide: true,
          detached: process.platform !== 'win32',
        },
      );
      child = running;
      let failed = false;
      running.once('error', () => {
        failed = true;
        if (child === running) {
          child = undefined;
          ready = false;
        }
      });
      running.once('exit', () => {
        failed = true;
        if (child === running) {
          child = undefined;
          ready = false;
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
    });
    try {
      await starting;
    } finally {
      starting = undefined;
    }
  }
  async function stopRequested(): Promise<void> {
    if (starting) {
      cancel();
      await starting.catch(() => {});
    }
    await stopAndWait();
  }
  return {
    snapshot,
    install,
    download,
    start,
    stop: stopRequested,
    cancel,
    pause,
    resume,
    dispose: async () => {
      cancel();
      await stopRequested();
    },
  };
}
export type LlamaCppService = ReturnType<typeof createLlamaCppService>;
let current: LlamaCppService | undefined;
export function getManagedLlamaCppService(userDataDir: string): LlamaCppService {
  return (current ??= createLlamaCppService(userDataDir, readModelContextLimits));
}
