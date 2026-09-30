import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';

const exec = promisify(execFile);
const requireFromMain = createRequire(__filename);
const binaryName = 'cindy-windows-taskbar.node';

/** Main-owned bridge: no renderer input, exported handles or additional IPC. */
export interface WindowsTaskbarNative {
  setOverlayIcon(handle: Buffer, png: Buffer | null, description: string): void;
  taskbarButtonCreatedMessage(): number;
}

let loading: Promise<WindowsTaskbarNative> | undefined;

export function loadWindowsTaskbarNative(): Promise<WindowsTaskbarNative> {
  // A missing compiler/addon must not trigger another build on every count change.
  return (loading ??= resolveBinary().then(
    (binary) => requireFromMain(binary) as WindowsTaskbarNative,
  ));
}

async function resolveBinary(): Promise<string> {
  if (process.platform !== 'win32') throw new Error('Windows taskbar is Windows-only');
  if (app.isPackaged)
    return path.join(process.resourcesPath, 'tools', 'windows-taskbar', binaryName);
  const target =
    process.arch === 'arm64'
      ? 'aarch64-pc-windows-msvc'
      : process.arch === 'x64'
        ? 'x86_64-pc-windows-msvc'
        : null;
  if (!target) throw new Error('Unsupported Windows taskbar architecture');
  const source = path.join(app.getAppPath(), 'native', 'windows-taskbar');
  const digest = createHash('sha256').update(target);
  for (const file of ['Cargo.toml', 'Cargo.lock', 'build.rs', path.join('src', 'lib.rs')]) {
    digest.update(await fs.readFile(path.join(source, file)));
  }
  const directory = path.join(app.getPath('userData'), 'windows-taskbar', digest.digest('hex'));
  const binary = path.join(directory, binaryName);
  try {
    await fs.access(binary);
    return binary;
  } catch {
    // Development only: compile this exact source version outside the checkout.
  }
  const buildDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-taskbar-build-'));
  try {
    const userCargo = path.join(os.homedir(), '.cargo', 'bin', 'cargo.exe');
    const cargo = await fs.access(userCargo).then(
      () => userCargo,
      () => 'cargo',
    );
    await exec(
      cargo,
      [
        'build',
        '--release',
        '--locked',
        '--target',
        target,
        '--manifest-path',
        path.join(source, 'Cargo.toml'),
        '--target-dir',
        buildDirectory,
      ],
      { timeout: 180_000, windowsHide: true },
    );
    await fs.mkdir(directory, { recursive: true });
    // Rename a complete copy; another dev instance may already have loaded its copy.
    const temporary = path.join(directory, `${binaryName}.${process.pid}.tmp`);
    try {
      await fs.copyFile(
        path.join(buildDirectory, target, 'release', 'cindy_windows_taskbar.dll'),
        temporary,
      );
      await fs.rename(temporary, binary).catch(async (error: unknown) => {
        await fs.access(binary).catch(() => {
          throw error;
        });
      });
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return binary;
  } finally {
    await fs.rm(buildDirectory, { recursive: true, force: true });
  }
}
