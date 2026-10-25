/**
 * Extracts readable user intent from persisted message content for snapshot labels.
 *
 * messages.content is stored as a JSON string in the local DB, but legacy or
 * host-created rows may still contain plain text. This helper stays pure so the
 * host wiring can be tested without pulling in localDb.
 */
export function extractUserPromptText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "string") return parsed;
    if (Array.isArray(parsed)) {
      return parsed
        .filter(
          (block) =>
            block &&
            typeof block === "object" &&
            (block as { type?: unknown }).type === "text" &&
            typeof (block as { text?: unknown }).text === "string",
        )
        .map((block) => (block as { text: string }).text)
        .join(" ");
    }
    if (parsed && typeof parsed === "object") {
      const text = (parsed as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
  } catch {
    // Plain text or malformed JSON: keep the original persisted content.
  }
  return content;
}
