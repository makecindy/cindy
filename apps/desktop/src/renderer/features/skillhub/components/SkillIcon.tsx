import { useState } from 'react';
import { Package, BookOpen, Code2, PenLine, Palette, ChartColumn } from 'lucide-react';
import { resolveSkillAvatarCategory } from '../lib/skillAvatar';

const CATEGORY_ICONS = {
  research: BookOpen,
  code: Code2,
  writing: PenLine,
  creative: Palette,
  business: ChartColumn,
};
// Reuse the theme's categorical tag palette; blend against the active surface
// so light and dark modes share the same presentation rule.
const CATEGORY_COLORS = {
  research: 'var(--task-tag-blue)',
  code: 'var(--task-tag-green)',
  writing: 'var(--task-tag-orange)',
  creative: 'var(--task-tag-purple)',
  business: 'var(--task-tag-teal)',
};

const DEFAULT_SKILL_ICON_URL = /\/assets\/default-skill-icon(?:-v\d+)?\.svg(?:[?#]|$)/i;

/** Configured artwork first, category placeholder second, Package as fallback. */
export function SkillIcon({ url, categories, tags, frontmatter }: {
  url?: string;
  categories?: unknown;
  tags?: unknown;
  frontmatter?: Record<string, unknown>;
}) {
  const category = resolveSkillAvatarCategory({ categories, tags, frontmatter });
  const Icon = category ? CATEGORY_ICONS[category] : Package;
  const normalizedUrl = url?.trim() || null;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const useRemoteIcon = normalizedUrl !== null
    && normalizedUrl !== failedUrl
    && !DEFAULT_SKILL_ICON_URL.test(normalizedUrl);

  return (
    <span
      style={!useRemoteIcon && category ? {
        backgroundColor: `color-mix(in srgb, ${CATEGORY_COLORS[category]} 18%, var(--surface-elevated))`,
      } : undefined}
      className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[22%] border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--plugin-card-shadow)]"
    >
      {useRemoteIcon ? (
        <img
          src={normalizedUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="size-full object-cover"
          onError={() => setFailedUrl(normalizedUrl)}
          referrerPolicy="no-referrer"
        />
      ) : (
        <Icon size={17} strokeWidth={1.75} aria-hidden="true" />
      )}
    </span>
  );
}
