import fs from 'node:fs';

type FixedDirectoryFileSystem = Pick<typeof fs.promises, 'lstat' | 'mkdir'>;

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
  let stat: Awaited<ReturnType<FixedDirectoryFileSystem['lstat']>>;

  try {
    stat = await fileSystem.lstat(rootDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    if (!canOpen()) throw new Error('fixed directory owner changed before open');
    await fileSystem.mkdir(rootDir, { recursive: true });
    stat = await fileSystem.lstat(rootDir);
  }

  if (!stat.isDirectory()) return false;
  if (!canOpen()) throw new Error('fixed directory owner changed before open');

  const error = await options.openPath(rootDir);
  if (error) throw new Error(error);
  return true;
}
