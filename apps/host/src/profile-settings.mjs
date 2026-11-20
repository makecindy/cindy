/**
 * The settings files the Desktop owns, read and written by the host.
 *
 * The browser client must show exactly what the Desktop shows, so this module is
 * not a second store: it reads the same paths the Desktop main process reads and
 * normalizes them with the same shared code the Desktop uses.
 *
 *   machine-wide preferences  <dataDir>/<file>
 *   account-scoped state      <dataDir>/owners/<sha256(owner)[0:20]>/<file>
 *
 * Missing or unreadable files fall back to the shared defaults in
 * `apps/desktop/src/shared`, which is what the Desktop renders in that case too.
 * Writes go to those same paths with tmp+rename, so the two clients converge on
 * one copy instead of drifting apart.
 */

import fs from 'node:fs';
import path from 'node:path';

import { dataOwnerStorageKey } from '../../desktop/src/main/dataOwnerPath.ts';
import { coerceLayout } from '../../desktop/src/shared/layoutTree.ts';
import { normalizeAppearanceSettings } from '../../desktop/src/shared/appearanceSettings.ts';
import { normalizeAppShortcutOverrides } from '../../desktop/src/shared/appShortcuts.ts';
import { normalizeVoiceInputDataSnapshot } from '../../desktop/src/shared/voiceInputData.ts';

const FILE_NAMES = {
  appearance: 'appearance-settings.json',
  analytics: 'analytics-settings.json',
  layout: 'layout.v1.json',
  shortcuts: 'app-shortcuts.v1.json',
  sidebar: 'sidebar-settings.json',
  voiceInputData: 'voice-input-data.v1.json',
};

const ANALYTICS_DEFAULTS = {
  privacyConsentAccepted: false,
  analyticsEnabled: true,
  legacyConsentMigrationClosed: false,
};

/**
 * @typedef {{ status: 'ok' | 'missing' | 'invalid', file: string }} SettingSource
 */

function readJsonFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    const missing = error && typeof error === 'object' && error.code === 'ENOENT';
    return { status: missing ? 'missing' : 'invalid', value: null };
  }
  try {
    return { status: 'ok', value: JSON.parse(raw) };
  } catch {
    return { status: 'invalid', value: null };
  }
}

/** Same paths the Desktop derives for an explicit owner (see dataOwnerPath.ts). */
export function profileSettingPaths(dataDir, ownerId) {
  const ownerRoot = ownerId
    ? path.join(dataDir, 'owners', dataOwnerStorageKey(ownerId))
    : null;
  return {
    appearance: path.join(dataDir, FILE_NAMES.appearance),
    analytics: path.join(dataDir, FILE_NAMES.analytics),
    layout: path.join(dataDir, FILE_NAMES.layout),
    shortcuts: path.join(dataDir, FILE_NAMES.shortcuts),
    sidebar: ownerRoot ? path.join(ownerRoot, FILE_NAMES.sidebar) : null,
    voiceInputData: ownerRoot
      ? path.join(ownerRoot, FILE_NAMES.voiceInputData)
      : path.join(dataDir, FILE_NAMES.voiceInputData),
  };
}

function normalizeAnalytics(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    privacyConsentAccepted:
      typeof value.privacyConsentAccepted === 'boolean'
        ? value.privacyConsentAccepted
        : ANALYTICS_DEFAULTS.privacyConsentAccepted,
    analyticsEnabled:
      typeof value.analyticsEnabled === 'boolean'
        ? value.analyticsEnabled
        : ANALYTICS_DEFAULTS.analyticsEnabled,
    legacyConsentMigrationClosed: Boolean(value.legacyConsentMigrationClosed),
  };
}

/**
 * Sidebar state normalization. The Desktop implementation
 * (`main/sidebarSettingsStore.ts`) imports Electron, so the host mirrors its
 * normalization rules rather than importing it — same shape, same limits.
 */
function normalizeSidebar(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const strings = (input, limit) => {
    if (!Array.isArray(input)) return [];
    const seen = new Set();
    const out = [];
    for (const entry of input) {
      if (typeof entry !== 'string' || entry.length === 0 || seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
      if (out.length >= limit) break;
    }
    return out;
  };
  return {
    pinnedOrder: strings(value.pinnedOrder, 10_000),
    hiddenProjectKeys: strings(value.hiddenProjectKeys, 10_000),
    hiddenMainViewGhostIds: strings(value.hiddenMainViewGhostIds, 10_000),
  };
}

/**
 * Read every settings surface the browser client renders, from the Desktop's own
 * files.
 *
 * @param {{dataDir: string, ownerId: string | null, platform?: string}} input
 */
export function readProfileSettings(input) {
  const platform = input.platform ?? process.platform;
  const paths = profileSettingPaths(input.dataDir, input.ownerId);
  const sources = {};

  const appearanceFile = readJsonFile(paths.appearance);
  const layoutFile = readJsonFile(paths.layout);
  const analyticsFile = readJsonFile(paths.analytics);
  const shortcutsFile = readJsonFile(paths.shortcuts);
  const sidebarFile = paths.sidebar ? readJsonFile(paths.sidebar) : { status: 'missing' };
  const voiceFile = readJsonFile(paths.voiceInputData);

  sources.appearance = { status: appearanceFile.status, file: paths.appearance };
  sources.layout = { status: layoutFile.status, file: paths.layout };
  sources.analytics = { status: analyticsFile.status, file: paths.analytics };
  sources.shortcuts = { status: shortcutsFile.status, file: paths.shortcuts };
  sources.sidebar = { status: sidebarFile.status, file: paths.sidebar };
  sources.voiceInput = { status: voiceFile.status, file: paths.voiceInputData };

  // `coerceLayout` already ships the Desktop's read-path behavior: a corrupt or
  // missing archive falls back to the default tree instead of failing the UI.
  const layout = coerceLayout(layoutFile.value).layout;

  return {
    appearance: normalizeAppearanceSettings(appearanceFile.value),
    layout,
    analytics: normalizeAnalytics(analyticsFile.value),
    appShortcuts: {
      overrides: normalizeAppShortcutOverrides(shortcutsFile.value, platform),
      platform,
    },
    sidebar: normalizeSidebar(sidebarFile.value),
    voiceInput: normalizeVoiceInputDataSnapshot(voiceFile.value, platform),
    sources,
  };
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.host-${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(temporary, file);
}

/**
 * Merge a validated appearance patch into the Desktop's file and return the new
 * normalized settings. Unknown or malformed fields are dropped by the shared
 * normalizer, exactly like the Desktop's own parse step.
 */
export function writeAppearanceSettingsPatch(input, patch) {
  const paths = profileSettingPaths(input.dataDir, input.ownerId);
  const current = readJsonFile(paths.appearance);
  const merged = { ...(current.value && typeof current.value === 'object' ? current.value : {}), ...patch };
  const normalized = normalizeAppearanceSettings(merged);
  writeJsonAtomic(paths.appearance, normalized);
  return normalized;
}

export function writeLayout(input, layout) {
  const paths = profileSettingPaths(input.dataDir, input.ownerId);
  const coerced = coerceLayout(layout);
  if (coerced.fallback) throw new Error(`invalid layout: ${coerced.reason ?? 'unknown reason'}`);
  writeJsonAtomic(paths.layout, coerced.layout);
  return coerced.layout;
}

export function writeSidebarSettings(input, value) {
  const paths = profileSettingPaths(input.dataDir, input.ownerId);
  if (!paths.sidebar) throw new Error('sidebar settings require an active account');
  const normalized = normalizeSidebar(value);
  writeJsonAtomic(paths.sidebar, normalized);
  return normalized;
}

export function writeAppShortcutOverrides(input, overrides, platform = process.platform) {
  const paths = profileSettingPaths(input.dataDir, input.ownerId);
  writeJsonAtomic(paths.shortcuts, overrides ?? {});
  return {
    overrides: normalizeAppShortcutOverrides(overrides, platform),
    platform,
  };
}
