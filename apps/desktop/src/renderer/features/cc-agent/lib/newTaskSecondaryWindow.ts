import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { resolveSidebarPlatform } from '@/lib/sidebarNewWindowActivation';
import { getDraft } from '@/state/newMakerDraft';

import { makeGenericNewMakerRouteState } from './genericNewMakerRouteState';
import {
  makeDialogueNewMakerRouteState,
  readNewMakerDialogueTargetRequest,
  type NewMakerRouteState,
} from './newMakerRouteState';

/** Boot target passed via `?bootSession=` when opening a blank new-task window. */
export const NEW_TASK_SECONDARY_WINDOW_TARGET = '/cc-agent/new';

/** Explicit local-device sentinel carried in `?bootDevice=` for new-task secondary windows. */
export const NEW_TASK_LOCAL_BOOT_DEVICE = 'local';

/**
 * Source-window draft hints that cannot survive cold-loading `newMakerDraft` in a new window:
 * `sanitize()` strips transient device-link identity and its `workingDir`, so remote draft
 * workspace choices must travel explicitly across the window boundary.
 */
export interface NewTaskSecondaryWindowDraftHint {
  deviceName?: string;
  workingDir?: string;
  explicitNoProject?: boolean;
  /** Source draft was on a remote device when transitioning to local; don't treat sanitized state as same-device. */
  resetWorkspace?: boolean;
}

export interface NewTaskSecondaryWindowLaunch {
  bootSession: string;
  bootDeviceId: string | undefined;
}

/**
 * Primary modifier click for opening a new window:
 * Command+Click on macOS (leaving Ctrl+Click for the native context menu),
 * Ctrl+Click on Windows and Linux.
 */
export function isNewWindowClickModifier(
  event: { metaKey?: boolean; ctrlKey?: boolean },
  platform?: string,
): boolean {
  const isMac = resolveSidebarPlatform(platform) === 'darwin';
  return Boolean(isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}

function encodeNewTaskSecondaryWindowTarget(hint?: NewTaskSecondaryWindowDraftHint): string {
  if (!hint) return NEW_TASK_SECONDARY_WINDOW_TARGET;
  const params = new URLSearchParams();
  if (hint.workingDir && hint.workingDir.trim().length > 0) {
    params.set('workingDir', hint.workingDir);
  } else if (hint.explicitNoProject) {
    params.set('explicitNoProject', '1');
  }
  if (hint.deviceName && hint.deviceName.trim().length > 0) {
    params.set('deviceName', hint.deviceName);
  }
  if (hint.resetWorkspace) {
    params.set('resetWorkspace', '1');
  }
  const query = params.toString();
  return query ? `${NEW_TASK_SECONDARY_WINDOW_TARGET}?${query}` : NEW_TASK_SECONDARY_WINDOW_TARGET;
}

/**
 * Parse a `?bootSession=` value targeting `/cc-agent/new` (optionally carrying transient remote
 * draft query hints). Returns `null` for any other route or session ID.
 */
export function parseNewTaskSecondaryWindowTarget(
  bootSessionId: string,
): NewTaskSecondaryWindowDraftHint | null {
  if (bootSessionId === NEW_TASK_SECONDARY_WINDOW_TARGET) return {};
  if (!bootSessionId.startsWith(`${NEW_TASK_SECONDARY_WINDOW_TARGET}?`)) return null;
  const params = new URLSearchParams(bootSessionId.slice(NEW_TASK_SECONDARY_WINDOW_TARGET.length + 1));
  const rawWorkingDir = params.get('workingDir');
  const workingDir = rawWorkingDir && rawWorkingDir.trim().length > 0 ? rawWorkingDir : undefined;
  const explicitNoProject = !workingDir && params.get('explicitNoProject') === '1';
  const rawDeviceName = params.get('deviceName');
  const deviceName = rawDeviceName && rawDeviceName.trim().length > 0 ? rawDeviceName : undefined;
  const resetWorkspace = params.get('resetWorkspace') === '1';
  return {
    ...(workingDir ? { workingDir } : {}),
    ...(explicitNoProject ? { explicitNoProject: true } : {}),
    ...(deviceName ? { deviceName } : {}),
    ...(resetWorkspace ? { resetWorkspace: true } : {}),
  };
}

function buildRemoteDraftHint(
  deviceId: string,
  draft: ReturnType<typeof getDraft>,
): NewTaskSecondaryWindowDraftHint {
  const workingDir = draft.workingDir && draft.workingDir.trim().length > 0 ? draft.workingDir : undefined;
  const explicitNoProject = !workingDir && draft.explicitNoProject === true;
  const rawDeviceName = draft.deviceLinkDeviceName?.trim();
  const deviceName = rawDeviceName && rawDeviceName !== deviceId ? rawDeviceName : undefined;
  return {
    ...(workingDir ? { workingDir } : {}),
    ...(explicitNoProject ? { explicitNoProject: true } : {}),
    ...(deviceName ? { deviceName } : {}),
  };
}

/**
 * Resolve `?bootSession=` and `?bootDevice=` when launching `/cc-agent/new` in a new window.
 * Reuses `makeGenericNewMakerRouteState` so last-created workspace recall, source-window task
 * device inheritance, one-shot local plugin-engine navigation, and in-memory remote draft
 * preservation match same-window creation.
 */
export function resolveNewTaskSecondaryWindowLaunch(pathname: string): NewTaskSecondaryWindowLaunch {
  const state = makeGenericNewMakerRouteState(pathname);
  if (state.restoreLastCreatedWorkspace) {
    return { bootSession: NEW_TASK_SECONDARY_WINDOW_TARGET, bootDeviceId: undefined };
  }
  const draft = getDraft();
  const draftRemoteDeviceId = draft.remoteHostId ? null : draft.deviceLinkDeviceId?.trim() || null;
  const request = readNewMakerDialogueTargetRequest(state);

  if (request) {
    if (request.deviceId === null) {
      return {
        bootSession: draftRemoteDeviceId
          ? encodeNewTaskSecondaryWindowTarget({ resetWorkspace: true })
          : NEW_TASK_SECONDARY_WINDOW_TARGET,
        bootDeviceId: NEW_TASK_LOCAL_BOOT_DEVICE,
      };
    }
    const hint =
      draftRemoteDeviceId === request.deviceId
        ? buildRemoteDraftHint(request.deviceId, draft)
        : undefined;
    return {
      bootSession: encodeNewTaskSecondaryWindowTarget(hint),
      bootDeviceId: request.deviceId,
    };
  }

  // Bare `{ workspacePrompt: 'generic' }` means "preserve the current draft".
  // Local/SSH drafts survive via localStorage; transient remote device-link drafts do not.
  if (draftRemoteDeviceId) {
    return {
      bootSession: encodeNewTaskSecondaryWindowTarget(buildRemoteDraftHint(draftRemoteDeviceId, draft)),
      bootDeviceId: draftRemoteDeviceId,
    };
  }

  return { bootSession: NEW_TASK_SECONDARY_WINDOW_TARGET, bootDeviceId: undefined };
}

/**
 * Resolve the optional `?bootDevice=` hint when launching `/cc-agent/new` in a new window.
 */
export function resolveNewTaskSecondaryWindowDeviceId(pathname: string): string | undefined {
  return resolveNewTaskSecondaryWindowLaunch(pathname).bootDeviceId;
}

/** Reconstruct generic `/cc-agent/new` route state inside the secondary window boot gate. */
export function makeNewTaskSecondaryWindowRouteState(
  bootDeviceId: string | null,
  draftHint?: NewTaskSecondaryWindowDraftHint,
): NewMakerRouteState {
  if (bootDeviceId === NEW_TASK_LOCAL_BOOT_DEVICE) {
    const state = makeDialogueNewMakerRouteState(null);
    return {
      ...state,
      workspacePrompt: 'generic',
      dialogueTargetRequest: {
        ...state.dialogueTargetRequest,
        ...(draftHint?.resetWorkspace ? {} : { preserveWorkspaceIfSameDevice: true }),
      },
    };
  }
  if (bootDeviceId) {
    const state = makeDialogueNewMakerRouteState({
      deviceId: bootDeviceId,
      deviceName:
        remoteProjectsStore.getDeviceList().find((device) => device.deviceId === bootDeviceId)
          ?.deviceName ??
        draftHint?.deviceName ??
        bootDeviceId,
    });
    const workingDir =
      draftHint?.workingDir && draftHint.workingDir.trim().length > 0
        ? draftHint.workingDir
        : undefined;
    return {
      ...state,
      workspacePrompt: 'generic',
      dialogueTargetRequest: {
        ...state.dialogueTargetRequest,
        preserveWorkspaceIfSameDevice: true,
        ...(workingDir ? { workingDir } : {}),
        ...(!workingDir && draftHint?.explicitNoProject ? { explicitNoProject: true } : {}),
      },
    };
  }
  return makeGenericNewMakerRouteState(NEW_TASK_SECONDARY_WINDOW_TARGET);
}

/** Open `/cc-agent/new` in a new full secondary application window. */
export async function openNewTaskInNewWindow(
  pathname: string,
  onError?: () => void,
): Promise<void> {
  const { bootSession, bootDeviceId } = resolveNewTaskSecondaryWindowLaunch(pathname);
  try {
    await window.electronAPI.maker.openSessionInNewWindow(bootSession, bootDeviceId);
  } catch {
    onError?.();
  }
}
