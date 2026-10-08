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
import { builtInSkillDescriptors, sharedBuiltInSkillsRoot } from './built-in-skills.js';
import { getGhostManager, listAvailableGhostsForAuthorization } from '../cindy-brain/index.js';
import { withSharedGlobalSkillProjectionMutation } from '../authBoundaryQuarantine.js';
import { prepareCodexGlobalSkillsLinks } from './codex-global-skills.js';

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

export const listCindyManagedSkills: NonNullable<AgentDeps['getManagedSkills']> = async () => {
  const owner = activeOwnerScopeKey();
  if (isAppSessionBoundaryPending()) throw new Error('Skill owner is changing');
  const builtIns = builtInSkillDescriptors(app.getPath('userData'), app.getPath('appData'));
  const skills: Awaited<ReturnType<NonNullable<AgentDeps['getManagedSkills']>>> = [];
  const addSkill = (directory: string, name: string, namespace: string, description?: string) => {
    try {
      // Bind the verified source itself, not a mutable discovery projection.
      const file = fs.realpathSync.native(path.join(directory, 'SKILL.md'));
      const { data } = matter(fs.readFileSync(file, 'utf8'));
      skills.push({
        kind: 'agent-skill',
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
  for (const skill of builtIns) addSkill(skill.absolutePath, skill.name, 'cindy');
  // Reuse receipt verification. Occupants preserved in the projection directory
  // (real directories, foreign links, stale slots) are not an approval catalog.
  const manager = getGhostManager();
  for (const ghost of listAvailableGhostsForAuthorization()) {
    if (
      !ghost.enabled ||
      !ghost.approvedSkillRoot ||
      !(await manager.verifyApprovedSkillSnapshot(ghost))
    )
      continue;
    for (const item of ghost.manifest.skill?.items ?? []) {
      addSkill(
        path.join(ghost.approvedSkillRoot, item.dir),
        item.name,
        `cindy-plugin-${ghost.manifest.id}`,
        item.description,
      );
    }
  }
  if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending())
    throw new Error('Skill owner changed during discovery');
  return skills;
};
