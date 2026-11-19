import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { registerDisplayLanguagePreference } from '../display-language-preference';
import type { LocalePreference } from '../../shared/locale';

vi.mock('electron', async () => ({
  ipcMain: new (await import('node:events')).EventEmitter(),
  app: { getPath: vi.fn() },
}));
vi.mock('../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../security/trustedAppRenderer', () => ({
  isTrustedAppRendererEvent: (event: { trusted: boolean }) => event.trusted,
}));

registerDisplayLanguagePreference();
let profile: string;
beforeEach(() => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-language-'));
  vi.mocked(app.getPath).mockReturnValue(profile);
});
afterEach(() => fs.rmSync(profile, { recursive: true, force: true }));

function request(operation: 'restore' | 'set', language: unknown, trusted = true): Promise<LocalePreference | null> {
  return new Promise(resolve => {
    ipcMain.emit('app-locale:preference-sync', {
      trusted, set returnValue(value: LocalePreference | null) { resolve(value); },
    }, operation, language);
  });
}

// Unit, real profile store through its IPC entry. A new renderer origin has no
// legacy value, and an old origin may still have a language from before a reset.
it('imports the old choice once, then restores the profile even on an empty or stale origin', async () => {
  expect(await request('restore', null)).toBeNull();
  expect(fs.readdirSync(profile)).toEqual([]);
  expect(await request('restore', 'zh-CN')).toBe('zh-CN');
  expect(await request('restore', null)).toBe('zh-CN');
  expect(await request('set', 'system')).toBe('system');
  expect(await request('restore', 'zh-CN')).toBe('system');
  expect(JSON.parse(fs.readFileSync(path.join(profile, 'display-language.json'), 'utf8'))).toEqual({ language: 'system' });
});

it('refuses untrusted and malformed choices while keeping the saved preference', async () => {
  expect(await request('restore', 'zh-CN', false)).toBeNull();
  expect(await request('set', 'ja')).toBe('ja');
  expect(await request('set', 'invalid')).toBeNull();
  expect(await request('set', 'system', false)).toBeNull();
  expect(await request('restore', null)).toBe('ja');
});
