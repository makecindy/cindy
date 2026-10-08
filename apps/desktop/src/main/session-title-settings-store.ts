/**
 * session-title-settings-store —— 会话自动命名风格与标题语言偏好。
 *
 * File: <userData>/session-title-settings.json
 *
 * Defaults keep the historical behavior: concise smart titles written in the
 * UI language. Both keys are opt-in overrides so existing users see no change.
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('session-title-settings');

export type SessionTitleStyle = 'concise' | 'goal-summary' | 'raw';
/** 'auto' follows the UI locale; explicit values force the title language. */
export type SessionTitleLanguageSetting = 'auto' | 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko';

export interface SessionTitleSettings {
  style: SessionTitleStyle;
  language: SessionTitleLanguageSetting;
}

const DEFAULTS: SessionTitleSettings = {
  style: 'concise',
  language: 'auto',
};

const STYLES: readonly SessionTitleStyle[] = ['concise', 'goal-summary', 'raw'];
const LANGUAGES: readonly SessionTitleLanguageSetting[] = [
  'auto',
  'zh-CN',
  'zh-TW',
  'en',
  'ja',
  'ko',
];
export const SESSION_TITLE_STYLES = STYLES;
export const SESSION_TITLE_LANGUAGES = LANGUAGES;

function normalize(raw: unknown): SessionTitleSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const value = raw as Record<string, unknown>;
  return {
    style: STYLES.includes(value.style as SessionTitleStyle)
      ? (value.style as SessionTitleStyle)
      : DEFAULTS.style,
    language: LANGUAGES.includes(value.language as SessionTitleLanguageSetting)
      ? (value.language as SessionTitleLanguageSetting)
      : DEFAULTS.language,
  };
}

const store = createOverrideSettingsFile<SessionTitleSettings>({
  filePath: () => path.join(app.getPath('userData'), 'session-title-settings.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'session-title',
});

export function readSessionTitleSettings(): SessionTitleSettings {
  return store.read();
}

export function readSessionTitleSettingsState(): OverrideSettingsState<SessionTitleSettings> {
  return store.readState();
}

export function writeSessionTitleSettings(patch: Partial<SessionTitleSettings>): SessionTitleSettings {
  store.writePatch(patch);
  return store.read();
}

export function resetSessionTitleSettings(): SessionTitleSettings {
  return store.reset();
}

export const __testing = { normalize, DEFAULTS };
