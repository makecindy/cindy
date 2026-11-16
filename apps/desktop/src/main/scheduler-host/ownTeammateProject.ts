/**
 * Whether a folder is the project of one of this account's teammates, and that teammate's state.
 * The path shape alone (@cindy/maker-shared/teammate-project) only labels a folder for display;
 * trusting a folder (no import prompt, runs skipped) needs it to be a real teammate project here.
 */
import path from 'node:path';

import { teammateFolderOfProjectPath } from '@cindy/maker-shared/teammate-project';

import { ownerScopedUserDataPath } from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import { botProfiles } from '../localDb/schema.js';
import { teammateWorkspaceDir } from '../maker-ipc/botProjectMemory.js';

/** `stopped`: the teammate is paused, archived or being deleted; `deleted`: it no longer exists. */
export type TeammateProjectState = 'active' | 'stopped' | 'deleted';

function sameDir(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** null: not a teammate project of this account (an ordinary folder, whatever its path looks like). */
export async function ownTeammateProjectState(workingDir: string | null | undefined): Promise<TeammateProjectState | null> {
  if (!workingDir || !teammateFolderOfProjectPath(workingDir)) return null;
  const root = ownerScopedUserDataPath();
  const rows = await getDbClient().drizzle
    .select({ id: botProfiles.id, status: botProfiles.status }).from(botProfiles);
  const row = rows.find(profile => sameDir(teammateWorkspaceDir(root, profile.id), workingDir));
  if (row) return row.status === 'active' || row.status === 'error' ? 'active' : 'stopped';
  // Still in this account's teammates folder, but its teammate is gone.
  return sameDir(path.dirname(path.dirname(workingDir)), path.join(root, 'bots')) ? 'deleted' : null;
}
