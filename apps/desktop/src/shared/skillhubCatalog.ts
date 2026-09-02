export const SKILLHUB_CATALOG_SCOPES = ['market', 'team'] as const;
export type SkillhubCatalogScope = (typeof SKILLHUB_CATALOG_SCOPES)[number];

export function isSkillhubCatalogScope(value: unknown): value is SkillhubCatalogScope {
  return typeof value === 'string'
    && SKILLHUB_CATALOG_SCOPES.includes(value as SkillhubCatalogScope);
}

export function skillhubCatalogKey(slug: string, scope?: SkillhubCatalogScope): string {
  // Missing scope is the authenticated native/management view. Market and
  // team are explicit catalog reads and must never alias this key.
  return `${scope ?? 'native'}:${slug}`;
}

/** Keeps follow-up reads on the generic catalog that produced the list item. */
export function withSkillhubCatalogScope(
  path: string,
  scope: SkillhubCatalogScope | undefined,
): string {
  if (!scope) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}scope=${encodeURIComponent(scope)}`;
}
