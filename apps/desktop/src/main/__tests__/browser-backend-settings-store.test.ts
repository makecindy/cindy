import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const paths = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => paths.userData } }));

import {
  __testing, readBrowserBackendSettingsState, resetBrowserBackendSettings,
  writeBrowserBackendKind, writeBrowserUseRealProfile,
} from '../browser-backend-settings-store.js';

describe('browser-backend explicit preferences', () => {
  beforeEach(() => { paths.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-settings-')); });
  afterEach(() => { fs.rmSync(paths.userData, { recursive: true, force: true }); });

  it('preserves an explicit default and other preferences until reset', () => {
    writeBrowserUseRealProfile(true);
    writeBrowserBackendKind('rsb-webview');
    writeBrowserBackendKind('external');
    expect(readBrowserBackendSettingsState().customizedKeys).toContain('kind');
    expect(JSON.parse(fs.readFileSync(path.join(paths.userData, 'browser-backend-settings.json'), 'utf8')))
      .toEqual({ kind: 'external', useRealProfile: true });
    resetBrowserBackendSettings();
    expect(readBrowserBackendSettingsState()).toMatchObject({
      value: { kind: 'external', useRealProfile: false }, isCustomized: false, customizedKeys: [],
    });
    expect(fs.existsSync(path.join(paths.userData, 'browser-backend-settings.json'))).toBe(false);
    writeBrowserBackendKind('external');
    expect(readBrowserBackendSettingsState().customizedKeys).toEqual(['kind']);
  });
});

describe('browser-backend-settings-store normalize', () => {
  it('defaults useRealProfile to false', () => {
    expect(__testing.normalize(undefined)).toEqual({
      kind: 'external',
      useRealProfile: false,
    });
    expect(__testing.normalize({ kind: 'rsb-webview' })).toEqual({
      kind: 'rsb-webview',
      useRealProfile: false,
    });
  });

  it('only accepts an explicit true for useRealProfile', () => {
    expect(__testing.normalize({ useRealProfile: true })).toEqual({
      kind: 'external',
      useRealProfile: true,
    });
    expect(__testing.normalize({ useRealProfile: 'true' })).toEqual({
      kind: 'external',
      useRealProfile: false,
    });
  });
});
