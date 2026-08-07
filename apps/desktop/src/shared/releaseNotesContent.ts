/**
 * releaseNotesContent.ts
 * ---------------------------------------------------------------------------
 * Shared (main + renderer) content-validity predicates for update-notice
 * payloads. Both sides must agree on what counts as renderable: main uses
 * them to avoid caching a payload the renderer would reject (a poisoned
 * process-lifetime cache would keep serving the bad document even after the
 * CDN is corrected), and the renderer uses them to filter topic entries.
 */

import type { SupportedLocale } from './locale';

export type NoticeLocale = SupportedLocale;

/** Author-grouped item: one block per contributor, with their bullets. */
export interface RawItem {
  name: string;
  list: string[];
}

export interface RawSection {
  title: string;
  items: RawItem[];
}

/** Topic-format (v2) block: one user-facing theme with a short narrative. */
export interface RawTopic {
  id?: string;
  emoji?: string;
  title: string;
  text: string;
  contributors?: string[];
}

export interface RawLocalizedContent {
  intro?: string;
  topics?: RawTopic[];
  sections?: RawSection[];
}

export interface RawReleaseNotes {
  version: string;
  date: string;
  githash?: string;
  contributors?: string[];

  // Legacy/root compatibility fields.
  sections?: RawSection[];
  topics?: RawTopic[];
  intro?: string;

  // New one-file, multi-locale payload.
  contentByLocale?: Partial<Record<NoticeLocale, RawLocalizedContent>>;
}

/** Minimal structural shapes both processes can check without full typing. */
interface TopicLike {
  title?: unknown;
  text?: unknown;
}

interface SectionLike {
  title?: unknown;
  items?: unknown;
}

interface AuthorGroupLike {
  name?: unknown;
  list?: unknown;
}

/**
 * A topic renders iff both title and text are non-blank strings. Blank
 * strings would produce an empty block, so they count as malformed.
 */
export function isRenderableTopic(topic: TopicLike | null | undefined): boolean {
  return (
    typeof topic?.title === 'string' &&
    topic.title.trim() !== '' &&
    typeof topic?.text === 'string' &&
    topic.text.trim() !== ''
  );
}

/**
 * A legacy section renders iff it yields at least one actual bullet: string
 * title, array items, and some author group with a string name and at least
 * one string bullet. Mirrors the renderer's per-entry normalization filters —
 * the two sides must agree, or main would cache a document the renderer
 * rejects (process-lifetime cache poisoning).
 */
export function isRenderableSection(section: SectionLike | null | undefined): boolean {
  if (typeof section?.title !== 'string' || !Array.isArray(section?.items)) return false;
  return section.items.some((group: AuthorGroupLike | null | undefined) => {
    if (typeof group?.name !== 'string' || !Array.isArray(group?.list)) return false;
    return group.list.some((text) => typeof text === 'string');
  });
}

/**
 * Whether a raw CDN payload carries anything the dialog can render: root
 * legacy/v2 content or at least one renderable localized content block.
 */
function hasRenderableLocalizedContent(content: RawLocalizedContent | null | undefined): boolean {
  if (!content) return false;
  if (
    Array.isArray(content.sections) &&
    content.sections.some((s) => isRenderableSection(s as SectionLike))
  ) {
    return true;
  }
  return Array.isArray(content.topics) && content.topics.some((t) => isRenderableTopic(t));
}

export function hasRenderableContent(raw: {
  sections?: unknown;
  topics?: unknown;
  contentByLocale?: Partial<Record<NoticeLocale, RawLocalizedContent>>;
}): boolean {
  if (Array.isArray(raw.sections) && raw.sections.some((s) => isRenderableSection(s as SectionLike))) {
    return true;
  }
  if (Array.isArray(raw.topics) && raw.topics.some((t) => isRenderableTopic(t as TopicLike))) {
    return true;
  }
  return Object.values(raw.contentByLocale ?? {}).some((content) =>
    hasRenderableLocalizedContent(content),
  );
}
