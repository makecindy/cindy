import path from 'node:path';
import { app, ipcMain } from 'electron';
import { isLocalePreference, type LocalePreference } from '../shared/locale';
import { createLogger } from './logger';
import { createOverrideSettingsFile } from './maker-host/override-settings-file';
import { isTrustedAppRendererEvent } from './security/trustedAppRenderer';

const log = createLogger('display-language');
const store = createOverrideSettingsFile<{ language: LocalePreference | null }>({
  filePath: () => path.join(app.getPath('userData'), 'display-language.json'),
  defaults: { language: null },
  normalize: raw => {
    const language = raw && typeof raw === 'object' && 'language' in raw ? raw.language : null;
    return { language: isLocalePreference(language) ? language : null };
  },
  label: 'display-language',
  log,
  maxBytes: 1024,
  preserveUnreadableFile: true,
});

export function readDisplayLanguagePreference(): LocalePreference | null {
  store.invalidateIfChanged();
  return store.read().language;
}

export function registerDisplayLanguagePreference(): void {
  let pending: Promise<unknown> = Promise.resolve();
  ipcMain.handle('app-locale:preference', (event, operation: unknown, value: unknown) => {
    if (!isTrustedAppRendererEvent(event)) return null;
    // Preserve the order of requests from this process even when the file lock is busy.
    const result = pending.then(() => applyPreference(operation, value)).catch(() => {
      log.warn('Could not persist the display language preference');
      throw new Error('Could not persist the display language preference');
    });
    pending = result.catch(() => undefined);
    return result;
  });
}

async function applyPreference(operation: unknown, value: unknown): Promise<LocalePreference | null> {
  const saved = readDisplayLanguagePreference();
  if (operation === 'restore' && saved !== null) return saved;
  if (!isLocalePreference(value)) return null;
  if (operation === 'restore' || operation === 'import') {
    let imported = false;
    const result = await store.updateAtomic(({ value: current }) => {
      if (current.language !== null) return null;
      imported = true;
      return { language: value };
    });
    return operation === 'restore' || imported ? result.language : null;
  }
  if (operation !== 'set') return null;
  if (saved !== value) await store.writePatchAtomic({ language: value });
  return value;
}
