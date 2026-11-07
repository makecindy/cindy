import fs from 'node:fs/promises';

/** Whether this computer holds anything of a companion that a merge must not skip: a profile (any status),
 * a task link (archived ones too: an inactive task may still hold unsent history) or a home directory entry.
 * Only an explicit false proves absence; any read error other than a missing directory is thrown. */
export async function companionHasLocalData(input: {
  hasProfile: () => Promise<boolean>;
  hasTaskLink: () => Promise<boolean>;
  directory: string;
  owner: () => string;
  lstat?: (target: string) => Promise<unknown>;
}): Promise<boolean> {
  const owner = input.owner();
  if (await input.hasProfile() || await input.hasTaskLink()) return true;
  try {
    await (input.lstat ?? fs.lstat)(input.directory); // Even an empty directory or broken symlink needs inspection.
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (input.owner() !== owner) throw new Error('OWNER_CHANGED');
    return false;
  }
}
