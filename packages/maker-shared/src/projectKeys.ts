import { normalizeWorkingDirForGrouping } from './workingDir.js';

export type ProjectScope = 'local' | 'remote';

export function normalizeProjectKey(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('local:')) {
    const workingDir = normalizeWorkingDirForGrouping(trimmed.slice('local:'.length));
    return workingDir == null ? null : `local:${workingDir}`;
  }
  if (trimmed.startsWith('remote:')) {
    const rest = trimmed.slice('remote:'.length);
    const sep = rest.indexOf(':');
    if (sep < 0) return null;
    let hostId: string;
    try {
      hostId = decodeURIComponent(rest.slice(0, sep));
    } catch {
      return null;
    }
    const workingDir = normalizeWorkingDirForGrouping(rest.slice(sep + 1));
    if (!hostId || workingDir == null) return null;
    return projectIdentityKey('remote', workingDir, hostId);
  }
  if (trimmed.startsWith('device:')) {
    const rest = trimmed.slice('device:'.length);
    const sep = rest.indexOf(':');
    if (sep < 0) return null;
    let deviceId: string;
    try {
      deviceId = decodeURIComponent(rest.slice(0, sep));
    } catch {
      return null;
    }
    const workingDir = normalizeWorkingDirForGrouping(rest.slice(sep + 1));
    if (!deviceId || workingDir == null) return null;
    return deviceLinkProjectKey(deviceId, workingDir);
  }
  const workingDir = normalizeWorkingDirForGrouping(trimmed);
  return workingDir == null ? null : `local:${workingDir}`;
}

/**
 * Returns a stable identity used only when comparing project keys.
 *
 * Keep the normalized key's original spelling for display, persistence, and
 * filesystem access. Local Windows drive and UNC paths are case-insensitive,
 * though, and can arrive with different casing from session data and the native
 * directory picker. Fold only those keys when the local platform is Windows;
 * remote/device paths retain exact-case semantics because their host filesystem
 * is unknown here.
 */
export function projectKeyComparisonKey(
  raw: string | null | undefined,
  localPlatform: string,
): string | null {
  const projectKey = normalizeProjectKey(raw);
  if (projectKey == null || !projectKey.startsWith('local:')) return projectKey;

  const workingDir = projectKey.slice('local:'.length);
  const isWindowsDrivePath = /^[A-Za-z]:\//.test(workingDir);
  const isWindowsUncPath = workingDir.startsWith('//');
  return localPlatform === 'win32' && (isWindowsDrivePath || isWindowsUncPath)
    ? `local:${workingDir.toLowerCase()}`
    : projectKey;
}

export function projectIdentityKey(scope: ProjectScope, workingDir: string, remoteHostId: string | null): string {
  const normalizedWorkingDir = normalizeWorkingDirForGrouping(workingDir);
  if (normalizedWorkingDir == null) return `local:${workingDir}`;
  if (scope === 'remote' && remoteHostId) {
    return `remote:${encodeURIComponent(remoteHostId)}:${normalizedWorkingDir}`;
  }
  return `local:${normalizedWorkingDir}`;
}

export function deviceLinkProjectKey(deviceId: string, workingDir: string): string {
  const normalized = normalizeWorkingDirForGrouping(workingDir);
  const wd = normalized ?? workingDir;
  return `device:${encodeURIComponent(deviceId)}:${wd}`;
}
