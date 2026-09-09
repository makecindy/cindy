import fs from 'node:fs';

type FixedDirectoryFileSystem = Pick<typeof fs.promises, 'lstat' | 'mkdir'>;

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
