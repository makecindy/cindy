/**
 * release-notes/index.ts
 * ---------------------------------------------------------------------------
 * Per-version release notes are fetched from CDN by the main process and
 * delivered through `window.electronAPI.fetchReleaseNotes`. Platform routing
 * happens entirely in main (via getPlatformKey()), so the renderer only ever
 * deals with the version string.
 *
 * Successful results are memoised per version so that dismissing and
 * re-opening the dialog from the sidebar does not trigger another fetch.
 *
 * Two payload generations coexist on the CDN:
 *
 * Legacy (author-grouped): each section's `items` is an array of author groups
 *   { "name": "Lizi", "list": ["...", "..."] }
 * The dialog flattens these into one bullet per `list` entry under the
 * matching author sub-head.
 *
 * Topic format (v2): the payload carries `topics` instead of `sections` —
 * user-facing theme blocks, each a short narrative paragraph:
 *   { "emoji": "🎙️", "title": "语音输入更稳", "text": "…", "contributors": ["Lizi"] }
 * plus an optional top-level `intro` one-liner. Presence of a non-empty
 * `topics` array is the discriminator; old payloads never have it.
 */

import { isRenderableTopic } from '../../shared/releaseNotesContent';

/** Per-item shape after flattening: one bullet with its author tag. */
export interface ReleaseNoteItem {
  text: string;
  /** Single author derived from the enclosing group's `name`. */
  by: string;
}

/** Author-grouped raw item as authored in the JSON. */
export interface RawReleaseNoteItem {
  name: string;
  list: string[];
}

export interface ReleaseNoteSection {
  title: string;
  items: ReleaseNoteItem[];
}

/** Topic-format (v2) block: one user-facing theme with a short narrative. */
export interface ReleaseNoteTopic {
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
  /** Optional one-line lead above the topics (e.g. PR/commit counts). */
  intro?: string;
}

/** Fan out one author group into N flat items, one per `list` entry. */
function expandRawItem(raw: RawReleaseNoteItem): ReleaseNoteItem[] {
  return raw.list.map((text) => ({ text, by: raw.name }));
}

// ── In-memory cache (renderer-side) ────────────────────────────────────────

const cache = new Map<string, ReleaseNotes>();

// Version-index cache — one shot per session; the app version is immutable
// while the process lives, so a successful fetch never needs to repeat.
let indexCache: string[] | null = null;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch the sorted version-index from CDN via main. Used to determine which
 * intermediate versions to pull when the user upgrades across releases.
 * Returns null on failure — caller should fall back to showing the current
 * version only.
 */
export async function fetchReleaseNotesIndex(): Promise<string[] | null> {
  if (indexCache) return indexCache;
  const raw = await window.electronAPI.fetchReleaseNotesIndex();
  if (!raw) return null;
  indexCache = raw;
  return raw;
}

/**
 * Fetch release notes for the given version via the main-process CDN client.
 * Returns null when the CDN has no entry for this version on the current
 * platform, or when the network/parse fails.
 *
 * The CDN payload is normalised defensively before caching: missing
 * `contributors` / `sections` / `topics` become empty arrays, malformed topic
 * entries are dropped, and legacy author-grouped items are flattened.
 */
export async function fetchReleaseNotes(
  version: string,
): Promise<ReleaseNotes | null> {
  const hit = cache.get(version);
  if (hit) return hit;

  const raw = await window.electronAPI.fetchReleaseNotes(version);
  if (!raw) return null;

  // Defensive defaults: tolerate older payloads missing `contributors`,
  // topic-format payloads missing `sections`, and legacy payloads missing
  // `topics`. Malformed entries (topics, sections, author groups, bullets)
  // are dropped rather than crashing the dialog on a bad CDN document.
  const rawTopics = Array.isArray(raw.topics) ? raw.topics : [];
  const rawSections = Array.isArray(raw.sections) ? raw.sections : [];
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
        emoji: typeof t.emoji === 'string' ? t.emoji : undefined,
        title: t.title,
        text: t.text,
        contributors: Array.isArray(t.contributors)
          ? t.contributors.filter((c): c is string => typeof c === 'string')
          : [],
      })),
    intro: typeof raw.intro === 'string' ? raw.intro : undefined,
  };
  // A notice with no renderable content (e.g. a payload whose topics or
  // section bullets were all malformed and dropped) must count as a failed
  // fetch: caching it would open an empty dialog and, worse, advance
  // lastReadVersion on dismiss so a corrected CDN payload would never be
  // shown again. Bullet-level truth, mirroring shared hasRenderableContent.
  const hasContent =
    notes.topics.length > 0 || notes.sections.some((s) => s.items.length > 0);
  if (!hasContent) return null;
  cache.set(version, notes);
  return notes;
}
