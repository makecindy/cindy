interface LocalSkillRouteEntry {
  id: string;
  engine: 'claude-code' | 'codex' | 'pi';
  kind: SkillhubKind;
  scope: SkillhubScope;
  name: string;
  absolutePath: string;
  projectHash?: string;
  sourceKey?: string;
  requiresSourceKey?: boolean;
}

interface LocalSkillRouteParams {
  kind?: string;
  projectHash?: string;
  name?: string;
}

/** Builds a local detail URL while preserving the legacy pathname contract. */
export function buildLocalSkillRoute(entry: LocalSkillRouteEntry): string {
  const name = encodeURIComponent(entry.name);
  const pathname =
    entry.scope === 'global'
      ? `/skillhub/local/${entry.kind}/global/${name}`
      : `/skillhub/local/${entry.kind}/project/${entry.projectHash}/${name}`;
  const search = new URLSearchParams({ engine: entry.engine });
  if (entry.requiresSourceKey && entry.sourceKey) search.set('source', entry.sourceKey);
  return `${pathname}?${search.toString()}`;
}

/** Resolves both source-aware links and legacy links that predate source keys. */
export function findLocalSkillRouteEntry<T extends LocalSkillRouteEntry>(
  skills: readonly T[],
  params: LocalSkillRouteParams,
  searchParams: Pick<URLSearchParams, 'get'>,
): T | null {
  const { kind, projectHash, name } = params;
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
  if (source) return matches.find((skill) => skill.sourceKey === source) ?? null;

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
