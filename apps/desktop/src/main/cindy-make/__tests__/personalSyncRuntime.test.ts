import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => paths.userData } }));

import {
  actPersonalSync,
  configurePersonalSync,
  parseSyncRecord,
} from '../personalSyncRuntime.js';

describe('personal sync record', () => {
  beforeEach(() => {
    paths.userData = mkdtempSync(path.join(os.tmpdir(), 'cindy-make-sync-record-'));
    mkdirSync(path.join(paths.userData, 'cindy-make'), { recursive: true });
  });
  afterEach(() => {
    rmSync(paths.userData, { recursive: true, force: true });
  });

  it('keeps well-formed values and drops the rest', () => {
    expect(parseSyncRecord(null)).toEqual({});
    expect(
      parseSyncRecord(
        '{"waiting":"123e4567-e89b-12d3-a456-426614174000","done":{"at":5,"ref":"main","ahead":true}}',
      ),
    ).toEqual({
      waiting: '123e4567-e89b-12d3-a456-426614174000',
      done: { at: 5, ref: 'main', ahead: true },
    });
  });

  it('returns the fresh record when the saved one is malformed', () => {
    // Truncated JSON and JSON that parses to `null` or another non-object are a
    // fresh start — the parse never throws.
    expect(parseSyncRecord('{"wait')).toEqual({});
    expect(parseSyncRecord('null')).toEqual({});
    expect(parseSyncRecord('5')).toEqual({});
    expect(parseSyncRecord('"text"')).toEqual({});
    expect(parseSyncRecord('[]')).toEqual({});
  });

  it('starts Sync anyway when sync.json is malformed', async () => {
    writeFileSync(path.join(paths.userData, 'cindy-make', 'sync.json'), 'null');
    expect(() => configurePersonalSync()).not.toThrow();
    await expect(actPersonalSync({ action: 'status' })).resolves.toEqual({});
  });
});
