/**
 * releaseNotesContent.ts
 * ---------------------------------------------------------------------------
 * Shared (main + renderer) content-validity predicates for update-notice
 * payloads. Both sides must agree on what counts as renderable: main uses
 * them to avoid caching a payload the renderer would reject (a poisoned
 * process-lifetime cache would keep serving the bad document even after the
 * CDN is corrected), and the renderer uses them to filter topic entries.
 */

/** Minimal structural shape both processes can check without full typing. */
interface TopicLike {
  title?: unknown;
  text?: unknown;
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
 * Whether a raw CDN payload carries anything the dialog can render: a
 * non-empty legacy `sections` array, or at least one valid v2 topic.
 */
export function hasRenderableContent(raw: {
  sections?: unknown;
  topics?: unknown;
}): boolean {
  if (Array.isArray(raw.sections) && raw.sections.length > 0) return true;
  return Array.isArray(raw.topics) && raw.topics.some((t) => isRenderableTopic(t as TopicLike));
}
