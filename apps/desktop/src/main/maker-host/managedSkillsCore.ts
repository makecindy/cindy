import { readDisabledSkillPathsForListing, skillActivationKey } from '../skillhub/activationPreferences.js';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';
import type { AgentDeps } from '@cindy/maker-core';
import { builtInSkillDescriptorsAsync, sharedBuiltInSkillsRoot } from './built-in-skills.js';
import { hasTrustedFirstPartySource, isTrustedPublicCindyResource } from '../cindy-brain/ghostFirstPartyPrivilege.js';
import type { GhostFirstPartyFactsLoad, GhostFirstPartyFactsPurpose } from '../cindy-brain/ghostFirstPartyFacts.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import type { InstalledGhost } from '../../shared/ghost.js';
import { getAppDataDir, getUserDataDir } from '../userDataPath.js';

/**
 * Cindy-managed Skills (built-in and approved plugin Skills), shared by Desktop
 * and the Node Host. Moved verbatim from managed-skills.ts; the plugin registry
 * reads arrive as ports and the two roots come from the injected directories.
 */
export interface ManagedSkillsPorts {
  /** Installed plugins available to the active owner (Desktop: listAvailableGhostsAsync). */
  listAvailableGhosts(): Promise<InstalledGhost[]>;
  /** Re-verifies an approved Skill snapshot against its install receipt. */
  getGhostManager(): { verifyApprovedSkillSnapshot(ghost: InstalledGhost): Promise<boolean> };
  /** First-party facts for a plugin instance (Desktop: loadGhostFirstPartyFactsForGhost). */
  loadGhostFirstPartyFactsForGhost(ghostId: string, purpose: GhostFirstPartyFactsPurpose): GhostFirstPartyFactsLoad;
}

export type ManagedSkill = Awaited<ReturnType<NonNullable<AgentDeps['getManagedSkills']>>>[number] & { cindyOfficial: boolean };

export function createManagedSkills(ports: ManagedSkillsPorts) {
  /** Ownership roots for retiring private Codex links, never directories to scan. */
  async function cindyManagedSkillRoots(): Promise<string[]> {
    return [getUserDataDir(), sharedBuiltInSkillsRoot(getAppDataDir())];
  }

  const listCindyManagedSkills = async (): Promise<ManagedSkill[]> => {
    const owner = activeOwnerScopeKey();
    if (isAppSessionBoundaryPending()) throw new Error('Skill owner is changing');
    const builtIns = await builtInSkillDescriptorsAsync(getUserDataDir(), getAppDataDir());
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
    const manager = ports.getGhostManager();
    for (const ghost of await ports.listAvailableGhosts()) {
      if (
        !ghost.enabled ||
        !ghost.approvedSkillRoot ||
        !(await manager.verifyApprovedSkillSnapshot(ghost))
      )
        continue;
      const loaded = ports.loadGhostFirstPartyFactsForGhost(installedGhostStoragePart(ghost), 'runtime');
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
  async function markCindyOfficialSkills<T extends { path?: string }>(
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

  return { cindyManagedSkillRoots, listCindyManagedSkills, markCindyOfficialSkills };
}
