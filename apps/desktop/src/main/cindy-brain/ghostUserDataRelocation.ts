import fs from 'node:fs';
import path from 'node:path';

const USER_DATA_PATHS = [
  ['ghost-kv', '.json'],
  ['ghost-fs', ''],
  ['libraries', ''],
  ['library-staging', ''],
] as const;

const USER_DATA_REFERENCES = [
  'secrets',
  'libraryBinding',
  'libraryMeta',
  'workdirPreferences',
  'cindyPreferences',
  'errandPreferences',
  'pickedDirectories',
  'media',
  'cards',
  'unread',
] as const;

type RelocateReference = (fromPart: string, toPart: string) => void | Promise<unknown>;

export type GhostUserDataRelocationResources = Record<
  (typeof USER_DATA_REFERENCES)[number],
  RelocateReference
> & {
  userDataPath: (...parts: string[]) => string;
  assertCurrent: () => void;
};

export function ghostUserDataRelocationPaths(
  fromPart: string,
  toPart: string,
  userDataPath: GhostUserDataRelocationResources['userDataPath'],
): Array<{ from: string; to: string }> {
  return USER_DATA_PATHS.map(([directory, suffix]) => ({
    from: userDataPath(directory, fromPart + suffix),
    to: userDataPath(directory, toPart + suffix),
  }));
}

export function assertGhostUserDataPathsCanRelocate(
  paths: Array<{ from: string; to: string }>,
): void {
  for (const move of paths) {
    if (fs.lstatSync(move.from, { throwIfNoEntry: false }) &&
        fs.lstatSync(move.to, { throwIfNoEntry: false })) {
      throw new Error(`relocate destination already exists: ${move.to}`);
    }
  }
}

export async function relocateGhostUserDataResources(
  fromPart: string,
  toPart: string,
  resources: GhostUserDataRelocationResources,
): Promise<void> {
  if (fromPart === toPart) return;
  resources.assertCurrent();
  const paths = ghostUserDataRelocationPaths(fromPart, toPart, resources.userDataPath);
  assertGhostUserDataPathsCanRelocate(paths);
  for (const move of paths) {
    resources.assertCurrent();
    if (!fs.lstatSync(move.from, { throwIfNoEntry: false })) continue;
    fs.mkdirSync(path.dirname(move.to), { recursive: true });
    fs.renameSync(move.from, move.to);
  }
  for (const resource of USER_DATA_REFERENCES) {
    resources.assertCurrent();
    await resources[resource](fromPart, toPart);
  }
  resources.assertCurrent();
}
