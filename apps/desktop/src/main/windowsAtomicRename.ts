import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';

const exec = promisify(execFile);
const binaryName = 'cindy-windows-atomic-rename.exe';
let resolvingBinary: Promise<string> | undefined;

function windowsTarget(): string {
  if (process.arch === 'arm64') return 'aarch64-pc-windows-msvc';
  if (process.arch === 'x64') return 'x86_64-pc-windows-msvc';
  throw new Error(`Unsupported Windows atomic rename architecture: ${process.arch}`);
}

async function resolveRustc(): Promise<string> {
  const userRustc = path.join(os.homedir(), '.cargo', 'bin', 'rustc.exe');
  return fs.access(userRustc).then(() => userRustc, () => 'rustc');
}

async function resolveBinary(): Promise<string> {
  if (process.platform !== 'win32') throw new Error('Windows atomic rename is Windows-only');
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'tools', 'windows-atomic-rename', binaryName);
  }
  const target = windowsTarget();
  const source = path.join(app.getAppPath(), 'native', 'windows-atomic-rename', 'main.rs');
  const sourceBytes = await fs.readFile(source);
  const digest = createHash('sha256').update(target).update(sourceBytes).digest('hex');
  const directory = path.join(app.getPath('userData'), 'windows-atomic-rename', digest);
  const binary = path.join(directory, binaryName);
  try {
    await fs.access(binary);
    return binary;
  } catch {
    // Development only: compile this exact source version outside the checkout.
  }

  const buildDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-atomic-rename-build-'));
  const built = path.join(buildDirectory, binaryName);
  try {
    await exec(await resolveRustc(), [
      source,
      '--edition=2021',
      '-C', 'opt-level=s',
      '-C', 'panic=abort',
      '--target', target,
      '-o', built,
    ], { timeout: 180_000, windowsHide: true });
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `${binaryName}.${process.pid}.tmp`);
    try {
      await fs.copyFile(built, temporary);
      await fs.rename(temporary, binary).catch(async (error: unknown) => {
        await fs.access(binary).catch(() => { throw error; });
      });
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return binary;
  } finally {
    await fs.rm(buildDirectory, { recursive: true, force: true });
  }
}

export async function atomicReplaceWindowsDirectoryEntry(
  source: string,
  destination: string,
): Promise<void> {
  const binary = await (resolvingBinary ??= resolveBinary());
  await exec(binary, [source, destination], {
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
}
