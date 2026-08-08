/**
 * release-notes/index.ts
 * ---------------------------------------------------------------------------
 * Main fetches one raw JSON per version; renderer selects the requested
 * locale and normalizes it for UpdateNoticeDialog. Raw payloads are cached by
 * version, while normalized results are cached by version + locale so changing
 * the app language never reuses another language's rendered content or causes
 * another CDN request.
 */

import {
  hasRenderableContent,
  isRenderableTopic,
  type NoticeLocale,
  type RawItem,
  type RawLocalizedContent,
  type RawReleaseNotes,
} from '../../shared/releaseNotesContent';
import { DEFAULT_LOCALE } from '../../shared/locale';

/** Per-item shape after flattening: one bullet with its author tag. */
export interface ReleaseNoteItem {
  text: string;
  /** Single author derived from the enclosing group's `name`. */
  by: string;
}

/** Author-grouped raw item as authored in the JSON. */
export type RawReleaseNoteItem = RawItem;

export interface ReleaseNoteSection {
  title: string;
  items: ReleaseNoteItem[];
}

/** Topic-format (v2) block: one user-facing theme with a short narrative. */
export interface ReleaseNoteTopic {
  /** Stable internal id shared by every localized version of the topic. */
  id?: string;
  /** Leading emoji for the topic title. Optional — renderer tolerates absence. */
  emoji?: string;
  title: string;
  /** 1–2 sentence user-facing narrative for this topic. */
  text: string;
  /** Contributors credited on this topic (small text next to the title). */
  contributors: string[];
}

export interface ReleaseNotes {
  version: string;
  date: string;
  /** Flat contributor list — rendered as a single thanks line. */
  contributors: string[];
  /** Legacy author-grouped sections. Empty when the payload is topic-format. */
  sections: ReleaseNoteSection[];
  /** Topic-format blocks. Non-empty ⇒ dialog renders the topic layout. */
  topics: ReleaseNoteTopic[];
  /** Optional one-line lead above the topics. */
  intro?: string;
}

/** Fan out one author group into N flat items, one per `list` entry. */
function expandRawItem(raw: RawReleaseNoteItem): ReleaseNoteItem[] {
  return raw.list.map((text) => ({ text, by: raw.name }));
}

// Main already caches by version; this renderer raw cache avoids even another
// IPC round-trip when the user switches locale while the dialog is open.
const rawCache = new Map<string, RawReleaseNotes>();
const rawInFlight = new Map<string, Promise<RawReleaseNotes | null>>();
const localizedCache = new Map<string, ReleaseNotes>();

// Version-index cache — one shot per session; the app version is immutable
// while the process lives, so a successful fetch never needs to repeat.
let indexCache: string[] | null = null;

/** Return the legacy/root content in the same shape as a localized block. */
function legacyContentFromRoot(raw: RawReleaseNotes): RawLocalizedContent {
  return {
    intro: raw.intro,
    topics: raw.topics,
    sections: raw.sections,
  };
}

function hasUsableContent(content: unknown): content is RawLocalizedContent {
  return content !== null && typeof content === 'object' && hasRenderableContent(content);
}

/**
 * Select one language from a one-file notice. Empty or malformed localized
 * blocks count as missing and continue through the fallback chain.
 */
export function selectLocalizedContent(
  raw: RawReleaseNotes,
  locale: NoticeLocale,
): RawLocalizedContent | null {
  const localized = raw.contentByLocale;
  if (locale === 'zh-CN' || locale === 'zh-TW') {
    for (const candidate of [locale, 'zh-CN'] as const) {
      const content = localized?.[candidate];
      if (hasUsableContent(content)) return content;
    }
    const legacy = legacyContentFromRoot(raw);
    return hasUsableContent(legacy) ? legacy : null;
  }

  for (const candidate of [locale, 'en', 'zh-CN'] as const) {
    const content = localized?.[candidate];
    if (hasUsableContent(content)) return content;
  }

  const legacy = legacyContentFromRoot(raw);
  return hasUsableContent(legacy) ? legacy : null;
}

function normalizeReleaseNotes(
  raw: RawReleaseNotes,
  content: RawLocalizedContent,
): ReleaseNotes | null {
  const rawTopics = Array.isArray(content.topics) ? content.topics : [];
  const rawSections = Array.isArray(content.sections) ? content.sections : [];
  const notes: ReleaseNotes = {
    version: raw.version,
    date: raw.date,
    contributors: Array.isArray(raw.contributors)
      ? raw.contributors.filter((c): c is string => typeof c === 'string')
      : [],
    sections: rawSections
      .filter((s) => typeof s?.title === 'string' && Array.isArray(s?.items))
      .map((s) => ({
        title: s.title,
        items: (s.items as RawReleaseNoteItem[])
          .filter((g) => typeof g?.name === 'string' && Array.isArray(g?.list))
          .flatMap((g) => expandRawItem({
            name: g.name,
            list: g.list.filter((text): text is string => typeof text === 'string'),
          })),
      })),
    topics: rawTopics
      .filter((t) => isRenderableTopic(t))
      .map((t) => ({
        ...(typeof t.id === 'string' ? { id: t.id } : {}),
        emoji: typeof t.emoji === 'string' ? t.emoji : undefined,
        title: t.title,
        text: t.text,
        contributors: Array.isArray(t.contributors)
          ? t.contributors.filter((c): c is string => typeof c === 'string')
          : [],
      })),
    intro: typeof content.intro === 'string' ? content.intro : undefined,
  };

  const hasContent =
    notes.topics.length > 0 || notes.sections.some((s) => s.items.length > 0);
  return hasContent ? notes : null;
}

async function fetchRawReleaseNotes(version: string): Promise<RawReleaseNotes | null> {
  const hit = rawCache.get(version);
  if (hit) return hit;

  const pending = rawInFlight.get(version);
  if (pending) return pending;

  const request = (async () => {
    const raw = await window.electronAPI.fetchReleaseNotes(version);
    if (!raw || !hasRenderableContent(raw)) return null;
    rawCache.set(version, raw);
    return raw;
  })();
  rawInFlight.set(version, request);

  try {
    return await request;
  } finally {
    if (rawInFlight.get(version) === request) rawInFlight.delete(version);
  }
}

/**
 * Fetch the sorted version-index from CDN via main. Used to determine which
 * intermediate versions to pull when the user upgrades across releases.
 */
export async function fetchReleaseNotesIndex(): Promise<string[] | null> {
  if (indexCache) return indexCache;
  const raw = await window.electronAPI.fetchReleaseNotesIndex();
  if (!raw) return null;
  indexCache = raw;
  return raw;
}

/**
 * Fetch release notes for one version and select the requested locale.
 * CDN/main/preload still receive only the version because every language is
 * carried by the same raw JSON.
 */
export async function fetchReleaseNotes(
  version: string,
  locale: NoticeLocale = DEFAULT_LOCALE,
): Promise<ReleaseNotes | null> {
  const cacheKey = `${version}:${locale}`;
  const hit = localizedCache.get(cacheKey);
  if (hit) return hit;

  const raw = await fetchRawReleaseNotes(version);
  if (!raw) return null;

  const content = selectLocalizedContent(raw, locale);
  if (!content) return null;
  const notes = normalizeReleaseNotes(raw, content);
  if (!notes) return null;

  localizedCache.set(cacheKey, notes);
  return notes;
}
