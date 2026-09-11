import type { Session } from '@cindy/maker-core';
import type { FsSessionSnapshot } from '../cindy-brain/fsSlot.js';

/** Only live Session authority can authorize a plugin's workdir write, never the DB mirror. */
export function resolveGhostFsSessionSnapshot(
  getSession: (sessionId: string) => Session | undefined,
  sessionId: string,
  instanceId?: string,
): FsSessionSnapshot | null {
  const session = getSession(sessionId);
  if (!instanceId || !session || session.instanceId !== instanceId) return null;
  const permission = session.stablePermissionModeState;
  const plan = session.stablePlanModeState;
  if (!permission || !plan) return null;
  const workDir = session.workDir;
  const isCurrent = () => {
    const currentPlan = session.stablePlanModeState;
    return getSession(sessionId) === session
      && session.workDir === workDir
      && session.stablePermissionModeState?.generation === permission.generation
      && currentPlan?.generation === plan.generation
      && currentPlan.enabled === plan.enabled;
  };
  return {
    workingDir: workDir,
    remoteHostId: session.remoteHostId,
    permissionMode: permission.mode ?? 'ask',
    planModeEnabled: plan.enabled,
    isCurrent,
    reviewAction: async (action) => {
      const decision = await session.reviewHostPermissionAction(action);
      return isCurrent()
        ? decision
        : { verdict: 'block', reason: 'Task or permissions changed; retry with the current scope.' };
    },
  };
}
