export const SSO_ORG_HISTORY_VERSION = 1;
export const MAX_SSO_ORG_HISTORY_ENTRIES = 5;
export const MAX_SSO_ORG_IDENTIFIER_LENGTH = 253;

interface SsoOrgHistoryRecord {
  version: typeof SSO_ORG_HISTORY_VERSION;
  entries: string[];
}

function normalizeIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SSO_ORG_IDENTIFIER_LENGTH)
    return null;
  return normalized;
}

function dedupeKey(value: string): string {
  return value.toLowerCase();
}

function normalizeEntries(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const value of values) {
    const normalized = normalizeIdentifier(value);
    if (!normalized) continue;
    const key = dedupeKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(normalized);
    if (entries.length >= MAX_SSO_ORG_HISTORY_ENTRIES) break;
  }
  return entries;
}

/** Parses the device-local, non-credential organization sign-in history. */
export function parseSsoOrgHistory(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return [];
    const record = parsed as Partial<SsoOrgHistoryRecord>;
    if (record.version !== SSO_ORG_HISTORY_VERSION) return [];
    return normalizeEntries(record.entries);
  } catch {
    return [];
  }
}

export function serializeSsoOrgHistory(entries: readonly string[]): string {
  const record: SsoOrgHistoryRecord = {
    version: SSO_ORG_HISTORY_VERSION,
    entries: normalizeEntries(entries),
  };
  return JSON.stringify(record);
}

/** Moves a successful organization identifier to the MRU head. */
export function rememberSsoOrgIdentifier(
  entries: readonly string[],
  identifier: string,
): string[] {
  const normalized = normalizeIdentifier(identifier);
  const current = normalizeEntries(entries);
  if (!normalized) return current;
  const key = dedupeKey(normalized);
  return [
    normalized,
    ...current.filter((entry) => dedupeKey(entry) !== key),
  ].slice(0, MAX_SSO_ORG_HISTORY_ENTRIES);
}
