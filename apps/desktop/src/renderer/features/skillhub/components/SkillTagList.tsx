import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export interface SkillTag {
  slug: string;
  name: string;
  source?: 'platform';
}

interface SkillTagListProps {
  tags: readonly SkillTag[];
  maxVisible?: number;
  className?: string;
}

/**
 * Compact, non-interactive Skill tags shared by the SkillHub catalog cards.
 * Invalid and duplicate names are dropped so malformed remote metadata cannot
 * consume a card row; overflow stays bounded behind a single count pill.
 */
export function SkillTagList({ tags, maxVisible = 3, className }: SkillTagListProps) {
  const seenNames = new Set<string>();
  const normalizedTags = tags.flatMap((tag) => {
    const name = tag.name.trim();
    const normalizedName = name.toLocaleLowerCase();
    if (!name || seenNames.has(normalizedName)) return [];
    seenNames.add(normalizedName);
    return [{ ...tag, name }];
  });

  if (normalizedTags.length === 0 || maxVisible <= 0) return null;

  const visibleTags = normalizedTags.slice(0, maxVisible);
  const hiddenTags = normalizedTags.slice(maxVisible);

  return (
    <div className={cn('flex min-w-0 items-center gap-1 overflow-hidden', className)} role="list">
      {visibleTags.map((tag) => (
        <Badge size="xs" key={`${tag.slug}:${tag.name}`} role="listitem" title={tag.name} className="max-w-20">
          <span className="truncate">{tag.name}</span>
        </Badge>
      ))}
      {hiddenTags.length > 0 ? (
        <Badge size="xs"
          role="listitem"
          title={hiddenTags.map((tag) => tag.name).join(', ')}
          aria-label={hiddenTags.map((tag) => tag.name).join(', ')}
        >
          +{hiddenTags.length}
        </Badge>
      ) : null}
    </div>
  );
}
