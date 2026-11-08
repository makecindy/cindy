/**
 * Where a teammate's durable memories are. A V2 teammate (a project, botProjectMode.ts) uses its
 * project's memory, the same scope its tasks write; its old `memories/` folder stays as the V1
 * archive. Shared by the memory service, the V2 upgrade and cloud companions.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { memoryScopeDirName, resolveMemoryScopeKey } from '@cindy/maker-core';

import { botProfileDir, botProfileMemoryDir } from './botProfileFolder.js';

/** Written once the V2 upgrade finished on this computer (botV2Migration.ts). */
export const TEAMMATE_V2_RECEIPT_FILE = 'v2-migration.json';

/** Derived files beside the records: USER.md travels inside the profile, MEMORY.md is a rebuilt index. */
const DERIVED_MEMORY_FILES = new Set(['USER.md', 'MEMORY.md']);

export function teammateWorkspaceDir(ownerRoot: string, botId: string): string {
  return path.join(botProfileDir(ownerRoot, botId), 'workspace');
}

/** Where the project at `workspace` keeps its memory. */
export async function teammateProjectMemoryDir(ownerRoot: string, workspace: string): Promise<string> {
  return path.join(ownerRoot, 'maker-memory', memoryScopeDirName(await resolveMemoryScopeKey(workspace)));
}

/** The teammate finished its V2 upgrade here: its memories and skills were copied into the project. */
export async function hasTeammateUpgraded(ownerRoot: string, botId: string): Promise<boolean> {
  return fs.lstat(path.join(botProfileDir(ownerRoot, botId), TEAMMATE_V2_RECEIPT_FILE)).then(() => true, () => false);
}

/**
 * The folders a teammate's memories are read from, first one wins. A V2 teammate: its project
 * memory, and until its upgrade finished also its old folder (a memory not copied yet must not look
 * deleted). A V1 teammate: its old folder.
 */
export async function teammateMemoryDirs(ownerRoot: string, botId: string, projectMode: boolean): Promise<string[]> {
  const old = botProfileMemoryDir(ownerRoot, botId);
  if (!projectMode) return [old];
  const project = await teammateProjectMemoryDir(ownerRoot, teammateWorkspaceDir(ownerRoot, botId));
  return await hasTeammateUpgraded(ownerRoot, botId) ? [project] : [project, old];
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
