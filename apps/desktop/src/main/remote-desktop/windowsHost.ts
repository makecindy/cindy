import { app } from 'electron';
import { REMOTE_DESKTOP_OFFER_BUDGET } from '@cindy/device-link';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '../logger';
import type { WindowsDesktopSupport } from '../../shared/remoteDesktop';

const exec = promisify(execFile);
const log = createLogger('remote-desktop:windows');
const requireNative = createRequire(import.meta.url);
const packagedBinary = () =>
  path.join(process.resourcesPath, 'tools', 'remote-desktop', 'cindy-windows-desktop-host.exe');
const packagedAddon = () =>
  path.join(process.resourcesPath, 'tools', 'remote-desktop', 'cindy-windows-desktop-host.node');
const packagedInput = () =>
  path.join(process.resourcesPath, 'tools', 'remote-desktop', 'cindy-windows-desktop-input.exe');
type WindowsDesktopArtifacts = { binary: string; addon: string; input: string };
let build: Promise<WindowsDesktopArtifacts> | null = null;
class WindowsDesktopArtifactsMissing extends Error {
  constructor() {
    super('WINDOWS_DESKTOP_ARTIFACTS_NOT_BUILT');
    this.name = 'WindowsDesktopArtifactsMissing';
  }
}

/** Match Cargo's Windows target to the architecture of the running Electron. */
export function windowsCargoTarget(arch: NodeJS.Architecture = process.arch): string {
  if (arch === 'arm64') return 'aarch64-pc-windows-msvc';
  if (arch === 'x64') return 'x86_64-pc-windows-msvc';
  throw new Error('Unsupported Windows desktop architecture: ' + arch);
}

/**
 * The packaged helper is already present in resources. In source mode, build
 * both targets into a private userData cache, then arrange the executable under
 * a stable `resources/tools/remote-desktop` shape so the Rust service and the
 * Main-only addon derive the same installation identity. The cache directory is
 * stable across source edits; its source digest decides when it needs rebuilding.
 */
async function resolveArtifacts(
  options: { allowBuild?: boolean } = {},
): Promise<WindowsDesktopArtifacts> {
  const allowBuild = options.allowBuild !== false;
  if (app.isPackaged)
    return { binary: packagedBinary(), addon: packagedAddon(), input: packagedInput() };
  if (build) {
    if (!allowBuild) throw new WindowsDesktopArtifactsMissing();
    return build;
  }
  const resolve = async (): Promise<WindowsDesktopArtifacts> => {
    const nativeRoot = path.join(app.getAppPath(), 'native', 'remote-desktop');
    const hostRoot = path.join(nativeRoot, 'windows-host');
    const inputRoot = path.join(nativeRoot, 'windows-input');
    const sourceFiles = [
      'Cargo.toml',
      'Cargo.lock',
      'build.rs',
      'src/capture.rs',
      'src/capture_protocol.rs',
      'src/cursor.rs',
      'src/lib.rs',
      'src/main.rs',
      'src/naming.rs',
      'src/pipe.rs',
      'src/security.rs',
      'src/service.rs',
      'src/staging.rs',
      'src/win.rs',
    ].map((file) => path.join('windows-host', file));
    sourceFiles.push(
      ...[
        'Cargo.toml',
        'Cargo.lock',
        'src/desktop.rs',
        'src/main.rs',
        'src/privacy.rs',
        'src/selection.rs',
      ].map((file) => path.join('windows-input', file)),
    );
    const installHash = createHash('sha256')
      .update(process.arch)
      .update(path.resolve(app.getAppPath()).toLowerCase())
      .digest('hex');
    const digest = createHash('sha256')
      .update(process.arch)
      .update(path.resolve(app.getAppPath()).toLowerCase());
    for (const file of sourceFiles) {
      digest.update(file);
      digest.update(await fs.readFile(path.join(nativeRoot, file)));
    }
    const sourceHash = digest.digest('hex');
    const installRoot = path.join(
      app.getPath('userData'),
      'remote-desktop',
      'development',
      installHash.slice(0, 32),
    );
    const helperDir = path.join(installRoot, 'resources', 'tools', 'remote-desktop');
    const binary = path.join(helperDir, 'cindy-windows-desktop-host.exe');
    const input = path.join(helperDir, 'cindy-windows-desktop-input.exe');
    const stamp = path.join(installRoot, 'source.sha256');
    // Windows keeps a loaded Node-API addon open. Give each source revision
    // its own addon filename so a running dev process can rebuild without
    // trying to unlink the addon it currently has loaded.
    const versionedAddon = path.join(
      helperDir,
      `cindy-windows-desktop-host-${sourceHash.slice(0, 16)}.node`,
    );
    const legacyAddon = path.join(helperDir, 'cindy-windows-desktop-host.node');
    try {
      if ((await fs.readFile(stamp, 'utf8')).trim() === sourceHash) {
        await Promise.all([fs.access(binary), fs.access(input)]);
        try {
          await fs.access(versionedAddon);
          return { binary, addon: versionedAddon, input };
        } catch {
          // Existing caches used the fixed addon name. Keep them usable until
          // the next source build creates a revisioned name.
          await fs.access(legacyAddon);
          return { binary, addon: legacyAddon, input };
        }
      }
    } catch {
      // Build below. A partial cache is disposable and never becomes visible
      // until both final files and the stamp have been written.
    }
    if (!allowBuild) throw new WindowsDesktopArtifactsMissing();
    await fs.mkdir(helperDir, { recursive: true });
    const buildDir = path.join(installRoot, 'build');
    const cargoTarget = windowsCargoTarget();
    const buildCargo = (
      root: string,
      targetDir: string,
      target?: '--bin' | '--lib',
      name?: string,
    ) =>
      exec(
        'cargo',
        [
          'build',
          '--release',
          '--locked',
          '--target',
          cargoTarget,
          '--manifest-path',
          path.join(root, 'Cargo.toml'),
          '--target-dir',
          targetDir,
          ...(target ? [target, ...(name ? [name] : [])] : []),
        ],
        { timeout: 180_000, windowsHide: true },
      );
    // The host package exposes both a binary and a cdylib. Building both in
    // one Cargo target collides on Windows because the linker gives them the
    // same PDB filename. Keep their target directories separate so source
    // mode can build deterministically even when the cache is cold.
    await buildCargo(
      hostRoot,
      path.join(buildDir, 'host-bin'),
      '--bin',
      'cindy-windows-desktop-host',
    );
    await buildCargo(hostRoot, path.join(buildDir, 'host-addon'), '--lib');
    await buildCargo(inputRoot, path.join(buildDir, 'input'));
    const hostBinaryOutput = path.join(buildDir, 'host-bin', cargoTarget, 'release');
    const hostAddonOutput = path.join(buildDir, 'host-addon', cargoTarget, 'release');
    const inputOutput = path.join(buildDir, 'input', cargoTarget, 'release');
    const temporaryBinary = binary + '.' + process.pid + '.tmp';
    const temporaryAddon = versionedAddon + '.' + process.pid + '.tmp';
    const temporaryInput = input + '.' + process.pid + '.tmp';
    await Promise.all([
      fs.copyFile(path.join(hostBinaryOutput, 'cindy-windows-desktop-host.exe'), temporaryBinary),
      fs.copyFile(path.join(hostAddonOutput, 'cindy_windows_desktop_host.dll'), temporaryAddon),
      fs.copyFile(path.join(inputOutput, 'cindy-windows-desktop-input.exe'), temporaryInput),
    ]);
    await Promise.all([fs.rm(binary, { force: true }), fs.rm(input, { force: true })]);
    await Promise.all([fs.rename(temporaryBinary, binary), fs.rename(temporaryInput, input)]);
    // A previous run may already have produced this revision while its stamp
    // write was interrupted. Reuse that file rather than unlinking a loaded
    // addon; otherwise a live Electron process would turn recovery into EPERM.
    try {
      await fs.access(versionedAddon);
      await fs.rm(temporaryAddon, { force: true });
    } catch {
      await fs.rename(temporaryAddon, versionedAddon);
    }
    await fs.writeFile(stamp, `${sourceHash}\n`, 'utf8');
    return { binary, addon: versionedAddon, input };
  };
  build = resolve().finally(() => {
    build = null;
  });
  return build;
}
export interface WindowsDesktopConnection {
  request(line: string): Promise<string>;
  close(): void;
}

/**
 * The helper's own name for the setup step that failed, plus an OS error
 * number — `service-create 5`, or `elevate-child/protected-acl 0` when the
 * failure happened inside the hidden elevated child. It carries no path,
 * account name or other machine content, so it is safe to log and to show in
 * settings. Without it every failure looks the same from outside.
 */
export type WindowsDesktopDetail = string;
const DETAIL = /^[a-z-]+(?:\/[a-z-]+)? -?\d+$/;

/** Reads the diagnostic the helper appends to a status word or an error line. */
export function readWindowsDesktopDetail(output: unknown): WindowsDesktopDetail | undefined {
  if (typeof output !== 'string') return undefined;
  const line = output.trim().split('\n').at(-1)?.trim() ?? '';
  const detail = line.startsWith('error ')
    ? line.slice('error '.length)
    : line.split(' ').slice(1).join(' ');
  return DETAIL.test(detail) ? detail : undefined;
}

/** A setup failure that kept the helper's step code, for the caller to report. */
export class WindowsDesktopSetupError extends Error {
  constructor(readonly detail?: WindowsDesktopDetail) {
    super('DESKTOP_SYSTEM_SERVICE_UNAVAILABLE');
    this.name = 'WindowsDesktopSetupError';
  }
}

export async function readWindowsDesktopSupport(): Promise<WindowsDesktopSupport | undefined> {
  if (process.platform !== 'win32') return undefined;
  let stdout: string;
  try {
    // Status is queried by ordinary remote-desktop capability reads. Do not
    // make those reads compile three Rust targets; an explicit setup action
    // below is the point where a missing or stale source cache is built.
    const { binary } = await resolveArtifacts({ allowBuild: false });
    ({ stdout } = await exec(binary, ['--status'], {
      timeout: REMOTE_DESKTOP_OFFER_BUDGET.platformStatusMs,
      maxBuffer: 1024,
      windowsHide: true,
    }));
  } catch (error) {
    if (error instanceof WindowsDesktopArtifactsMissing) return 'missing';
    log.warn(
      'status failed',
      readWindowsDesktopDetail((error as { stdout?: unknown })?.stdout) ?? error,
    );
    return 'unavailable';
  }
  const status = stdout.trim().split(' ')[0];
  if (status === 'ready') {
    try {
      const connection = await openWindowsDesktopConnection({ mode: 'probe' });
      connection.close();
    } catch (error) {
      log.warn('service is running but refused a pipe probe', error);
      return 'missing';
    }
    return 'ready';
  }
  if (status === 'missing') return 'missing';
  // Anything else means the helper could not even work out where it would
  // install — a broken or incomplete copy of Cindy rather than a setup the
  // user can complete, so it reads as unavailable with the step in the log.
  log.warn('lock-screen setup unavailable:', readWindowsDesktopDetail(stdout) ?? status);
  return 'unavailable';
}

export async function configureWindowsDesktopSupport(enabled: boolean): Promise<void> {
  if (process.platform !== 'win32') throw new WindowsDesktopSetupError();
  log.info(enabled ? 'installing the lock-screen service' : 'removing the lock-screen service');
  try {
    const { binary } = await resolveArtifacts();
    const args = enabled
      ? ['--elevate-install', String(process.pid), ...(app.isPackaged ? [] : ['--development'])]
      : ['--elevate-uninstall'];
    await exec(binary, args, { timeout: 130_000, maxBuffer: 1024, windowsHide: true });
  } catch (error) {
    const detail = readWindowsDesktopDetail((error as { stdout?: unknown })?.stdout);
    log.warn('lock-screen setup failed:', detail ?? error);
    throw new WindowsDesktopSetupError(detail);
  }
  if (enabled) {
    const support = await readWindowsDesktopSupport();
    if (support !== 'ready') {
      log.warn('lock-screen setup finished but the service reports', support);
      throw new WindowsDesktopSetupError();
    }
  }
  log.info('lock-screen service', enabled ? 'installed' : 'removed');
}

export async function openWindowsDesktopConnection(
  init:
    | { mode: 'input' | 'probe' }
    | { mode: 'capture'; rect: number[]; cursorOverlay?: boolean; bitrate?: number },
): Promise<WindowsDesktopConnection> {
  if (process.platform !== 'win32') throw new Error('DESKTOP_SYSTEM_SERVICE_UNAVAILABLE');
  const { binary, addon } = await resolveArtifacts();
  // Fixed packaged Node-API addon, loaded only by Main. It opens the pipe in
  // this process and checks the SCM service identity before sending anything.
  const native = requireNative(addon) as {
    DesktopConnection: { open(binary: string, init: string): Promise<WindowsDesktopConnection> };
  };
  return native.DesktopConnection.open(binary, JSON.stringify(init));
}
