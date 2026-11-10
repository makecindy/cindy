import { readDisabledSkillPathsForListing, skillActivationKey } from '../skillhub/activationPreferences.js';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import matter from 'gray-matter';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';
import type { AgentDeps } from '@cindy/maker-core';
import { builtInSkillDescriptorsAsync, sharedBuiltInSkillsRoot } from './built-in-skills.js';
import { getGhostManager, listAvailableGhostsAsync, loadGhostFirstPartyFactsForGhost } from '../cindy-brain/index.js';
import { withSharedGlobalSkillProjectionMutation } from '../authBoundaryQuarantine.js';
import { prepareCodexGlobalSkillsLinks } from './codex-global-skills.js';
import { hasTrustedFirstPartySource, isTrustedPublicCindyResource } from '../cindy-brain/ghostFirstPartyPrivilege.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';

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
  return [app.getPath('userData'), sharedBuiltInSkillsRoot(app.getPath('appData'))];
}

type ManagedSkill = Awaited<ReturnType<NonNullable<AgentDeps['getManagedSkills']>>>[number] & { cindyOfficial: boolean };

export const listCindyManagedSkills = async (): Promise<ManagedSkill[]> => {
  const owner = activeOwnerScopeKey();
  if (isAppSessionBoundaryPending()) throw new Error('Skill owner is changing');
  const builtIns = await builtInSkillDescriptorsAsync(app.getPath('userData'), app.getPath('appData'));
  const skills: ManagedSkill[] = [];
  const addSkill = (directory: string, name: string, namespace: string, cindyOfficial: boolean, description?: string) => {
    try {
      // Bind the verified source itself, not a mutable discovery projection.
      const file = fs.realpathSync.native(path.join(directory, 'SKILL.md'));
      const { data } = matter(fs.readFileSync(file, 'utf8'));
      skills.push({
        kind: 'agent-skill',
        cindyOfficial,
        name,
        description:
          description ??
          (typeof data.description === 'string' ? data.description.trim() : undefined),
        source: 'skill',
        scope: 'user',
        path: file,
        enabled: true,
        claudeCommandName: `${namespace}:${name}`,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  for (const skill of builtIns) addSkill(skill.absolutePath, skill.name, 'cindy', true);
  // Reuse receipt verification. Occupants preserved in the projection directory
  // (real directories, foreign links, stale slots) are not an approval catalog.
  const manager = getGhostManager();
  for (const ghost of await listAvailableGhostsAsync()) {
    if (
      !ghost.enabled ||
      !ghost.approvedSkillRoot ||
      !(await manager.verifyApprovedSkillSnapshot(ghost))
    )
      continue;
    const loaded = loadGhostFirstPartyFactsForGhost(installedGhostStoragePart(ghost), 'runtime');
    const cindyOfficial = loaded.kind === 'ready' && loaded.facts.installOrigin === 'manual' &&
      loaded.facts.namespace === null && (isTrustedPublicCindyResource(loaded.facts) ||
        (loaded.facts.builtin && loaded.facts.trustedSource?.kind === 'builtin-official' &&
          hasTrustedFirstPartySource(loaded.facts)));
    for (const item of ghost.manifest.skill?.items ?? []) {
      addSkill(
        path.join(ghost.approvedSkillRoot, item.dir),
        item.name,
        `cindy-plugin-${installedGhostStoragePart(ghost)}`,
        cindyOfficial,
        item.description,
      );
    }
  }
  if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending())
    throw new Error('Skill owner changed during discovery');
  return skills;
};

/** Attest from the actual installed source, never from a name or skill frontmatter. */
export async function markCindyOfficialSkills<T extends { path?: string }>(
  skills: readonly T[], remoteHostId?: string,
): Promise<Array<T & { cindyOfficial: boolean; enabled?: boolean }>> {
  // SSH paths belong to that machine; local installations cannot attest them.
  const officialPaths = new Set(remoteHostId ? [] :
    (await listCindyManagedSkills()).filter(skill => skill.cindyOfficial).map(skill => skill.path));
  const disabled = new Set(remoteHostId ? [] : readDisabledSkillPathsForListing());
  return skills.map(skill => {
    let cindyOfficial = false;
    // Attest by the resolved file, but keep the discovered path as the Skill's identity:
    // a task frozen with the lexical (symlink) path must still match it on resume.
    if (!remoteHostId && skill.path) {
      try {
        cindyOfficial = officialPaths.has(fs.realpathSync.native(skill.path));
      } catch { /* Missing source. */ }
    }
    return { ...skill, cindyOfficial,
      ...(!remoteHostId && skill.path && disabled.has(skillActivationKey(skill.path)) ? { enabled: false } : {}),
    };
  });
}
