interface LocalSkillRouteEntry {
  id: string;
  // Track the scanner's engine union so a new agent runtime cannot break the constraint.
  engine: SkillhubSkill['engine'];
  kind: SkillhubKind;
  scope: SkillhubScope;
  name: string;
  absolutePath: string;
  mdPath?: string;
  discoveredPath?: string;
  discoveryPaths?: string[];
  projectHash?: string;
  projectRoot?: string;
  sourceKey?: string;
  requiresSourceKey?: boolean;
}

export function findLocalSkillByPath<T extends LocalSkillRouteEntry>(
  skills: readonly T[],
  targetPath: string,
): T | null {
  return skills.find(
    (skill) => skill.absolutePath === targetPath || skill.discoveredPath === targetPath,
  ) ?? null;
}

interface LocalSkillRouteParams {
  kind?: string;
  projectHash?: string;
  name?: string;
}

/** Resolve a palette's SKILL.md path after the SkillHub scanner has loaded. */
export function buildLocalSkillPathRoute(path: string, context: { scope?: string; workingDir?: string | null } = {}): string {
  const search = new URLSearchParams({ path });
  const scope = context.scope === 'user' ? 'global' : context.scope === 'repo' ? 'project' : context.scope;
  if (scope === 'global' || scope === 'project') search.set('scope', scope);
  if (scope === 'project' && context.workingDir) search.set('workingDir', context.workingDir);
  return `/skillhub/local/by-path?${search.toString()}`;
}

function skillDirectoryPath(path: string): string {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(path);
  const normalized = (windows ? path.replace(/\\/g, '/') : path)
    .replace(/\/+$/, '').replace(/\/skill\.md$/i, '');
  return windows ? normalized.toLowerCase() : normalized;
}

/** Builds a local detail URL while preserving the legacy pathname contract. */
export function buildLocalSkillRoute(entry: LocalSkillRouteEntry): string {
  const name = encodeURIComponent(entry.name);
  const pathname =
    entry.scope === 'global'
      ? `/skillhub/local/${entry.kind}/global/${name}`
      : `/skillhub/local/${entry.kind}/project/${entry.projectHash}/${name}`;
  const search = new URLSearchParams({ engine: entry.engine });
  if (entry.sourceKey) search.set('source', entry.sourceKey);
  return `${pathname}?${search.toString()}`;
}

/** Resolves both source-aware links and legacy links that predate source keys. */
export function findLocalSkillRouteEntry<T extends LocalSkillRouteEntry>(
  skills: readonly T[],
  params: LocalSkillRouteParams,
  searchParams: Pick<URLSearchParams, 'get'>,
): T | null {
  const { kind, projectHash, name } = params;
  const commandPath = searchParams.get('path');
  if (!kind && !name && commandPath) {
    const target = skillDirectoryPath(commandPath);
    const scope = searchParams.get('scope');
    const workingDir = searchParams.get('workingDir');
    let matches = skills.filter((skill) => skill.kind === 'skill' && (!scope || skill.scope === scope) && [
      skill.absolutePath, skill.mdPath, skill.discoveredPath, ...(skill.discoveryPaths ?? []),
    ].some((path) => path && skillDirectoryPath(path) === target));
    if (scope === 'project' && workingDir) {
      const cwd = skillDirectoryPath(workingDir);
      matches = matches.filter((skill) => skill.projectRoot &&
        (cwd === skillDirectoryPath(skill.projectRoot) || cwd.startsWith(`${skillDirectoryPath(skill.projectRoot)}/`)));
      const nearest = Math.max(0, ...matches.map((skill) => skillDirectoryPath(skill.projectRoot!).length));
      matches = matches.filter((skill) => skillDirectoryPath(skill.projectRoot!).length === nearest);
    }
    // Older path-only URLs may still identify a unique lexical discovery entry.
    // Never pick an arbitrary copy merely because they share a physical source.
    if (matches.length > 1) {
      const lexical = matches.filter((skill) => [skill.discoveredPath, ...(skill.discoveryPaths ?? [])]
        .some((path) => path && skillDirectoryPath(path) === target));
      if (lexical.length === 1) return lexical[0]!;
    }
    return matches.length === 1 ? matches[0]! : null;
  }
  if (!kind || !name) return null;
  const decodedName = decodeURIComponent(name);
  const engine = searchParams.get('engine');
  const source = searchParams.get('source');
  const matches = skills.filter(
    (skill) =>
      skill.kind === kind &&
      skill.scope === (projectHash ? 'project' : 'global') &&
      (!projectHash || skill.projectHash === projectHash) &&
      skill.name === decodedName &&
      (!engine || skill.engine === engine),
  );
  if (source) {
    const exact = matches.find((skill) => skill.sourceKey === source);
    if (exact) return exact;
    // A source-aware URL may outlive the collision that created it. Once only
    // one physical source remains, that survivor is unambiguous even if older
    // scanners omitted its no-longer-required sourceKey.
    return matches.length === 1 ? matches[0] : null;
  }

  // Old URLs cannot identify a physical source. Keep their fallback stable even
  // if an agent changes discovery order between scans.
  return (
    matches.toSorted(
      (left, right) =>
        (left.sourceKey ?? '').localeCompare(right.sourceKey ?? '') ||
        left.absolutePath.localeCompare(right.absolutePath),
    )[0] ?? null
  );
}
