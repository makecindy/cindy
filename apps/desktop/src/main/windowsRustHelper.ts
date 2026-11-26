import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

export interface WindowsHelperPaths {
  packagedBinary?: string;
  sourceFile?: string;
  cacheDir: string;
}

function windowsTarget(): string {
  if (process.arch === 'arm64') return 'aarch64-pc-windows-msvc';
  if (process.arch === 'x64') return 'x86_64-pc-windows-msvc';
  throw new Error(`Unsupported Windows helper architecture: ${process.arch}`);
}

async function resolveRustc(): Promise<string> {
  const userRustc = path.join(os.homedir(), '.cargo', 'bin', 'rustc.exe');
  return fs.access(userRustc).then(() => userRustc, () => 'rustc');
}

async function resolveBinary(binaryName: string, paths?: WindowsHelperPaths): Promise<string> {
  if (process.platform !== 'win32') throw new Error(`${binaryName} is Windows-only`);
  if (!paths) throw new Error(`Paths not configured for ${binaryName}`);
  if (paths.packagedBinary) return paths.packagedBinary;
  const target = windowsTarget();
  const source = paths.sourceFile;
  if (!source) throw new Error(`Development source not configured for ${binaryName}`);
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

  const buildDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-windows-helper-build-'));
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

// Launchers supply trusted native source/resource paths for their own profile.
export function createWindowsHelperResolver(binaryName: string, config?: WindowsHelperPaths): () => Promise<string> {
  const paths = config && { ...config };
  let resolving: Promise<string> | undefined;
  return () => {
    if (!resolving) {
      resolving = resolveBinary(binaryName, paths).catch((error: unknown) => {
        // A compiler installed after the first attempt can serve later launches.
        resolving = undefined;
        throw error;
      });
    }
    return resolving;
  };
}
