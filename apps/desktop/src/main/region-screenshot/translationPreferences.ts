import { app } from 'electron';
import path from 'node:path';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file';
import { createLogger } from '../logger';
import { throwIpcError } from '../utils/ipcValidate';
import { isScreenshotTranslationPreference, type ScreenshotTranslationPreference } from '../../shared/screenshotTranslation';

const log = createLogger('screenshot-translation');
const store = createOverrideSettingsFile<{ targetLanguage: ScreenshotTranslationPreference }>({
  filePath: () => path.join(app.getPath('userData'), 'screenshot-translation-settings.json'),
  defaults: { targetLanguage: 'ui' },
  normalize: (raw) => {
    const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).targetLanguage : undefined;
    return { targetLanguage: isScreenshotTranslationPreference(value) ? value : 'ui' };
  },
  log,
  label: 'screenshot-translation',
  preserveUnreadableFile: true,
});

/** Client-wide language preference; no screenshot content or account data is stored. */
export function readScreenshotTranslationPreference(): ScreenshotTranslationPreference {
  store.invalidateIfChanged();
  return store.read().targetLanguage;
}

export async function writeScreenshotTranslationPreference(value: unknown): Promise<ScreenshotTranslationPreference> {
  if (!isScreenshotTranslationPreference(value)) throwIpcError('INVALID_PARAMS', 'Invalid translation language');
  try {
    await store.writePatchAtomic({ targetLanguage: value });
    return value;
  } catch {
    log.warn('translation language preference write failed');
    throwIpcError('INTERNAL', 'Failed to save translation language');
  }
}
