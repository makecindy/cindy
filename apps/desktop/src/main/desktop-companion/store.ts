import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_DESKTOP_COMPANION_SETTINGS,
  normalizeDesktopCompanionSettings,
  type DesktopCompanionReuseItem,
  type DesktopCompanionSettings,
} from '../../shared/desktopCompanion.js';

export interface DesktopCompanionPersistedState {
  settings: DesktopCompanionSettings;
  lastFingerprint: string | null;
  lastTopic: string | null;
  lastUpdatedAt: number | null;
  lastStillPath: string | null;
  lastVideoPath: string | null;
  lastError: string | null;
  reusePool: DesktopCompanionReuseItem[];
}

const EMPTY: DesktopCompanionPersistedState = {
  settings: { ...DEFAULT_DESKTOP_COMPANION_SETTINGS },
  lastFingerprint: null,
  lastTopic: null,
  lastUpdatedAt: null,
  lastStillPath: null,
  lastVideoPath: null,
  lastError: null,
  reusePool: [],
};

function isReuseItem(raw: unknown): raw is DesktopCompanionReuseItem {
  if (!raw || typeof raw !== 'object') return false;
  const record = raw as Record<string, unknown>;
  return (
    typeof record.fingerprint === 'string' &&
    typeof record.stillPath === 'string' &&
    (record.videoPath === null || typeof record.videoPath === 'string') &&
    typeof record.topic === 'string' &&
    typeof record.expiresAt === 'number' &&
    Number.isFinite(record.expiresAt)
  );
}

export function normalizePersistedState(raw: unknown): DesktopCompanionPersistedState {
  if (!raw || typeof raw !== 'object') return { ...EMPTY, settings: { ...EMPTY.settings }, reusePool: [] };
  const record = raw as Record<string, unknown>;
  const reusePool = Array.isArray(record.reusePool) ? record.reusePool.filter(isReuseItem) : [];
  return {
    settings: normalizeDesktopCompanionSettings(record.settings),
    lastFingerprint: typeof record.lastFingerprint === 'string' ? record.lastFingerprint : null,
    lastTopic: typeof record.lastTopic === 'string' ? record.lastTopic : null,
    lastUpdatedAt:
      typeof record.lastUpdatedAt === 'number' && Number.isFinite(record.lastUpdatedAt)
        ? record.lastUpdatedAt
        : null,
    lastStillPath: typeof record.lastStillPath === 'string' ? record.lastStillPath : null,
    lastVideoPath: typeof record.lastVideoPath === 'string' ? record.lastVideoPath : null,
    lastError: typeof record.lastError === 'string' ? record.lastError : null,
    reusePool,
  };
}

export function pruneReusePool(
  pool: DesktopCompanionReuseItem[],
  now: number,
  exists: (filePath: string) => boolean,
): DesktopCompanionReuseItem[] {
  return pool.filter((item) => item.expiresAt > now && exists(item.stillPath));
}

export function readPersistedState(filePath: string): DesktopCompanionPersistedState {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return normalizePersistedState(JSON.parse(raw) as unknown);
  } catch {
    return normalizePersistedState(null);
  }
}

export function writePersistedState(filePath: string, state: DesktopCompanionPersistedState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, filePath);
}
