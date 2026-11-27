import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';

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
 * Primary modifier click for opening a new window:
 * Command+Click on macOS (leaving Ctrl+Click for the native context menu),
 * Ctrl+Click on Windows and Linux.
 */
export function isNewWindowClickModifier(
  event: { metaKey?: boolean; ctrlKey?: boolean },
  platform: string | undefined =
    typeof window !== 'undefined' ? window.electronAPI?.platform : undefined,
): boolean {
  const isMac = platform
    ? platform === 'darwin'
    : typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  return Boolean(isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}

/**
 * Resolve the optional `?bootDevice=` hint when launching `/cc-agent/new` in a new window.
 * Reuses `makeGenericNewMakerRouteState` so source-window task-device inheritance and
 * pending local plugin-engine navigation stay identical to same-window creation.
 */
export function resolveNewTaskSecondaryWindowDeviceId(pathname: string): string | undefined {
  const state = makeGenericNewMakerRouteState(pathname);
  const request = readNewMakerDialogueTargetRequest(state);
  if (!request) return undefined;
  return request.deviceId ?? NEW_TASK_LOCAL_BOOT_DEVICE;
}

/** Reconstruct generic `/cc-agent/new` route state inside the secondary window boot gate. */
export function makeNewTaskSecondaryWindowRouteState(
  bootDeviceId: string | null,
): NewMakerRouteState {
  if (bootDeviceId === NEW_TASK_LOCAL_BOOT_DEVICE) {
    const state = makeDialogueNewMakerRouteState(null);
    return {
      ...state,
      workspacePrompt: 'generic',
      dialogueTargetRequest: {
        ...state.dialogueTargetRequest,
        preserveWorkspaceIfSameDevice: true,
      },
    };
  }
  if (bootDeviceId) {
    const state = makeDialogueNewMakerRouteState({
      deviceId: bootDeviceId,
      deviceName:
        remoteProjectsStore.getDeviceList().find((device) => device.deviceId === bootDeviceId)
          ?.deviceName ?? bootDeviceId,
    });
    return {
      ...state,
      workspacePrompt: 'generic',
      dialogueTargetRequest: {
        ...state.dialogueTargetRequest,
        preserveWorkspaceIfSameDevice: true,
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
  const bootDeviceId = resolveNewTaskSecondaryWindowDeviceId(pathname);
  try {
    await window.electronAPI.maker.openSessionInNewWindow(
      NEW_TASK_SECONDARY_WINDOW_TARGET,
      bootDeviceId,
    );
  } catch {
    onError?.();
  }
}
