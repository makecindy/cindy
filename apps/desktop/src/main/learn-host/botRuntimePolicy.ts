/** Parsed Bot runtime snapshots are the host's persisted resolved-policy record. */
export function botRuntimeSnapshotIncludesSkill(
  resolvedJson: string,
  commandName: string,
  resolvedSkillPath: string,
): boolean {
  try {
    const snapshot = JSON.parse(resolvedJson) as { skillResources?: unknown };
    if (!Array.isArray(snapshot.skillResources)) return false;
    return snapshot.skillResources.some((resource: unknown) => {
      if (!resource || typeof resource !== 'object') return false;
      const item = resource as { name?: unknown; path?: unknown };
      return item.name === commandName && item.path === resolvedSkillPath;
    });
  } catch {
    return false;
  }
}
