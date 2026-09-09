import fs from 'node:fs';
import path from 'node:path';

type FixedDirectoryFileSystem = Pick<typeof fs.promises, 'lstat' | 'mkdir'>;

export interface FixedDirectoryStats {
  bytes: number;
  fileCount: number;
}

export type FixedDirectoryStatsFileSystem = Pick<typeof fs.promises, 'lstat' | 'readdir'>;

const MAX_CREATE_ATTEMPTS = 2;

export interface OpenFixedDirectoryOptions {
  canOpen?: () => boolean;
  fileSystem?: FixedDirectoryFileSystem;
  openPath: (filePath: string) => Promise<string>;
}

export async function openOrCreateFixedDirectory(
  rootDir: string,
  options: OpenFixedDirectoryOptions,
): Promise<boolean> {
  const canOpen = options.canOpen ?? (() => true);
  const fileSystem = options.fileSystem ?? fs.promises;
  const lstatIfExists = async () => {
    try {
      return await fileSystem.lstat(rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    }
  };

  let stat = await lstatIfExists();
  for (let attempt = 0; stat === null && attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
    if (!canOpen()) throw new Error('fixed directory owner changed before open');
    await fileSystem.mkdir(rootDir, { recursive: true });
    stat = await lstatIfExists();
  }

  if (stat === null) return false;
  if (!stat.isDirectory()) return false;
  if (!canOpen()) throw new Error('fixed directory owner changed before open');

  const error = await options.openPath(rootDir);
  if (error) {
    if ((await lstatIfExists()) === null) return false;
    throw new Error(error);
  }
  return true;
}

/** Read the size of a fixed cache directory without following symlinks. */
export async function getFixedDirectoryStats(
  rootDir: string,
  fileSystem: FixedDirectoryStatsFileSystem = fs.promises,
): Promise<FixedDirectoryStats> {
  const walk = async (directory: string): Promise<FixedDirectoryStats> => {
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = (await fileSystem.readdir(directory, { withFileTypes: true })) as Array<{
        name: string;
        isDirectory(): boolean;
      }>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { bytes: 0, fileCount: 0 };
      throw error;
    }
    let bytes = 0;
    let fileCount = 0;
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = await walk(child);
        bytes += nested.bytes;
        fileCount += nested.fileCount;
        continue;
      }
      try {
        const stat = await fileSystem.lstat(child);
        if (stat.isFile()) {
          bytes += stat.size;
          fileCount += 1;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
    }
    return { bytes, fileCount };
  };

  return walk(rootDir);
}
