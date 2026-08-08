import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_APPSHOT_SHORTCUT_PREFERENCES,
  normalizeAppshotShortcut,
  type AppshotShortcut,
  type AppshotShortcutPreferences,
} from '../../shared/appshots.js';
import { appShortcutCombosEqual } from '../../shared/appShortcuts.js';
import { isSystemReservedShortcut } from '../../shared/keyboardReserved.js';

const STORE_VERSION = 1;

export type AppshotShortcutValidationReason =
  | 'invalid-structure'
  | 'duplicate'
  | 'system-reserved';

/** Distinguishes user validation failures from storage failures at the IPC boundary. */
export class AppshotShortcutValidationError extends Error {
  constructor(readonly reason: AppshotShortcutValidationReason) {
    super(reason === 'duplicate'
      ? 'Preferred and fallback shortcuts must be different.'
      : reason === 'system-reserved'
        ? 'This shortcut is reserved by the system.'
        : 'Appshot shortcut preferences are invalid.');
    this.name = 'AppshotShortcutValidationError';
  }
}

export interface AppshotShortcutStoreDeps {
  getFilePath: () => string;
  readFile: (path: string) => string;
  writeFileAtomic: (path: string, value: string) => void;
  removeFile: (path: string) => void;
}

function clonePreferences(value: AppshotShortcutPreferences): AppshotShortcutPreferences {
  return {
    preferred: value.preferred.kind === 'dual-modifier'
      ? { ...value.preferred }
      : { kind: 'accelerator', combo: { ...value.preferred.combo } },
    fallback: value.fallback.kind === 'dual-modifier'
      ? { ...value.fallback }
      : { kind: 'accelerator', combo: { ...value.fallback.combo } },
  };
}

function shortcutEqual(a: AppshotShortcut, b: AppshotShortcut): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'dual-modifier'
    ? a.modifier === (b as Extract<AppshotShortcut, { kind: 'dual-modifier' }>).modifier
    : appShortcutCombosEqual(a.combo, (b as Extract<AppshotShortcut, { kind: 'accelerator' }>).combo);
}

function isStrictShortcutShape(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'dual-modifier') {
    return raw.modifier === 'command' || raw.modifier === 'option' || raw.modifier === 'shift';
  }
  if (raw.kind !== 'accelerator' || !raw.combo || typeof raw.combo !== 'object' || Array.isArray(raw.combo)) {
    return false;
  }
  const combo = raw.combo as Record<string, unknown>;
  return typeof combo.code === 'string'
    && combo.code.trim().length > 0
    && typeof combo.meta === 'boolean'
    && typeof combo.ctrl === 'boolean'
    && typeof combo.alt === 'boolean'
    && typeof combo.shift === 'boolean'
    && (combo.key === undefined || typeof combo.key === 'string');
}

function parseStrictPreferences(value: unknown): AppshotShortcutPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppshotShortcutValidationError('invalid-structure');
  }
  const raw = value as Record<string, unknown>;
  if (!isStrictShortcutShape(raw.preferred) || !isStrictShortcutShape(raw.fallback)) {
    throw new AppshotShortcutValidationError('invalid-structure');
  }
  const preferred = normalizeAppshotShortcut(raw.preferred);
  const fallback = normalizeAppshotShortcut(raw.fallback);
  if (!preferred || !fallback) throw new AppshotShortcutValidationError('invalid-structure');
  const preferences = { preferred, fallback };
  if (shortcutEqual(preferences.preferred, preferences.fallback)) {
    throw new AppshotShortcutValidationError('duplicate');
  }
  for (const shortcut of [preferences.preferred, preferences.fallback]) {
    if (shortcut.kind === 'accelerator' && isSystemReservedShortcut(shortcut.combo, 'mac')) {
      throw new AppshotShortcutValidationError('system-reserved');
    }
  }
  return preferences;
}

function parseStoredPreferences(value: string): AppshotShortcutPreferences | null {
  try {
    const raw = JSON.parse(value) as { version?: unknown; preferences?: unknown };
    if (raw.version !== STORE_VERSION) return null;
    return parseStrictPreferences(raw.preferences);
  } catch {
    return null;
  }
}

/** Stores only explicit Appshot shortcut overrides; defaults remain code-owned. */
export class AppshotShortcutStore {
  constructor(private readonly deps: AppshotShortcutStoreDeps) {}

  get(): AppshotShortcutPreferences {
    try {
      return parseStoredPreferences(this.deps.readFile(this.deps.getFilePath()))
        ?? clonePreferences(DEFAULT_APPSHOT_SHORTCUT_PREFERENCES);
    } catch {
      return clonePreferences(DEFAULT_APPSHOT_SHORTCUT_PREFERENCES);
    }
  }

  set(next: unknown): AppshotShortcutPreferences {
    const preferences = parseStrictPreferences(next);
    this.deps.writeFileAtomic(
      this.deps.getFilePath(),
      JSON.stringify({ version: STORE_VERSION, preferences }),
    );
    return clonePreferences(preferences);
  }

  reset(): AppshotShortcutPreferences {
    try {
      this.deps.removeFile(this.deps.getFilePath());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return clonePreferences(DEFAULT_APPSHOT_SHORTCUT_PREFERENCES);
  }
}

/** Creates the desktop's userData-backed store with a same-directory atomic replace. */
export function createAppshotShortcutStore(userDataPath: string): AppshotShortcutStore {
  const filePath = path.join(userDataPath, 'appshots-shortcuts.v1.json');
  return new AppshotShortcutStore({
    getFilePath: () => filePath,
    readFile: (target) => fs.readFileSync(target, 'utf8'),
    writeFileAtomic: (target, value) => {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporary, value, { encoding: 'utf8', mode: 0o600 });
      try {
        fs.renameSync(temporary, target);
        fs.chmodSync(target, 0o600);
      } catch (error) {
        try { fs.unlinkSync(temporary); } catch { /* best effort */ }
        throw error;
      }
    },
    removeFile: (target) => fs.unlinkSync(target),
  });
}
