/**
 * Persisted, display-safe summary of a resolved session reference.
 *
 * The referenced message bodies intentionally never enter this shape. Main
 * attaches only the range summary after resolving the reference, while the
 * renderer supplies localized copy at display time.
 */
export interface PersistedSessionReferenceMetadata {
  sessionId: string;
  messageClientId?: string;
  range: 'recent' | 'around-anchor';
  messageCount: number;
  truncated: boolean;
}

interface ResolvedSessionReferenceSummary {
  sessionId: string;
  messageClientId?: string;
  range: 'recent' | 'around-anchor';
  messageCount: number;
  truncated: boolean;
}

const MAX_PERSISTED_SESSION_REFERENCES = 8;
const MAX_PERSISTED_REFERENCE_MESSAGES = 20;

function coerceMetadata(value: unknown): PersistedSessionReferenceMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.sessionId !== 'string' || item.sessionId.length === 0) return null;
  if (item.range !== 'recent' && item.range !== 'around-anchor') return null;
  if (
    typeof item.messageCount !== 'number' ||
    !Number.isInteger(item.messageCount) ||
    item.messageCount < 0 ||
    item.messageCount > MAX_PERSISTED_REFERENCE_MESSAGES
  ) {
    return null;
  }
  if (typeof item.truncated !== 'boolean') return null;
  if (
    item.messageClientId !== undefined &&
    (typeof item.messageClientId !== 'string' || item.messageClientId.length === 0)
  ) {
    return null;
  }
  return {
    sessionId: item.sessionId,
    ...(typeof item.messageClientId === 'string' ? { messageClientId: item.messageClientId } : {}),
    range: item.range,
    messageCount: item.messageCount,
    truncated: item.truncated,
  };
}

/** Validate untrusted JSON loaded from message storage. */
export function parsePersistedSessionReferenceMetadata(
  value: unknown,
): PersistedSessionReferenceMetadata[] {
  if (!Array.isArray(value) || value.length > MAX_PERSISTED_SESSION_REFERENCES) return [];
  const result: PersistedSessionReferenceMetadata[] = [];
  for (const item of value) {
    const parsed = coerceMetadata(item);
    if (!parsed) return [];
    result.push(parsed);
  }
  return result;
}

/**
 * Add resolved range summaries to an existing persisted user-content JSON
 * envelope. Malformed legacy content is left untouched instead of being
 * silently rewritten into a different message shape.
 */
export function attachSessionReferenceMetadata(
  persistedContent: string,
  contexts: readonly ResolvedSessionReferenceSummary[],
): string {
  try {
    const parsed = JSON.parse(persistedContent) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return persistedContent;
    const envelope = parsed as Record<string, unknown>;
    if (typeof envelope.text !== 'string') return persistedContent;

    if (contexts.length === 0) {
      if (!Object.hasOwn(envelope, 'sessionReferences')) return persistedContent;
      const withoutSessionReferences = { ...envelope };
      delete withoutSessionReferences.sessionReferences;
      return JSON.stringify(withoutSessionReferences);
    }
    if (contexts.length > MAX_PERSISTED_SESSION_REFERENCES) return persistedContent;
    const sessionReferences = parsePersistedSessionReferenceMetadata(contexts);
    if (sessionReferences.length !== contexts.length) return persistedContent;
    return JSON.stringify({ ...envelope, sessionReferences });
  } catch {
    return persistedContent;
  }
}
