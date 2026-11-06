/**
 * `maker:list-agent-skills` crosses two trusted Main-owned entry paths:
 * a registered Cindy app Renderer, or an authenticated device-link invoke context.
 * Renderer payload fields never participate in that decision.
 */

export const AGENT_SKILL_LIST_FAILURE_MESSAGE = 'Unable to load agent skills';

export interface AgentSkillListFailure {
  success: false;
  error: typeof AGENT_SKILL_LIST_FAILURE_MESSAGE;
  skills: [];
}

interface AgentSkillListCallerBoundaryDeps {
  isDeviceLinkInvoke(): boolean;
  assertTrustedSender(event: unknown): void;
}

interface AgentSkillListFailureBoundaryDeps {
  reportError(error: unknown): void;
}

export function assertAgentSkillListIpcCaller(
  event: unknown,
  deps: AgentSkillListCallerBoundaryDeps,
): void {
  // A synthetic device-link event has no Electron sender. Its authority comes
  // only from dispatch.ts' authenticated Main-owned async context.
  if (!deps.isDeviceLinkInvoke()) {
    deps.assertTrustedSender(event);
  }
}

export function toAgentSkillListFailure(
  error: unknown,
  deps: AgentSkillListFailureBoundaryDeps,
): AgentSkillListFailure {
  deps.reportError(error);
  return {
    success: false,
    error: AGENT_SKILL_LIST_FAILURE_MESSAGE,
    skills: [],
  };
}

/** Palette-only work sharing. Do not use this inside a Skill install/uninstall
 * lease: those callers own separate mutation authority. Nothing survives settle. */
export function createProjectSkillPreparation(prepare: (workingDir: string) => Promise<boolean>) {
  const pending = new Map<string, Promise<boolean>>();
  return (ownerScope: string, workingDir: string): Promise<boolean> => {
    const key = JSON.stringify([ownerScope, workingDir]);
    const existing = pending.get(key);
    if (existing) return existing;
    const promise = prepare(workingDir).finally(() => {
      if (pending.get(key) === promise) pending.delete(key);
    });
    pending.set(key, promise);
    return promise;
  };
}
