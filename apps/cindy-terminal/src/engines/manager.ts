import { publishEngineDirectory } from './publish.js';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import path from 'node:path';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../platform.js';
import { extractEngineArchive, archivePath } from './archive.js';
import { bundledEngineRelease, enginePlatform, latestEngineRelease } from './releases.js';
import { runNative, nativeEngineCandidates } from './native.js';
import { EngineError, type EngineKind, type EngineStatus, type EngineRelease, type EngineAsset } from './types.js';

interface Receipt { version: string; directory: string; entrypoint: string; sha256: string; asset?: EngineAsset }
export interface EngineInstallProgress { kind: EngineKind; stage: 'download' | 'verify' | 'extract' | 'ready'; downloaded?: number; total?: number }
export interface EngineManagerOptions {
  profileDir: string;
  binaryPaths?: Partial<Record<EngineKind, string>>;
  onProgress?: (progress: EngineInstallProgress) => void;
}

/** Binary storage is separate from task credential homes and never copies them. */
export class EngineManager {
  readonly root: string;
  constructor(private readonly options: EngineManagerOptions) { this.root = path.join(options.profileDir, 'engine-binaries'); }

  private async receipt(kind: EngineKind): Promise<Receipt | null> {
    try {
      const content = await readPrivateFile(path.join(this.root, kind, 'current.json'));
      if (!content) return null;
      const state = JSON.parse(content.toString('utf8')) as Receipt;
      if (!/^[\w.+-]+$/.test(state.directory) || !/^[\w.+-]+$/.test(state.version) || !/^[a-f0-9]{64}$/.test(state.sha256)) return null;
      archivePath(state.entrypoint);
      return state;
    } catch { return null; }
  }

  async resolve(kind: EngineKind): Promise<{ binary: string; source: 'managed' | 'path'; version: string | null } | null> {
    const explicit = this.options.binaryPaths?.[kind];
    const state = !explicit ? await this.receipt(kind) : null;
    const managed = state ? path.join(this.root, kind, state.directory, ...state.entrypoint.split('/')) : null;
    const candidates = explicit ? [explicit] : [...(managed ? [managed] : []), ...nativeEngineCandidates(kind)];
    for (const candidate of candidates) {
      try {
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        if (!(await lstat(candidate)).isFile() && !(await lstat(candidate)).isSymbolicLink()) continue;
        return { binary: path.resolve(candidate), source: candidate === managed ? 'managed' : 'path', version: candidate === managed ? state!.version : null };
      } catch { /* Continue past missing executables. */ }
    }
    return null;
  }

  async status(kind: EngineKind): Promise<EngineStatus> {
    const resolved = await this.resolve(kind);
    let version = resolved?.version ?? null;
    if (resolved && !version) {
      try { const result = await runNative(resolved.binary, ['--version']); version = result.code === 0 ? result.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ?? null : null; } catch { /* Report unavailable version without raw CLI output. */ }
    }
    return { kind, source: resolved?.source ?? 'missing', binary: resolved?.binary ?? null, version, bundledVersion: bundledEngineRelease(kind).version };
  }

  async allStatus(): Promise<EngineStatus[]> { return Promise.all((['claude-code', 'codex', 'pi'] as const).map(kind => this.status(kind))); }

  async install(kind: EngineKind, options: { latest?: boolean; signal?: AbortSignal } = {}): Promise<EngineStatus> {
    const release = options.latest ? await latestEngineRelease(kind, options.signal) : bundledEngineRelease(kind);
    return this.installRelease(kind, release, options.signal);
  }

  async update(kind: EngineKind, signal?: AbortSignal): Promise<EngineStatus> { return this.install(kind, { latest: true, signal }); }

  async repair(kind: EngineKind, signal?: AbortSignal): Promise<EngineStatus> {
    const active = await this.receipt(kind);
    if (!active) return this.install(kind, { latest: true, signal });
    const release = active.asset && active.asset.sha256 === active.sha256 && active.asset.entrypoint === active.entrypoint
      ? { version: active.version, assets: { [enginePlatform()]: active.asset } }
      : await latestEngineRelease(kind, signal, active.version);
    return this.installRelease(kind, release, signal);
  }

  /** Injectable release supports offline distributions/tests; callers must only
   * supply manifests they trust. UI/network input cannot supply download URLs. */
  async installRelease(kind: EngineKind, release: EngineRelease, signal?: AbortSignal): Promise<EngineStatus> {
    const asset = release.assets[enginePlatform()];
    if (!asset) throw new EngineError('engine_platform_unavailable');
    if (!/^[\w.+-]+$/.test(release.version) || !/^[a-f0-9]{64}$/i.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 1024 ** 3 || new URL(asset.url).protocol !== 'https:') throw new EngineError('invalid_release');
    archivePath(asset.entrypoint);
    const home = path.join(this.root, kind);
    await privateDirectory(this.root); await privateDirectory(home);
    const id = `${release.version}-${randomUUID()}`;
    const destination = path.join(home, id);
    const staging = path.join(home, `.install-${randomUUID()}`);
    await privateDirectory(staging);
    const archive = path.join(staging, 'download');
    const files = path.join(staging, 'files');
    await mkdir(files, { mode: 0o700 });
    let stage = 'download';
    let published = false, activated = false;
    try {
      await this.download(kind, asset, archive, signal);
      stage = 'extract';
      this.options.onProgress?.({ kind, stage: 'extract' });
      if (asset.format === 'raw') { await rename(archive, path.join(files, asset.entrypoint)); }
      else await extractEngineArchive(archive, files, asset.format);
      signal?.throwIfAborted();
      stage = 'layout';
      const root = await this.layout(kind, files, asset, release.version);
      const binary = path.join(root, asset.entrypoint);
      if (process.platform !== 'win32') await chmod(binary, 0o700);
      // Move before executing: Windows may keep the executable mapped after
      // --version closes. Only current.json activates this unique directory.
      stage = 'publish';
      await publishEngineDirectory(root, destination, signal);
      published = true;
      signal?.throwIfAborted();
      // Validate at the final path, including any relative runtime resources.
      // Never inspect auth, and leave the old receipt active until this passes.
      stage = 'version';
      const reported = await runNative(path.join(destination, asset.entrypoint), ['--version'], { signal, timeout: 30_000 });
      if (reported.code !== 0 || !reported.stdout.includes(release.version)) throw new EngineError('engine_version_mismatch');
      signal?.throwIfAborted();
      stage = 'receipt';
      await atomicPrivateWrite(path.join(home, 'current.json'), JSON.stringify({ version: release.version, directory: id, entrypoint: asset.entrypoint, sha256: asset.sha256, asset } satisfies Receipt));
      activated = true;
      this.options.onProgress?.({ kind, stage: 'ready' });
      return this.status(kind);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code && /^E[A-Z]+$/.test(code)) throw new EngineError(`engine_${stage}_${code.toLowerCase()}`);
      throw error;
    } finally {
      // Keep candidates once receipt publication starts: an fsync error can
      // follow a successful rename. Removing that directory would break the
      // now-active receipt. Earlier failures are never selectable.
      if (published && !activated && stage !== 'receipt') await rm(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
      // Defender can briefly retain handles even after our own streams close.
      // Node's bounded retry applies only to its documented transient rm errors.
      await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(error => {
        const code = (error as NodeJS.ErrnoException)?.code;
        throw new EngineError(`engine_cleanup_${code && /^E[A-Z]+$/.test(code) ? code.toLowerCase() : 'failed'}`);
      });
    }
  }

  private async download(kind: EngineKind, asset: EngineAsset, output: string, signal?: AbortSignal): Promise<void> {
    const response = await fetch(asset.url, { signal: AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(signal ? [signal] : [])]) });
    if (!response.ok || !response.body || new URL(response.url || asset.url).protocol !== 'https:') throw new EngineError('engine_download_failed');
    let bytes = 0;
    const hash = createHash('sha256');
    const check = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
      bytes += chunk.length;
      if (bytes > asset.size) { callback(new EngineError('engine_size_mismatch')); return; }
      hash.update(chunk); this.options.onProgress?.({ kind, stage: 'download', downloaded: bytes, total: asset.size }); callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body as never), check, createWriteStream(output, { flags: 'wx', mode: 0o600 }));
    this.options.onProgress?.({ kind, stage: 'verify' });
    if (bytes !== asset.size || hash.digest('hex') !== asset.sha256.toLowerCase()) throw new EngineError('engine_checksum_mismatch');
  }

  private async layout(kind: EngineKind, files: string, asset: EngineAsset, version: string): Promise<string> {
    let root = files;
    try { if (!(await lstat(path.join(root, asset.entrypoint))).isFile()) throw new EngineError('invalid_engine_layout'); } catch {
      const entries = await readdir(files, { withFileTypes: true });
      if (entries.length !== 1 || !entries[0]!.isDirectory()) throw new EngineError('invalid_engine_layout');
      root = path.join(files, entries[0]!.name);
    }
    const required = [asset.entrypoint];
    // Pi 1.4 distributes the runtime themes without the development JSON schema.
    if (kind === 'pi') required.push('theme/dark.json', 'theme/light.json');
    if (kind === 'codex') {
      required.push('codex-package.json', `bin/codex-code-mode-host${process.platform === 'win32' ? '.exe' : ''}`, `codex-path/rg${process.platform === 'win32' ? '.exe' : ''}`);
      const manifest = JSON.parse(await readFile(path.join(root, 'codex-package.json'), 'utf8'));
      if (manifest.layoutVersion !== 1 || manifest.variant !== 'codex' || manifest.version !== version || manifest.target !== asset.target || manifest.entrypoint !== asset.entrypoint || manifest.resourcesDir !== 'codex-resources' || manifest.pathDir !== 'codex-path') throw new EngineError('invalid_engine_layout');
      if (!(await lstat(path.join(root, 'codex-resources'))).isDirectory()) throw new EngineError('invalid_engine_layout');
    }
    for (const file of required) if (!(await lstat(path.join(root, file))).isFile()) throw new EngineError('invalid_engine_layout');
    return root;
  }
}
