import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ownerDatabasePath, prepareModelDefaultsProfile, readModelDefaultsProfileOrigin } from '../localDb/modelDefaultsProfile';

let root: string;
let database: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-model-defaults-profile-'));
  database = ownerDatabasePath(root, 'owner-a');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('model defaults profile creation provenance', () => {
  it('persists eligibility before DB creation and keeps it across retries/restarts', () => {
    expect(readModelDefaultsProfileOrigin(database)).toBe('pending');
    // The actual startup lease is already held at the profile-creation callsite.
    fs.mkdirSync(`${database}.schema-writer.lock`);
    prepareModelDefaultsProfile(database);
    expect(fs.existsSync(database)).toBe(false);
    expect(readModelDefaultsProfileOrigin(database)).toBe('new');
    prepareModelDefaultsProfile(database);
    fs.writeFileSync(database, 'created DB');
    prepareModelDefaultsProfile(database);
    expect(readModelDefaultsProfileOrigin(database)).toBe('new');
    expect(readModelDefaultsProfileOrigin(ownerDatabasePath(root, 'owner-b'))).toBe('pending');
  });

  it.each(['', '-wal', '-shm', '-journal', '.bak.clean', '.bak.2026-09-08T00-00-00', '.slimming-backup'])
  ('never grants defaults to an existing/migrated profile or its recovery files (%s)', (suffix) => {
    fs.writeFileSync(`${database}${suffix}`, 'old profile');
    prepareModelDefaultsProfile(database);
    expect(readModelDefaultsProfileOrigin(database)).toBe('existing');
    expect(fs.existsSync(`${database}.model-defaults-origin.v1.json`)).toBe(false);
  });

  it.each(['{broken', '{"version":2,"origin":"new"}', '{"version":1,"origin":"existing"}'])
  ('does not replace uncertain or existing provenance (%s)', (contents) => {
    const marker = `${database}.model-defaults-origin.v1.json`;
    fs.writeFileSync(marker, contents);
    prepareModelDefaultsProfile(database);
    expect(readModelDefaultsProfileOrigin(database)).toBe('existing');
    expect(fs.readFileSync(marker, 'utf-8')).toBe(contents);
  });

  it('leaves creation retryable when marker publication fails', () => {
    const link = vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    expect(() => prepareModelDefaultsProfile(database)).toThrow('disk full');
    expect(fs.existsSync(database)).toBe(false);
    expect(readModelDefaultsProfileOrigin(database)).toBe('pending');
    link.mockRestore();
    prepareModelDefaultsProfile(database);
    expect(readModelDefaultsProfileOrigin(database)).toBe('new');
  });

  it('ignores an unpublished temporary marker after an interrupted first launch', () => {
    fs.writeFileSync(`${database}.model-defaults-origin.v1.json.init-123-interrupted`, '{');
    expect(readModelDefaultsProfileOrigin(database)).toBe('pending');
    prepareModelDefaultsProfile(database);
    expect(readModelDefaultsProfileOrigin(database)).toBe('new');
  });
});
