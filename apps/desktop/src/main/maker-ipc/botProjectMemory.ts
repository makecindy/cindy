/**
 * Where a teammate's durable memories are. A V2 teammate (a project, botProjectMode.ts) keeps its
 * memory inside its own project, `workspace/.cindy/memory/`, versioned by the project's Git; its
 * old `memories/` folder stays as the V1 archive. Only teammate projects do this: an ordinary
 * project's memory stays outside its folder (`<owner>/maker-memory/<scope>`), never in a user's
 * repository. Shared by the memory store (maker-memory-host.ts), the V2 upgrade and cloud companions.
 */
import { lstatSync, promises as fs } from 'node:fs';
import path from 'node:path';

import { MemoryError, memoryScopeDirName, resolveMemoryScopeKey } from '@cindy/maker-core';
import { teammateFolderOfProjectPath } from '@cindy/maker-shared/teammate-project';

import { botProfileDir, botProfileMemoryDir } from './botProfileFolder.js';

/** Written once the V2 upgrade finished on this computer (botV2Migration.ts). */
export const TEAMMATE_V2_RECEIPT_FILE = 'v2-migration.json';
/** Written once the teammate's project memory moved into its project folder (botProjectMode.ts). */
export const TEAMMATE_MEMORY_MOVE_RECEIPT_FILE = 'project-memory-move.json';
/** The memory folder, relative to the teammate's project. */
export const TEAMMATE_PROJECT_MEMORY_SEGMENTS = ['.cindy', 'memory'] as const;

/** Derived files beside the records: USER.md travels inside the profile, MEMORY.md is a rebuilt index. */
const DERIVED_MEMORY_FILES = new Set(['USER.md', 'MEMORY.md']);

export function teammateWorkspaceDir(ownerRoot: string, botId: string): string {
  return path.join(botProfileDir(ownerRoot, botId), 'workspace');
}

/** Where the teammate project at `workspace` keeps its memory. */
export function teammateProjectMemoryDir(workspace: string): string {
  return path.join(workspace, ...TEAMMATE_PROJECT_MEMORY_SEGMENTS);
}

/** Where a teammate project's memory was before it moved into the project: outside, like any project's. */
export async function legacyTeammateProjectMemoryDir(ownerRoot: string, workspace: string): Promise<string> {
  return path.join(ownerRoot, 'maker-memory', memoryScopeDirName(await resolveMemoryScopeKey(workspace)));
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The teammate project a memory scope is, when it is one of this owner's; null for any other scope. */
export function teammateProjectOfScope(scopeKey: string, ownerRoot: string): string | null {
  if (!teammateFolderOfProjectPath(scopeKey)) return null;
  const workspace = path.resolve(scopeKey);
  return samePath(path.dirname(path.dirname(workspace)), path.join(path.resolve(ownerRoot), 'bots')) ? workspace : null;
}

/**
 * The memory store's folder for a memory scope that is a teammate project of this owner, or null
 * for every other scope (they keep the store's default place). The folder sits in a project its
 * tasks edit with their own file tools, so a link in its place is refused: it would point the
 * host's writes somewhere else.
 */
export function teammateProjectMemoryStorageDir(scopeKey: string, ownerRoot: string): string | null {
  const workspace = teammateProjectOfScope(scopeKey, ownerRoot);
  return workspace ? unlinkedTeammateProjectMemoryDir(workspace) : null;
}

/** The project's memory folder; throws when it (or `.cindy`) is a link instead of a folder. */
export function unlinkedTeammateProjectMemoryDir(workspace: string): string {
  const memory = teammateProjectMemoryDir(workspace);
  for (const dir of [path.dirname(memory), memory]) {
    let linked = false;
    try {
      linked = lstatSync(dir).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (linked) throw new MemoryError('not-ready', 'the teammate memory folder is a link; refusing to use it');
  }
  return memory;
}

async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => true, () => false);
}

/** The teammate finished its V2 upgrade here: its memories and skills were copied into the project. */
export async function hasTeammateUpgraded(ownerRoot: string, botId: string): Promise<boolean> {
  return exists(path.join(botProfileDir(ownerRoot, botId), TEAMMATE_V2_RECEIPT_FILE));
}

/** The teammate's project memory moved into its project folder here (once). */
export async function hasTeammateMemoryMoved(ownerRoot: string, botId: string): Promise<boolean> {
  return exists(path.join(botProfileDir(ownerRoot, botId), TEAMMATE_MEMORY_MOVE_RECEIPT_FILE));
}

/**
 * The folders a teammate's memories are read from, first one wins. A V2 teammate: its project's
 * memory folder; until the one-time move finished also the project memory's earlier place outside
 * the folder, and until its upgrade finished also its old folder (a memory not copied yet must not
 * look deleted). A V1 teammate: its old folder. The project's memory folder (or `.cindy`) being a
 * link throws, as for the memory store: the cloud upload must not read whatever it points to, and
 * a failed read keeps the uploaded memories as they are.
 */
export async function teammateMemoryDirs(ownerRoot: string, botId: string, projectMode: boolean): Promise<string[]> {
  const old = botProfileMemoryDir(ownerRoot, botId);
  if (!projectMode) return [old];
  const workspace = teammateWorkspaceDir(ownerRoot, botId);
  const dirs = [unlinkedTeammateProjectMemoryDir(workspace)];
  if (!await hasTeammateMemoryMoved(ownerRoot, botId)) dirs.push(await legacyTeammateProjectMemoryDir(ownerRoot, workspace));
  if (!await hasTeammateUpgraded(ownerRoot, botId)) dirs.push(old);
  return dirs;
}

/**
 * Every memory record in `dirs` by file name, the first folder winning. Only a missing folder is
 * "no memories": any other read error throws, so nothing merely unreadable looks deleted.
 */
export async function readTeammateMemories(dirs: string[]): Promise<Array<{ filename: string; content: string }>> {
  const found = new Map<string, string>();
  for (const dir of dirs) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.') || DERIVED_MEMORY_FILES.has(entry.name)) continue;
      if (found.has(entry.name)) continue;
      found.set(entry.name, await fs.readFile(path.join(dir, entry.name), 'utf8'));
    }
  }
  return [...found].map(([filename, content]) => ({ filename, content }));
}

/** One memory record as the teammate has it now (the same folders, first one wins); null when it has none. */
export async function readTeammateMemory(dirs: string[], filename: string): Promise<string | null> {
  for (const dir of dirs) {
    const file = path.join(dir, filename);
    try {
      if (!(await fs.lstat(file)).isFile()) continue;
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
  }
  return null;
}
