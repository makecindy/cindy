import type { Session } from '@/lib/ccAgent.types';
import type { Effort, PermissionMode } from '@/lib/userPreferences.types';
import { normalizeDbAgentKind } from '../../../../shared/agentKindConversion';

export interface NewMakerSessionSeed {
  target: {
    deviceId: string | null;
    deviceName: string | null;
    workingDir: string | null;
    remoteHostId: string | null;
  };
  runtime: {
    vendor: ReturnType<typeof normalizeDbAgentKind>;
    model: string;
    effort: Effort;
    providerId: string | null;
    permissionMode: PermissionMode;
    planMode: boolean;
    fastMode: boolean;
  };
}

/**
 * Build a one-shot New Maker seed from the selected task.
 *
 * Runtime fields describe the task's current engine and model routing. Workspace fields are
 * intentionally narrow: a dialogue keeps its target clean, and a Cindy-managed worktree path is
 * folded back to its project root by the draft store's normal normalization path. Extra read-only
 * directories and collaboration state never cross a task boundary.
 */
export function buildNewMakerSessionSeed(
  session: Session,
  options: {
    mode: 'generic' | 'dialogue';
    dialogueTarget?: { deviceId: string | null; deviceName: string | null } | null;
  },
): NewMakerSessionSeed {
  const dialogue = options.mode === 'dialogue';
  const dialogueTarget = options.dialogueTarget ?? null;
  const vendor = normalizeDbAgentKind(session.agentKind);
  const defaultPrefs =
    vendor === 'cc'
      ? { effort: 'medium' as Effort, permissionMode: 'auto' as PermissionMode }
      : { effort: 'high' as Effort, permissionMode: 'auto' as PermissionMode };
  const workspaceKind = session.workspaceKind ?? (session.workingDir ? 'project' : 'dialogue');
  const projectWorkingDir = workspaceKind === 'project' ? session.workingDir : null;
  const sourceDialogue = workspaceKind === 'dialogue';
  const nestedSshTarget = Boolean(session.deviceLinkDeviceId && session.remoteHostId);

  return {
    target: {
      deviceId: dialogue
        ? (dialogueTarget?.deviceId ?? null)
        : (session.deviceLinkDeviceId ?? null),
      deviceName: dialogue
        ? (dialogueTarget?.deviceName ?? null)
        : (session.deviceLinkDeviceName ?? null),
      workingDir: dialogue || sourceDialogue || nestedSshTarget ? null : projectWorkingDir,
      remoteHostId:
        dialogue || sourceDialogue || session.deviceLinkDeviceId || session.remoteHostId == null
          ? null
          : session.remoteHostId,
    },
    runtime: {
      vendor,
      model: session.model,
      effort: session.effort || defaultPrefs.effort,
      providerId: session.providerId ?? null,
      permissionMode: session.permissionMode || defaultPrefs.permissionMode,
      planMode: session.planModeEnabled === true,
      fastMode: session.fastMode === true,
    },
  };
}
