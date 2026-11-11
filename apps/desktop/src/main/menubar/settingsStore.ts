/**
 * Menu bar quota settings, persisted as overrides in <userData>/menubar-settings.json.
 *
 * Only values the user changed are written, so new defaults reach everyone else. Source
 * ids the user ordered or hid are kept even while that connection is gone, so reconnecting
 * an account puts it back where it was.
 */

import { app } from 'electron';
import path from 'node:path';

import {
  DEFAULT_MENUBAR_SETTINGS,
  MENUBAR_STATUS_TEXT_MODES,
  MENUBAR_USAGE_SCOPES,
  type MenubarSettings,
  type MenubarSettingsPatch,
} from '../../shared/menubarQuota.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile, portableOverrideSettings } from '../maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('menubar-settings');
const MAX_IDS = 200;
const MAX_ID_LENGTH = 200;

function idList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > MAX_ID_LENGTH) continue;
    seen.add(item);
    if (seen.size >= MAX_IDS) break;
  }
  return [...seen];
}

export function normalizeMenubarSettings(raw: unknown): MenubarSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_MENUBAR_SETTINGS;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    order: idList(r.order) ?? [...d.order],
    hidden: idList(r.hidden) ?? [...d.hidden],
    shown: idList(r.shown) ?? [...d.shown],
    statusText: MENUBAR_STATUS_TEXT_MODES.includes(r.statusText as never)
      ? (r.statusText as MenubarSettings['statusText'])
      : d.statusText,
    lowAlert: typeof r.lowAlert === 'boolean' ? r.lowAlert : d.lowAlert,
    privacy: typeof r.privacy === 'boolean' ? r.privacy : d.privacy,
    scope: MENUBAR_USAGE_SCOPES.includes(r.scope as never) ? (r.scope as MenubarSettings['scope']) : d.scope,
  };
}

/** Keeps only recognised keys with valid values; anything else in a patch is dropped. */
export function sanitizeMenubarSettingsPatch(raw: unknown): MenubarSettingsPatch {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const normalized = normalizeMenubarSettings(r);
  const patch: MenubarSettingsPatch = {};
  for (const key of Object.keys(DEFAULT_MENUBAR_SETTINGS) as (keyof MenubarSettings)[]) {
    if (!(key in r)) continue;
    const valid =
      key === 'order' || key === 'hidden' || key === 'shown'
        ? Array.isArray(r[key])
        : key === 'statusText'
          ? MENUBAR_STATUS_TEXT_MODES.includes(r[key] as never)
          : key === 'scope'
            ? MENUBAR_USAGE_SCOPES.includes(r[key] as never)
            : typeof r[key] === 'boolean';
    if (valid) (patch as Record<string, unknown>)[key] = normalized[key];
  }
  return patch;
}

const store = createOverrideSettingsFile<MenubarSettings>({
  filePath: () => path.join(app.getPath('userData'), 'menubar-settings.json'),
  defaults: DEFAULT_MENUBAR_SETTINGS,
  normalize: normalizeMenubarSettings,
  log,
  label: 'menubar',
});

export function readMenubarSettings(): MenubarSettings {
  return store.read();
}

export function writeMenubarSettings(patch: MenubarSettingsPatch): MenubarSettings {
  const clean = sanitizeMenubarSettingsPatch(patch);
  if (Object.keys(clean).length > 0) store.writePatch(clean);
  return store.read();
}

/** New-computer setup: values the user changed here (docs/product-rules/new-device-setup-migration.md). */
export const menubarPortableSettings = portableOverrideSettings(store);
