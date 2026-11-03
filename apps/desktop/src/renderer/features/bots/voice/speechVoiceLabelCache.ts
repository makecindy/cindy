import {
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

// Derived display metadata only: never a preference, catalog, or permission to
// execute a voice. Keep a bounded set of selected labels in the existing renderer
// storage, partitioned by owner; routing and the full voice ID must still match.
type Entry = [botId: string, routeKey: string, voice: string, label: string];
const MAX_ENTRIES = 64;
const FIELD_LIMITS = [256, 2048, 128, 512];

function isEntry(value: unknown): value is Entry {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(
      (field, index) =>
        typeof field === 'string' && field.length > 0 && field.length <= FIELD_LIMITS[index],
    )
  );
}

function storageKey(owner: DataOwnerGeneration): string | undefined {
  if (!owner.dataOwnerId || !isDataOwnerGenerationCurrent(owner)) return undefined;
  return `xdt:companionVoiceLabels:v1:${encodeURIComponent(owner.dataOwnerId)}`;
}

function readEntries(key: string): Entry[] {
  const raw = window.localStorage.getItem(key);
  if (!raw || raw.length > 256_000) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry).slice(-MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

export function readSpeechVoiceLabel(
  owner: DataOwnerGeneration,
  botId: string,
  routeKey: string,
  voice: string,
): string | undefined {
  const key = storageKey(owner);
  if (!key) return undefined;
  try {
    return readEntries(key).find(
      (entry) => entry[0] === botId && entry[1] === routeKey && entry[2] === voice,
    )?.[3];
  } catch {
    return undefined;
  }
}

export function rememberSpeechVoiceLabel(
  owner: DataOwnerGeneration,
  botId: string,
  routeKey: string,
  voice: string,
  label: string | undefined,
): void {
  const key = storageKey(owner);
  if (!key || (label !== undefined && !isEntry([botId, routeKey, voice, label]))) return;
  try {
    // Re-read before writing so another window's display entries are retained.
    const entries = readEntries(key);
    const matches = (entry: Entry) =>
      entry[0] === botId && entry[1] === routeKey && entry[2] === voice;
    if (entries.find(matches)?.[3] === label) return;
    const next = entries.filter((entry) => !matches(entry));
    if (label !== undefined) next.push([botId, routeKey, voice, label]);
    window.localStorage.setItem(key, JSON.stringify(next.slice(-MAX_ENTRIES)));
  } catch {
    // An unavailable display cache must never prevent configuration or playback.
  }
}
