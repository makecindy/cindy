import { promises as fs } from 'node:fs';
import path from 'node:path';
import { net } from 'electron';
import type { PiKernelSource, PiKernelState, PiKernelRelease, PiKernelInstallRequest } from '../../shared/piKernel.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { withSecurityBoundaryLock } from '../device-link/crossProcessLock.js';
import { getBaseUrl, getPlatformKey } from '../manifestService.js';
import { probeBinaryVersion, isBinaryVersionNotOlder } from './binary-version-probe.js';
import { installPiBinaryRelease, parsePiRelease, piBinaryUpdateDefaults, piBinaryUpdateError, type PiBinaryRelease } from './pi-self-update.js';

const VERSION = /^\d+\.\d+\.\d+$/;
interface Release extends PiBinaryRelease { size?: number; publishedAt?: string; releaseUrl?: string }
interface Selection { schema: 1; source: PiKernelSource; version: string; directory: string }
export class PiKernelError extends Error {
  constructor(readonly reason: 'busy' | 'version-changed' | 'install-failed' | 'selection-invalid') {
    super(reason);
  }
}

export function parseOfficialPiRelease(value: unknown, base: string, platform = process.platform): Release {
  const asset = (value as { pi?: Record<string, unknown> } | null)?.pi;
  if (!asset || typeof asset.version !== 'string' || !VERSION.test(asset.version)
    || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)
    || typeof asset.file !== 'string' || !/^[a-zA-Z0-9._/-]+\.tar\.gz$/.test(asset.file)
    || asset.file.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid official Pi release');
  }
  const root = new URL(base.endsWith('/') ? base : `${base}/`);
  const url = new URL(asset.file, root);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || url.username || url.password) {
    throw new Error('Invalid official Pi asset URL');
  }
  return { version: asset.version, url: url.href, sha256: asset.sha256, format: 'tar.gz',
    executable: platform === 'win32' ? 'pi.exe' : 'pi',
    ...(typeof asset.size === 'number' && Number.isFinite(asset.size) && asset.size > 0 ? { size: asset.size } : {}) };
}

async function lookupRelease(source: PiKernelSource, signal: AbortSignal): Promise<Release> {
  if (source === 'upstream') {
    const data = await piBinaryUpdateDefaults.fetchRelease(signal);
    let release: PiBinaryRelease;
    try { release = parsePiRelease(data, process.platform, process.arch); }
    catch (error) { throw piBinaryUpdateError(error, 'asset-validation'); }
    const raw = data as { published_at?: unknown; assets?: Array<{ browser_download_url?: string; size?: number }> };
    return { ...release, size: raw.assets?.find(a => a?.browser_download_url === release.url)?.size,
      ...(typeof raw.published_at === 'string' && Number.isFinite(Date.parse(raw.published_at)) ? { publishedAt: raw.published_at } : {}),
      releaseUrl: `https://github.com/earendil-works/pi/releases/tag/v${release.version}` };
  }
  // Explicit recovery always uses release, never the user's app beta/canary channel.
  const base = getBaseUrl();
  const response = await net.fetch(`${base}/manifest-${getPlatformKey()}.json?t=${Date.now()}`, { signal });
  if (!response.ok) throw new Error('Official Pi release unavailable');
  const data: unknown = await response.json();
  try { return parseOfficialPiRelease(data, base); }
  catch (error) { throw piBinaryUpdateError(error, 'asset-validation'); }
}
async function lookup(source: PiKernelSource, signal: AbortSignal): Promise<Release> {
  try { return await lookupRelease(source, signal); }
  catch (error) { throw piBinaryUpdateError(error, 'release-lookup'); }
}

function project(release: Release): PiKernelRelease {
  return { version: release.version, size: release.size, publishedAt: release.publishedAt, releaseUrl: release.releaseUrl };
}

export interface PiKernelManagerDeps {
  root: string;
  current: () => string | undefined;
  activate: (binary: string) => void;
  lookup: typeof lookup;
  probe: typeof probeBinaryVersion;
  install: typeof installPiBinaryRelease;
  writeSelection: typeof atomicWriteFileSync;
  lock: <T>(operation: () => Promise<T>) => Promise<T>;
}

/** Single authority shared by Settings, managed commands and startup. */
export class PiKernelManager {
  private operation: PiKernelState['operation'] = null;
  private restartRequired = false;
  private checks: Pick<PiKernelState, 'official' | 'upstream'> = {
    official: { release: null, checkedAt: null, error: false },
    upstream: { release: null, checkedAt: null, error: false },
  };
  private checking: Promise<PiKernelState> | null = null;
  constructor(private readonly deps: PiKernelManagerDeps) {}

  private selectionFile(): string { return path.join(this.deps.root, 'selected.json'); }
  hasSelection(): boolean { return readAtomicFileSync(this.selectionFile()) !== null; }
  private readSelection(): Selection | null {
    const raw = readAtomicFileSync(this.selectionFile());
    if (raw === null) return null;
    try {
      const s = JSON.parse(raw) as Selection;
      if (s.schema !== 1 || !['official', 'upstream'].includes(s.source) || !VERSION.test(s.version)
        || typeof s.directory !== 'string' || !s.directory.startsWith(`${s.version}-`)
        || !/^\d+\.\d+\.\d+-[a-f0-9-]{36}$/.test(s.directory)) throw new Error();
      return s;
    } catch { throw new PiKernelError('selection-invalid'); }
  }

  /** A saved downgrade wins over every higher leftover install. Never silently reselect. */
  async selectedBinary(signal?: AbortSignal): Promise<string | null> {
    const selection = this.readSelection();
    if (!selection) return null;
    const directory = path.join(this.deps.root, selection.directory);
    const executable = process.platform === 'win32' ? 'pi.exe' : 'pi';
    const binary = path.join(directory, executable);
    try {
      if (!(await fs.lstat(directory)).isDirectory() || (await fs.lstat(binary)).isSymbolicLink()) throw new Error();
      await fs.access(path.join(directory, '.verified'));
      // Native/manual self-updates remain usable; the executable is the version authority.
      if (!await this.deps.probe(binary, signal)) throw new Error();
      return binary;
    } catch { throw new PiKernelError('selection-invalid'); }
  }

  async state(): Promise<PiKernelState> {
    const binary = this.deps.current();
    return { currentVersion: binary ? await this.deps.probe(binary) : null, restartRequired: this.restartRequired,
      official: { ...this.checks.official }, upstream: { ...this.checks.upstream },
      operation: this.operation ? { ...this.operation } : null };
  }
  check(): Promise<PiKernelState> {
    if (this.checking) return this.checking;
    const task = (async () => {
      await Promise.all((['official', 'upstream'] as const).map(async source => {
        try {
          const release = await this.deps.lookup(source, AbortSignal.timeout(15_000));
          this.checks[source] = { release: project(release), checkedAt: Date.now(), error: false };
        } catch { this.checks[source] = { ...this.checks[source], error: true }; }
      }));
      return this.state();
    })();
    this.checking = task;
    void task.finally(() => { if (this.checking === task) this.checking = null; }).catch(() => undefined);
    return task;
  }

  /** User-selected versions are explicit overrides, including restoring an older release. */
  async install(request: PiKernelInstallRequest | { source: 'upstream'; force: boolean }): Promise<string> {
    if (this.operation) throw new PiKernelError('busy');
    this.operation = { source: request.source, phase: 'lookup' };
    try {
      return await this.deps.lock(async () => {
        const signal = AbortSignal.timeout(180_000);
        const release = await this.deps.lookup(request.source, signal);
        this.checks[request.source] = { release: project(release), checkedAt: Date.now(), error: false };
        if ('version' in request && request.version !== release.version) throw new PiKernelError('version-changed');
        if ('force' in request && !request.force) {
          const selected = await this.selectedBinary(signal).catch(() => null);
          const binary = selected ?? this.deps.current();
          const current = binary ? await this.deps.probe(binary, signal) : null;
          // Reinstall equal legacy versions to fix stale names; never implicitly downgrade a newer native install.
          if (current && isBinaryVersionNotOlder(current, release.version) && (selected || current !== release.version)) {
            this.deps.activate(binary!);
            return current;
          }
        }
        const installed = await this.deps.install(this.deps.root, release, undefined, process.platform, signal, phase => {
          this.operation = { source: request.source, phase };
        });
        let activated = false;
        try {
          signal.throwIfAborted();
          this.operation = { source: request.source, phase: 'activate' };
          const selection: Selection = { schema: 1, source: request.source, version: installed.version,
            directory: path.basename(path.dirname(installed.binaryPath)) };
          // Persist first. A disk failure leaves the old ready path and pointer untouched.
          try { this.deps.writeSelection(this.selectionFile(), JSON.stringify(selection)); }
          catch (error) { throw piBinaryUpdateError(error, 'publish'); }
          activated = true;
          if (!this.deps.current()) this.restartRequired = true;
          this.deps.activate(installed.binaryPath);
          return installed.version;
        } finally {
          if (!activated) {
            // Invalidate before removing: legacy startup must not select an orphan.
            const directory = path.dirname(installed.binaryPath);
            await fs.rm(path.join(directory, '.verified'), { force: true });
            await fs.rm(directory, { recursive: true, force: true });
          }
        }
      });
    } finally { this.operation = null; }
  }
}

export function createPiKernelManager(root: string, current: () => string | undefined, activate: (binary: string) => void): PiKernelManager {
  return new PiKernelManager({ root, current, activate, lookup, probe: probeBinaryVersion,
    install: installPiBinaryRelease, writeSelection: atomicWriteFileSync,
    lock: async operation => {
      await fs.mkdir(root, { recursive: true });
      return withSecurityBoundaryLock(path.join(root, 'install.lock'), { label: 'pi-kernel-install', waitMs: 0 }, async status => {
        if (!status.held) throw new PiKernelError('busy');
        return operation();
      });
    },
  });
}
