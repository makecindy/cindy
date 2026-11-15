import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { app } from 'electron';
import { onScreenshotTranslationPreferenceChanged, readScreenshotTranslationPreference, writeScreenshotTranslationPreference } from '../translationPreferences';
import { resolveScreenshotTranslationLanguage } from '../../../shared/screenshotTranslation';

vi.mock('electron', () => ({ app: { getPath: vi.fn() } }));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

// Test value: real preference entry persists a language across readers and restores UI following.
// User requirement: remember the selected target. No prior screenshot preference coverage.
// Minimum inputs: no override, fr, ui, invalid IPC value, damaged JSON. Unit, isolated temporary files.
let directory: string;
let file: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-language-'));
  file = path.join(directory, 'screenshot-translation-settings.json');
  vi.mocked(app.getPath).mockReturnValue(directory);
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

it('follows each current UI language without persisting a default', () => {
  for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'] as const) {
    expect(resolveScreenshotTranslationLanguage(readScreenshotTranslationPreference(), locale)).toBe(locale);
  }
  expect(fs.existsSync(file)).toBe(false);
});

it('persists an override and restores UI following by removing that override', async () => {
  await writeScreenshotTranslationPreference('fr');
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ targetLanguage: 'fr' });
  expect(resolveScreenshotTranslationLanguage(readScreenshotTranslationPreference(), 'ja')).toBe('fr');
  await writeScreenshotTranslationPreference('ui');
  expect(readScreenshotTranslationPreference()).toBe('ui');
  expect(resolveScreenshotTranslationLanguage(readScreenshotTranslationPreference(), 'ko')).toBe('ko');
  expect(fs.existsSync(file)).toBe(false);
});

it('reads a previously saved language on startup', () => {
  fs.writeFileSync(file, JSON.stringify({ targetLanguage: 'de' }));
  expect(readScreenshotTranslationPreference()).toBe('de');
});

it('rejects invalid languages without overwriting a saved choice', async () => {
  await writeScreenshotTranslationPreference('ja');
  await expect(writeScreenshotTranslationPreference('not-a-language')).rejects.toThrow('INVALID_PARAMS');
  expect(readScreenshotTranslationPreference()).toBe('ja');
});

it('preserves an unreadable preferences file and reports failure', async () => {
  const listener = vi.fn();
  const unsubscribe = onScreenshotTranslationPreferenceChanged(listener);
  try {
  fs.writeFileSync(file, '{broken');
  expect(readScreenshotTranslationPreference()).toBe('ui');
  await expect(writeScreenshotTranslationPreference('fr')).rejects.toThrow('INTERNAL');
  expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
  expect(listener).not.toHaveBeenCalled();
  } finally { unsubscribe(); }
});

// PR #8410: surface synchronization requires a committed preference, not optimistic
// UI state. Existing persistence cases do not observe subscribers. Unit: save once,
// read in the notification, then unsubscribe; a failed surface must not break saving.
it('notifies after persistence and isolates released or broken subscribers', async () => {
  const values: string[] = [];
  const releaseBroken = onScreenshotTranslationPreferenceChanged(() => { throw new Error('window gone'); });
  const release = onScreenshotTranslationPreferenceChanged(value => {
    expect(readScreenshotTranslationPreference()).toBe(value);
    values.push(value);
  });
  try {
    await expect(writeScreenshotTranslationPreference('fr')).resolves.toBe('fr');
    expect(values).toEqual(['fr']);
    release();
    await expect(writeScreenshotTranslationPreference('de')).resolves.toBe('de');
    expect(readScreenshotTranslationPreference()).toBe('de');
    expect(values).toEqual(['fr']);
  } finally { release(); releaseBroken(); }
});
