import { normalizeWorkingDirForProjectSettings } from '../../shared/workingDir';

interface TaskWorkspace {
  deviceId: string | null;
  deviceName: string | null;
  remoteHostId: string | null;
  workingDir: string | null;
}

function storageKey(ownerId: string): string {
  return 'cindy:lastCreatedTaskWorkspace:v1:' + encodeURIComponent(ownerId);
}

function nullableString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length > 0);
}

export function getLastCreatedTaskWorkspace(ownerId: string | null): TaskWorkspace | null {
  if (!ownerId) return null;
  try {
    const raw = localStorage.getItem(storageKey(ownerId));
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (
      !value ||
      !nullableString(value.deviceId) ||
      !nullableString(value.deviceName) ||
      !nullableString(value.remoteHostId) ||
      !nullableString(value.workingDir) ||
      (!value.deviceId && value.deviceName) ||
      (value.remoteHostId && (value.deviceId || !value.workingDir))
    ) return null;
    const { deviceId, deviceName, remoteHostId, workingDir } = value;
    return { deviceId, deviceName, remoteHostId, workingDir };
  } catch {
    return null;
  }
}

/** Save only the selected project and its host, never a session's temporary worktree or grants. */
export function rememberCreatedTaskWorkspace(ownerId: string | null, workspace: TaskWorkspace): void {
  if (!ownerId) return;
  const { deviceId, deviceName, remoteHostId, workingDir } = workspace;
  try {
    localStorage.setItem(storageKey(ownerId), JSON.stringify({
      deviceId, deviceName, remoteHostId, workingDir: normalizeWorkingDirForProjectSettings(workingDir),
    }));
  } catch {
    // The session has already been created. Preference storage is best effort.
  }
}
