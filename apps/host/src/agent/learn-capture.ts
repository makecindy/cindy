import os from 'node:os';
import path from 'node:path';
import type { Maker } from '@cindy/maker-core';
import { createCindyLearnInvocationCapture } from '../../../desktop/src/main/learn-host/captureInvocation.js';
import { canGrantUnqualifiedClaudeLearnInvocation } from '../../../desktop/src/main/learn-host/invocationGrant.js';
import { builtInSkillDescriptors } from '../../../desktop/src/main/maker-host/built-in-skills.js';
import { isCindySkillEnabled } from '../../../desktop/src/main/skillhub/activationPreferences.js';
import { getAppDataDir, getUserDataDir } from '../../../desktop/src/main/userDataPath.js';

type LearnMaker = Pick<Maker, 'getSession' | 'listAgentRuntimeSkills' | 'listAgentSkills'>;

/**
 * The trusted /learn Skill snapshot of a persisted user turn, with the desktop's
 * dependencies one for one (maker-ipc/register.ts captureCindyLearnInvocation). The
 * shared send transaction pins it for the engine and records it on the user message.
 * Its consumer, start_skill_learning, is not on the Host yet (release table row 18).
 */
export function createHostLearnInvocationCapture(options: { getMaker(): LearnMaker }) {
  return createCindyLearnInvocationCapture({
    getSession: sessionId => options.getMaker().getSession(sessionId),
    // The built-in Skills the desktop last published (release table rows 2b and 25).
    builtInSkillDescriptors: () => builtInSkillDescriptors(getUserDataDir(), getAppDataDir()),
    isSkillEnabled: isCindySkillEnabled,
    canGrantUnqualifiedClaudeInvocation: canGrantUnqualifiedClaudeLearnInvocation,
    listSkills: session => session.agentKind === 'claude-code'
      ? options.getMaker().listAgentRuntimeSkills(session.agentKind, {
        workingDir: session.workDir,
        sessionId: session.id,
        runtimeConfigDir: process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude'),
      })
      : options.getMaker().listAgentSkills(session.agentKind, {
        workingDir: session.workDir,
        sessionId: session.id,
      }),
  });
}
