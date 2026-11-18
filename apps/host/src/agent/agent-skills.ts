/**
 * `/api/agent-skills`, the Host's `maker:list-agent-skills` (release table row 25, 25b; L1).
 *
 * As the desktop (maker-ipc/register.ts LIST_AGENT_SKILLS): refresh the shared global Skills first
 * (Claude and Pi; Codex's own asset step is 25c), then list through `maker.listAgentSkills` with the
 * request's disabled-Skill reader, so a Skill the user switched off is not offered. The Host used to
 * call the engine's own scan, which skips that filter (L1, type A).
 *
 * While a desktop that opens this profile's database is running, the shared Skill roots belong to it:
 * the refresh is skipped and the list shows what is already there (reviewer decision, 2026-11-17).
 */
import path from 'node:path';

import type { AgentKind, Maker } from '@cindy/maker-core';

import { builtInSkillDescriptorsAsync } from '../../../desktop/src/main/maker-host/built-in-skills.ts';
import { readDisabledSkillPaths } from '../../../desktop/src/main/skillhub/activationPreferences.ts';
import { getAppDataDir, getUserDataDir } from '../../../desktop/src/main/userDataPath.ts';

export interface HostAgentSkillListPorts {
  maker(): Pick<Maker, 'listAgentSkills'> | null;
  hasAgent(kind: AgentKind): boolean;
  readStoredWorkDir(sessionId: string): Promise<{ found: boolean; workDir?: string | null }>;
  /** The input queue's desktop hold; true while a desktop uses this profile. */
  isProfileHeld(): boolean;
  ensureSharedGlobalSkills(): Promise<void>;
}

export function createHostAgentSkillList(ports: HostAgentSkillListPorts) {
  return async (input: { agentKind?: string; workingDir?: string; sessionId?: string; forceReload?: boolean }) => {
    const rawKind = String(input.agentKind ?? '');
    const kind: AgentKind = rawKind === 'codex' ? 'codex' : rawKind === 'pi' ? 'pi' : 'claude-code';
    const maker = ports.maker();
    if (!maker || !ports.hasAgent(kind)) return { success: false, error: `Agent '${kind}' is not registered` };
    const stored = input.sessionId ? await ports.readStoredWorkDir(input.sessionId) : null;
    if (input.sessionId && !stored?.found) throw new Error('session not found');
    const workingDir = stored?.workDir || input.workingDir || undefined;
    if (workingDir && !path.isAbsolute(workingDir)) throw new Error('workingDir must be absolute');
    if (kind !== 'codex' && !ports.isProfileHeld()) await ports.ensureSharedGlobalSkills();
    // The desktop's readActivation: the verified built-in descriptors, then the disabled paths.
    const readDisabled = async () => readDisabledSkillPaths(await builtInSkillDescriptorsAsync(getUserDataDir(), getAppDataDir()));
    const result = await maker.listAgentSkills(kind, {
      ...(workingDir ? { workingDir } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(kind === 'pi' && input.forceReload === true && !ports.isProfileHeld() ? { forceReload: true } : {}),
    }, readDisabled);
    return { success: true, skills: result.skills ?? [] };
  };
}
