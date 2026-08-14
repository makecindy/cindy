import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '../logger.js';
import type { AgentIslandLayoutPreference, AgentIslandDisplayIdentity } from './geometry.js';

const log = createLogger('agent-island:layout-store');

interface StoredLayoutPreference extends AgentIslandDisplayIdentity {
  centerXRatio?: number;
  compactContentWidth?: number;
  expandedContentWidth?: number;
}

interface AgentIslandLayoutSettings {
  displays: Record<string, StoredLayoutPreference>;
  detachedDisplays: StoredLayoutPreference[];
}

const DEFAULTS: AgentIslandLayoutSettings = {
  displays: {},
  detachedDisplays: [],
};

let cached: AgentIslandLayoutSettings | null = null;

/**
 * Stores per-display Agent Island placement and sizing outside the renderer so
 * the native helper can restore the same compact/expanded geometry after restart.
 */
function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'agent-island-layout-settings.json');
}

function normalize(raw: unknown): AgentIslandLayoutSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const record = raw as Record<string, unknown>;
  const rawDisplays = record.displays;
  const displays: Record<string, StoredLayoutPreference> = {};
  if (rawDisplays && typeof rawDisplays === 'object' && !Array.isArray(rawDisplays)) {
    for (const [displayId, value] of Object.entries(rawDisplays as Record<string, unknown>)) {
      const normalized = normalizePreference(value);
      if (normalized) displays[displayId] = normalized;
    }
  }
  const detachedDisplays = Array.isArray(record.detachedDisplays)
    ? record.detachedDisplays
        .map(normalizePreference)
        .filter(
          (preference): preference is StoredLayoutPreference =>
            preference !== null && hasStoredDisplayIdentity(preference),
        )
    : [];
  return { displays, detachedDisplays };
}

function normalizePreference(raw: unknown): StoredLayoutPreference | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const preference: StoredLayoutPreference = {};
  if (typeof record.displayName === 'string' && record.displayName.trim()) {
    preference.displayName = record.displayName.trim();
  }
  if (typeof record.displayIndex === 'number' && Number.isFinite(record.displayIndex)) {
    preference.displayIndex = record.displayIndex;
  }
  if (typeof record.displayInternal === 'boolean') {
    preference.displayInternal = record.displayInternal;
  }
  const rawBounds = record.displayBounds;
  if (rawBounds && typeof rawBounds === 'object') {
    const bounds = rawBounds as Record<string, unknown>;
    if (
      typeof bounds.x === 'number' && Number.isFinite(bounds.x)
      && typeof bounds.y === 'number' && Number.isFinite(bounds.y)
      && typeof bounds.width === 'number' && Number.isFinite(bounds.width)
      && typeof bounds.height === 'number' && Number.isFinite(bounds.height)
    ) {
      preference.displayBounds = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
    }
  }
  if (typeof record.centerXRatio === 'number' && Number.isFinite(record.centerXRatio)) {
    preference.centerXRatio = record.centerXRatio;
  }
  if (typeof record.compactContentWidth === 'number' && Number.isFinite(record.compactContentWidth)) {
    preference.compactContentWidth = record.compactContentWidth;
  }
  if (typeof record.expandedContentWidth === 'number' && Number.isFinite(record.expandedContentWidth)) {
    preference.expandedContentWidth = record.expandedContentWidth;
  }
  return Object.keys(preference).length > 0 ? preference : null;
}

function hasStoredDisplayIdentity(preference: StoredLayoutPreference): boolean {
  return (
    Boolean(preference.displayName?.trim()) ||
    typeof preference.displayIndex === 'number' ||
    typeof preference.displayInternal === 'boolean' ||
    preference.displayBounds !== undefined
  );
}

function clonePreference(preference: StoredLayoutPreference): AgentIslandLayoutPreference {
  return {
    ...preference,
    displayBounds: preference.displayBounds ? { ...preference.displayBounds } : undefined,
  };
}

function readSettings(): AgentIslandLayoutSettings {
  if (cached) return cached;
  const file = settingsFilePath();
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      cached = normalize(parsed);
      return cached;
    }
  } catch (error) {
    log.warn('agent island layout settings read failed; falling back to defaults', {
      error: error instanceof Error ? error.message : String(error),
      path: file,
    });
    try {
      fs.unlinkSync(file);
    } catch {
      // no-op
    }
  }
  cached = { ...DEFAULTS };
  return cached;
}

function writeSettings(next: AgentIslandLayoutSettings): void {
  const file = settingsFilePath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  cached = next;
}

export function readAgentIslandLayoutPreferences(): Map<number, AgentIslandLayoutPreference> {
  const settings = readSettings();
  const preferences = new Map<number, AgentIslandLayoutPreference>();
  for (const [displayIdText, preference] of Object.entries(settings.displays)) {
    const displayId = Number(displayIdText);
    if (!Number.isFinite(displayId)) continue;
    preferences.set(displayId, clonePreference(preference));
  }
  return preferences;
}

export function readAgentIslandDetachedLayoutPreferences(): AgentIslandLayoutPreference[] {
  return readSettings().detachedDisplays.map(clonePreference);
}

export function writeAgentIslandLayoutPreference(
  displayId: number,
  preference: AgentIslandLayoutPreference,
): void {
  if (!Number.isFinite(displayId)) return;
  const detachedPreferences = readAgentIslandDetachedLayoutPreferences();
  const next = readAgentIslandLayoutPreferences();
  const normalized = normalizePreference(preference);
  if (normalized) {
    next.set(displayId, normalized);
  } else {
    next.delete(displayId);
  }
  writeAgentIslandLayoutPreferences(next, detachedPreferences);
}

/**
 * Replaces the complete per-display snapshot in one atomic file write.
 *
 * Display ids can be exchanged when macOS re-enumerates monitors. Updating
 * those entries one by one would overwrite the destination key before the
 * source preference is moved, so migrations must publish the final map as a
 * single snapshot.
 */
export function writeAgentIslandLayoutPreferences(
  preferences: Map<number, AgentIslandLayoutPreference>,
  detachedPreferences: readonly AgentIslandLayoutPreference[] = readAgentIslandDetachedLayoutPreferences(),
): void {
  const displays: Record<string, StoredLayoutPreference> = {};
  for (const [displayId, preference] of preferences) {
    if (!Number.isFinite(displayId)) continue;
    const normalized = normalizePreference(preference);
    if (normalized) displays[String(displayId)] = normalized;
  }
  const detachedDisplays = detachedPreferences
    .map(normalizePreference)
    .filter(
      (preference): preference is StoredLayoutPreference =>
        preference !== null && hasStoredDisplayIdentity(preference),
    );
  writeSettings({ displays, detachedDisplays });
}
