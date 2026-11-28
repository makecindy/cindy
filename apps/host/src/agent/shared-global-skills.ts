/**
 * The desktop's shared global Skill preparation on the Host (release table row 25, 25b): the built-in
 * Skill bundle this Host carries (user decision: the personal Host ships its own copy), the legacy
 * built-in link migration and the shared home-level Skill links, through the same core
 * (maker-host/sharedGlobalSkillsPreparationCore.ts) and the same stable-owner boundary. The Host
 * binds the desktop's own preparation scope, its configured profile and app-data roots, and the
 * bundle root of its layout.
 *
 * While a desktop that opens this profile's database is running (coexistence plan A, the input
 * queue's hold), the shared projections belong to that desktop: preparation is skipped, nothing is
 * written, and callers carry on with what is already there (reviewer decision, 2026-11-17).
 */
import {
  createSharedGlobalSkillsPreparation,
  preparationScope,
  type SharedGlobalSkillsPreparationPorts,
} from '../../../desktop/src/main/maker-host/sharedGlobalSkillsPreparationCore.ts';
import { markClaudeSessionObserved } from '../../../desktop/src/main/maker-host/shared-global-skills.ts';
import { getAppDataDir, getUserDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { explicitPorts } from './explicit-ports.ts';

export interface HostSharedGlobalSkills {
  /** Refresh unless a desktop holds the profile; resolves either way (failures are logged by the core). */
  ensureSharedGlobalSkills(): Promise<void>;
  /** The desktop's Claude getAuthEnv step: a Claude CLI is about to start, then refresh. */
  beforeClaudeLaunch(): Promise<void>;
}

export function createHostSharedGlobalSkills(ports: {
  /** The input queue's desktop hold (main.ts profileHold); true while a desktop uses the profile. */
  isProfileHeld(): boolean;
  /** The built-in Skill bundle of this Host (runtime-layout.mjs systemSkillsDir). */
  bundledSystemSkillsRoot(): string;
}): HostSharedGlobalSkills {
  const preparation = createSharedGlobalSkillsPreparation(explicitPorts<SharedGlobalSkillsPreparationPorts>({
    preparationScope,
    bundledSystemSkillsRoot: () => ports.bundledSystemSkillsRoot(),
    userDataDir: () => getUserDataDir(),
    appDataDir: () => getAppDataDir(),
  }));
  const ensureSharedGlobalSkills = async () => {
    if (ports.isProfileHeld()) return;
    await preparation.ensureSharedGlobalSkills();
  };
  return {
    ensureSharedGlobalSkills,
    async beforeClaudeLaunch() {
      // As the desktop's DesktopClaudeAuthAdapter.getAuthEnv: opening the ~/.claude/skills projection
      // gate (#9282) comes first, even for a session whose ~/.claude does not exist yet.
      markClaudeSessionObserved();
      await ensureSharedGlobalSkills();
    },
  };
}
