import { getGhostManager, listAvailableGhostsAsync, loadGhostFirstPartyFactsForGhost } from '../cindy-brain/index.js';
import {
  getActiveAppSession,
} from '../appSessionState.js';
import { withSharedGlobalSkillProjectionMutation } from '../authBoundaryQuarantine.js';
import { prepareCodexGlobalSkillsLinks } from './codex-global-skills.js';
import { createManagedSkills, type ManagedSkill } from './managedSkillsCore.js';

// The listing lives in managedSkillsCore.ts (shared with the Node Host); this
// module binds the desktop plugin registry and keeps the Codex projection.
// Ports resolve the cindy-brain functions when called, not when this module
// loads: the two modules import each other and this one is evaluated first.
const managedSkills = createManagedSkills({
  listAvailableGhosts: () => listAvailableGhostsAsync(),
  getGhostManager: () => getGhostManager(),
  loadGhostFirstPartyFactsForGhost: (id, purpose) => loadGhostFirstPartyFactsForGhost(id, purpose),
});

/** Reconcile the selected app-server home, including independently routed accounts. */
export async function prepareCindyCodexSkills(codexHome: string): Promise<void> {
  const ownerId = getActiveAppSession().dataOwnerId;
  await withSharedGlobalSkillProjectionMutation(ownerId, async () => {
    await prepareCodexGlobalSkillsLinks(codexHome, {
      managedRoots: await cindyManagedSkillRoots(),
      managedSkills: await listCindyManagedSkills(),
    });
  });
}

/** Ownership roots for retiring private Codex links, never directories to scan. */
export async function cindyManagedSkillRoots(): Promise<string[]> {
  return managedSkills.cindyManagedSkillRoots();
}

export const listCindyManagedSkills = (): Promise<ManagedSkill[]> => managedSkills.listCindyManagedSkills();

/** Attest from the actual installed source, never from a name or skill frontmatter. */
export async function markCindyOfficialSkills<T extends { path?: string }>(
  skills: readonly T[], remoteHostId?: string,
): Promise<Array<T & { cindyOfficial: boolean; enabled?: boolean }>> {
  return managedSkills.markCindyOfficialSkills(skills, remoteHostId);
}
