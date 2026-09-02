export const SKILLHUB_HUB_SOURCES = ['native', 'legacy-xd'] as const;
export type SkillhubHubSource = (typeof SKILLHUB_HUB_SOURCES)[number];

export function isSkillhubHubSource(value: unknown): value is SkillhubHubSource {
  return typeof value === 'string'
    && SKILLHUB_HUB_SOURCES.includes(value as SkillhubHubSource);
}

/** Adds the optional catalog source without changing source-less legacy routes. */
export function withSkillhubHubSource(path: string, source: SkillhubHubSource | undefined): string {
  if (!source) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}hubSource=${encodeURIComponent(source)}`;
}
