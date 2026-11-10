import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const binaryName = 'cindy-windows-atomic-rename.exe';
let resolvingBinary: Promise<string> | undefined;

export interface WindowsAtomicRenamePaths {
  packagedBinary?: string;
  sourceFile?: string;
  cacheDir: string;
}
let configuredPaths: WindowsAtomicRenamePaths | undefined;
/** The launcher supplies paths before starting any file-writing services. */
export function configureWindowsAtomicRename(paths: WindowsAtomicRenamePaths): void {
  configuredPaths = { ...paths };
  resolvingBinary = undefined;
}

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
  const paths = configuredPaths;
  if (!paths) throw new Error('Windows atomic rename paths are not configured');
  if (paths.packagedBinary) return paths.packagedBinary;
  const target = windowsTarget();
  const source = paths.sourceFile;
  if (!source) throw new Error('Windows atomic rename source is not configured');
  const sourceBytes = await fs.readFile(source);
  const digest = createHash('sha256').update(target).update(sourceBytes).digest('hex');
  const directory = path.join(paths.cacheDir, digest);
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
    await promisify(execFile)(await resolveRustc(), [
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
  await promisify(execFile)(binary, [source, destination], {
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
}
