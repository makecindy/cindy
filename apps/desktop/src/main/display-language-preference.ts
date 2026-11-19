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
  // A startup restore must finish before i18n reads localStorage. User selections
  // use the same acknowledgement so immediate quit cannot abandon an in-flight write.
  ipcMain.on('app-locale:preference-sync', (event, operation: unknown, value: unknown) => {
    if (!isTrustedAppRendererEvent(event)) {
      event.returnValue = null;
      return;
    }
    void applyPreference(operation, value).then(
      saved => { event.returnValue = saved; },
      () => {
        log.warn('Could not persist the display language preference');
        event.returnValue = null;
      },
    );
  });
}

async function applyPreference(operation: unknown, value: unknown): Promise<LocalePreference | null> {
  const saved = readDisplayLanguagePreference();
  if (operation === 'restore' && saved !== null) return saved;
  if (!isLocalePreference(value)) return null;
  if (operation === 'restore') {
    // Another window may have saved an explicit choice since the first read.
    const restored = await store.updateAtomic(current => ({ language: current.value.language ?? value }));
    return restored.language;
  }
  if (operation !== 'set') return null;
  if (saved !== value) await store.writePatchAtomic({ language: value });
  return value;
}
