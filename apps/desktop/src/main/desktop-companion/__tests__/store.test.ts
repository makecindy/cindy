import { describe, expect, it } from 'vitest';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePersistedState, pruneReusePool, readPersistedState, writePersistedState } from '../store.js';

describe('desktop companion store', () => {
  it('defaults missing state to disabled', () => {
    const state = normalizePersistedState(null);
    expect(state.settings.enabled).toBe(false);
    expect(state.settings.locationEnabled).toBe(false);
    expect(state.reusePool).toEqual([]);
  });

  it('preserves the system destination for an enabled legacy installation', () => {
    expect(normalizePersistedState({ settings: { enabled: true } }).settings.systemEnabled).toBe(true);
    expect(normalizePersistedState(null).settings.systemEnabled).toBe(false);
  });

  it('does not enable the system desktop when a new app-only configuration is reloaded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-wallpaper-state-'));
    try {
      const file = path.join(dir, 'state.json');
      const state = normalizePersistedState({ version: 2, settings: { enabled: true } });
      writePersistedState(file, state);
      expect(readPersistedState(file).settings.systemEnabled).toBe(false);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).settings).toEqual({ enabled: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops expired or missing reuse items', () => {
    const pool = pruneReusePool(
      [
        { fingerprint: 'a', stillPath: '/tmp/a.jpg', videoPath: null, topic: 'a', expiresAt: 10 },
        { fingerprint: 'b', stillPath: '/tmp/b.jpg', videoPath: null, topic: 'b', expiresAt: 30 },
      ],
      20,
      (filePath) => filePath.endsWith('b.jpg'),
    );
    expect(pool).toEqual([
      { fingerprint: 'b', stillPath: '/tmp/b.jpg', videoPath: null, topic: 'b', expiresAt: 30 },
    ]);
  });
});
