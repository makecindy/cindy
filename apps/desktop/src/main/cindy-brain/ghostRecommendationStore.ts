import Store from 'electron-store';
import { validateGhostRecommendations, type GhostRecommendation } from '@cindy/plugin-protocol';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { isValidGhostId } from '../../shared/ghost.js';

interface Entry {
  id: string;
  items?: GhostRecommendation[];
  installedAt?: number;
}
interface Shape {
  entries: Entry[];
}
let instance: Store<Shape> | undefined;
let directory: string | undefined;
function store(): Store<Shape> {
  const current = ownerScopedUserDataPath();
  if (!instance || directory !== current) {
    instance = new Store<Shape>({
      name: 'ghost-recommendations',
      cwd: current,
      defaults: { entries: [] },
      clearInvalidConfig: true,
    });
    directory = current;
  }
  return instance;
}

export function readGhostRecommendationEntries(): Entry[] {
  const raw: unknown = store().get('entries');
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): Entry[] => {
    if (!entry || !isValidGhostId(entry.id)) return [];
    const parsed =
      entry.items === undefined ? undefined : validateGhostRecommendations(entry.items);
    return [
      {
        id: entry.id,
        ...(parsed?.ok ? { items: parsed.items } : {}),
        ...(typeof entry.installedAt === 'number' && Number.isFinite(entry.installedAt)
          ? { installedAt: entry.installedAt }
          : {}),
      },
    ];
  });
}

function update(id: string, patch: Partial<Entry>): void {
  if (!isValidGhostId(id)) throw new Error('Invalid plugin identity');
  const entries = readGhostRecommendationEntries();
  const previous = entries.find((e) => e.id === id);
  store().set('entries', [...entries.filter((e) => e.id !== id), { ...previous, ...patch, id }]);
}

/** Caller derives identity from the live sandbox binding, never from author payload. */
export function replaceGhostRecommendations(
  id: string,
  value: unknown,
): { ok: boolean; errorCode?: string } {
  const parsed = validateGhostRecommendations(value);
  if (!parsed.ok) return { ok: false, errorCode: 'INVALID_PARAMS' };
  try {
    update(id, { items: parsed.items });
  } catch {
    return { ok: false, errorCode: 'INTERNAL' };
  }
  return { ok: true };
}

/** Explicit first installs only. Updates/default installs must not call this. */
export function markGhostRecommendationInstalled(id: string): void {
  update(id, { installedAt: Date.now() });
}

export function consumeGhostRecommendationPriority(id: string): void {
  update(id, { installedAt: undefined });
}

export function forgetGhostRecommendations(id: string): void {
  store().set(
    'entries',
    readGhostRecommendationEntries().filter((e) => e.id !== id),
  );
}
