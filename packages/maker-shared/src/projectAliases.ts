import { normalizeProjectOrderPath } from './projectOrderSync.js';
import { resolveProjectAliasForSessions, type ProjectAliasDisplayIndex } from './projectAliasSync.js';
export { PROJECT_ALIASES_CHANGED_CHANNEL } from './projectAliasSync.js';

/** Host-owned display metadata. Never changes filesystem paths or task grouping. */
export const PROJECT_ALIASES_LIST_CHANNEL = 'local-db:project-aliases:list';
export type RemoteProjectAliasIndex = ReadonlyMap<string, string>;

export function remoteProjectAliasKey(
  deviceId: string,
  workingDir: string,
): string {
  return `device:${encodeURIComponent(deviceId)}:${normalizeProjectOrderPath(workingDir)}`;
}

/** Local keys belong to the responding host; SSH/viewer-only aliases must not leak into them. */
export function parseHostProjectAliases(
  deviceId: string,
  value: unknown,
): Map<string, string> {
  if (!Array.isArray(value))
    throw new Error('Invalid project aliases response');
  const aliases = new Map<string, string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { projectKey, alias } = entry as Record<string, unknown>;
    if (
      typeof projectKey !== 'string' ||
      !projectKey.startsWith('local:') ||
      !projectKey.slice(6).trim() ||
      typeof alias !== 'string' ||
      !alias.trim()
    )
      continue;
    const key = remoteProjectAliasKey(deviceId, projectKey.slice(6));
    // Host lists newest first, including legacy case variants.
    if (!aliases.has(key)) aliases.set(key, alias.trim());
  }
  return aliases;
}

export function remoteProjectAlias(
  aliases: ProjectAliasDisplayIndex | undefined,
  deviceId: string | null | undefined,
  workingDir: string | null | undefined,
): string | undefined {
  return deviceId && workingDir
    ? resolveProjectAliasForSessions([{ deviceLinkDeviceId: deviceId, workingDir }], aliases) ?? undefined
    : undefined;
}
