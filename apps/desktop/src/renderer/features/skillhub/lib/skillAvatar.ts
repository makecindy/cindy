/** Fixed presentation aliases, not a new stored taxonomy. */
const GROUPS = [
  ['research', ['research', 'knowledge', '研究', '知识', '研究与知识']],
  ['code', ['code', 'coding', 'development', 'developer-tools', '编程', '开发', '编程与工具']],
  ['writing', ['writing', 'office', 'productivity', '写作', '办公', '写作与办公']],
  ['creative', ['creative', 'design', 'creativity', '设计', '创意', '设计与创意']],
  ['business', ['business', 'marketing', 'analytics', '运营', '业务', '运营与业务']],
] as const;
export type SkillAvatarCategory = typeof GROUPS[number][0];

function values(input: unknown): string[] {
  const entries = Array.isArray(input) ? input : [input];
  return entries.flatMap((entry): string[] => {
    if (typeof entry === 'string') return [entry.trim().toLowerCase()];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const tag = entry as Record<string, unknown>;
      return [tag.slug, tag.name].filter((v): v is string => typeof v === 'string')
        .map(v => v.trim().toLowerCase());
    }
    return [];
  });
}

export function resolveSkillAvatarCategory({ categories, tags, frontmatter }: {
  categories?: unknown;
  tags?: unknown;
  frontmatter?: Record<string, unknown>;
}): SkillAvatarCategory | undefined {
  const categoryValues = [...values(categories), ...values(frontmatter?.category), ...values(frontmatter?.categories)];
  const tagValues = [...values(tags), ...values(frontmatter?.tags)];
  // Categories precede tags; fixed group order makes multiple matches stable.
  for (const candidates of [categoryValues, tagValues]) {
    const match = GROUPS.find(([, aliases]) => aliases.some(alias => candidates.includes(alias)));
    if (match) return match[0];
  }
  return undefined;
}
