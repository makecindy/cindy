import { normalizeWorkingDirForProjectSettings } from '../../shared/workingDir';

export interface TaskWorkspace {
  deviceId: string | null;
  deviceName: string | null;
  remoteHostId: string | null;
  workingDir: string | null;
}

export interface DeviceTaskWorkspace {
  remoteHostId: string | null;
  workingDir: string | null;
}

function storageKey(ownerId: string): string {
  return 'cindy:lastCreatedTaskWorkspace:v1:' + encodeURIComponent(ownerId);
}

function deviceWorkspacesStorageKey(ownerId: string): string {
  return 'cindy:lastDeviceTaskWorkspace:v1:' + encodeURIComponent(ownerId);
}

function deviceKey(deviceId: string | null): string | null {
  if (deviceId === null) return 'local';
  const trimmed = deviceId.trim();
  return trimmed.length > 0 ? `device:${trimmed}` : null;
}

function nullableString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length > 0);
}

function readDeviceWorkspaceMap(ownerId: string): Record<string, DeviceTaskWorkspace> {
  try {
    const raw = localStorage.getItem(deviceWorkspacesStorageKey(ownerId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, DeviceTaskWorkspace> = {};
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const isLocal = key === 'local';
      if (!isLocal && !key.startsWith('device:')) continue;
      if (!nullableString(record.remoteHostId) || !nullableString(record.workingDir)) continue;
      const workingDir = normalizeWorkingDirForProjectSettings(record.workingDir);
      const remoteHostId = isLocal && workingDir !== null ? record.remoteHostId : null;
      if (record.remoteHostId && (!isLocal || !workingDir)) continue;
      out[key] = { remoteHostId, workingDir };
    }
    return out;
  } catch {
    return {};
  }
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

/**
 * Remember the last workspace (project or explicit dialogue) chosen on a specific computer
 * for the active account. Managed worktrees collapse to their base project directory.
 */
export function rememberDeviceTaskWorkspace(
  ownerId: string | null,
  deviceId: string | null,
  selection: DeviceTaskWorkspace,
): void {
  if (!ownerId) return;
  const key = deviceKey(deviceId);
  if (!key) return;
  const workingDir = normalizeWorkingDirForProjectSettings(selection.workingDir);
  const remoteHostId =
    deviceId === null &&
    workingDir !== null &&
    typeof selection.remoteHostId === 'string' &&
    selection.remoteHostId.trim().length > 0
      ? selection.remoteHostId.trim()
      : null;
  try {
    const map = readDeviceWorkspaceMap(ownerId);
    map[key] = { remoteHostId, workingDir };
    localStorage.setItem(deviceWorkspacesStorageKey(ownerId), JSON.stringify(map));
  } catch {
    // Preference storage is best effort.
  }
}

/**
 * Read the last remembered workspace for a specific computer. Falls back to the legacy
 * single-entry lastCreatedTaskWorkspace when it belongs to the same computer.
 */
export function getLastDeviceTaskWorkspace(
  ownerId: string | null,
  deviceId: string | null,
): DeviceTaskWorkspace | null {
  if (!ownerId) return null;
  const key = deviceKey(deviceId);
  if (!key) return null;
  const remembered = readDeviceWorkspaceMap(ownerId)[key];
  if (remembered) return remembered;
  const lastCreated = getLastCreatedTaskWorkspace(ownerId);
  if (lastCreated && lastCreated.deviceId === (deviceId ? deviceId.trim() : null)) {
    return {
      remoteHostId: lastCreated.remoteHostId,
      workingDir: lastCreated.workingDir,
    };
  }
  return null;
}

/** Resolve the target workspace when switching computers in the new-task draft. */
export function resolveDeviceSwitchWorkspace(
  ownerId: string | null,
  deviceId: string | null,
  fallbackLocalDefaultDir?: string | null,
): { workingDir: string | null; remoteHostId: string | null; explicitNoProject: boolean } {
  const remembered = getLastDeviceTaskWorkspace(ownerId, deviceId);
  if (remembered) {
    return {
      workingDir: remembered.workingDir,
      remoteHostId: remembered.remoteHostId,
      explicitNoProject: remembered.workingDir === null,
    };
  }
  if (deviceId === null && fallbackLocalDefaultDir) {
    const normalized = normalizeWorkingDirForProjectSettings(fallbackLocalDefaultDir);
    if (normalized) {
      return {
        workingDir: normalized,
        remoteHostId: null,
        explicitNoProject: false,
      };
    }
  }
  return {
    workingDir: null,
    remoteHostId: null,
    explicitNoProject: true,
  };
}

/** Save only the selected project and its host, never a session's temporary worktree or grants. */
export function rememberCreatedTaskWorkspace(ownerId: string | null, workspace: TaskWorkspace): void {
  if (!ownerId) return;
  const { deviceId, deviceName, remoteHostId, workingDir } = workspace;
  const normalizedDir = normalizeWorkingDirForProjectSettings(workingDir);
  try {
    localStorage.setItem(storageKey(ownerId), JSON.stringify({
      deviceId, deviceName, remoteHostId, workingDir: normalizedDir,
    }));
  } catch {
    // The session has already been created. Preference storage is best effort.
  }
  rememberDeviceTaskWorkspace(ownerId, deviceId, {
    remoteHostId,
    workingDir: normalizedDir,
  });
}
