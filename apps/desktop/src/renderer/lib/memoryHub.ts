export type MemoryHubEntryType = 'user' | 'feedback' | 'project' | 'reference' | 'digest';

export interface MemoryHubEntrySummary {
  filename: string;
  slug: string;
  frontmatter: {
    title: string;
    description: string;
    type: MemoryHubEntryType;
    updatedAt: string;
  };
  sizeBytes: number;
}

export interface MemoryHubScope {
  dirName: string;
  kind: 'local' | 'remote';
  scopeKey: string | null;
  displayPath: string | null;
}

export const CURATED_MEMORY_HUB_TYPES: readonly MemoryHubEntryType[] = [
  'user',
  'feedback',
  'project',
  'reference',
];

export const MEMORY_HUB_TYPE_ORDER: readonly MemoryHubEntryType[] = [
  ...CURATED_MEMORY_HUB_TYPES,
  'digest',
];

export function splitCuratedAndDigestEntries(
  entries: readonly MemoryHubEntrySummary[],
): { curated: MemoryHubEntrySummary[]; digest: MemoryHubEntrySummary[] } {
  const byType = new Map<MemoryHubEntryType, MemoryHubEntrySummary[]>();
  for (const type of MEMORY_HUB_TYPE_ORDER) byType.set(type, []);
  for (const entry of entries) {
    byType.get(entry.frontmatter.type)?.push(entry);
  }
  return {
    curated: CURATED_MEMORY_HUB_TYPES.flatMap((type) => byType.get(type) ?? []),
    digest: byType.get('digest') ?? [],
  };
}

export function scopeDisplayName(scope: MemoryHubScope, fallbackLabel: string): string {
  if (scope.displayPath) return scope.displayPath;
  if (scope.scopeKey) return scope.scopeKey;
  return `${fallbackLabel} · ${scope.dirName}`;
}

export function scopeIsOpenable(scope: MemoryHubScope): boolean {
  return scope.scopeKey !== null;
}

export function formatMemoryHubTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function formatMemoryHubSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
