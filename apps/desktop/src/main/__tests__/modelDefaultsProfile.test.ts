import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ownerDatabasePath, prepareModelDefaultsProfile, readModelDefaultsProfileOrigin } from '../localDb/modelDefaultsProfile';
import { recordModelVisibilityAdoption } from '../localDb/modelVisibilityAdoption';

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
  it.each(['EXDEV', 'EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS'])(
    'publishes a complete new-profile marker without hard-link support (%s)', (code) => {
      vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw Object.assign(new Error('unsupported'), { code }); });
      const rename = fs.renameSync;
      const publish = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        expect(readModelDefaultsProfileOrigin(database)).toBe('pending');
        expect(JSON.parse(fs.readFileSync(from, 'utf8'))).toEqual({ version: 1, origin: 'new' });
        rename(from, to);
      });
      prepareModelDefaultsProfile(database);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(readModelDefaultsProfileOrigin(database)).toBe('new');
      fs.writeFileSync(database, 'created database');
      prepareModelDefaultsProfile(database);
      expect(readModelDefaultsProfileOrigin(database)).toBe('new');
      expect(publish).toHaveBeenCalledTimes(1);
    },
  );

  it('does not replace an authoritative marker found before fallback publication', () => {
    const marker = `${database}.model-defaults-origin.v1.json`;
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      fs.writeFileSync(marker, JSON.stringify({ version: 1, origin: 'existing' }));
      throw Object.assign(new Error('unsupported'), { code: 'EPERM' });
    });
    const rename = vi.spyOn(fs, 'renameSync');
    prepareModelDefaultsProfile(database);
    expect(rename).not.toHaveBeenCalled();
    expect(readModelDefaultsProfileOrigin(database)).toBe('existing');
    expect(JSON.parse(fs.readFileSync(marker, 'utf8')).origin).toBe('existing');
  });

  it('keeps failed fallback publication retryable without exposing a partial marker', () => {
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' });
    });
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    expect(() => prepareModelDefaultsProfile(database)).toThrow('disk full');
    expect(readModelDefaultsProfileOrigin(database)).toBe('pending');
    expect(fs.existsSync(database)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
    rename.mockRestore();
    prepareModelDefaultsProfile(database);
    expect(readModelDefaultsProfileOrigin(database)).toBe('new');
  });

  it('recognizes only the published local snapshot across restart, not a reserved or competing target', () => {
    const snapshot = `${database}.snapshot`;
    fs.writeFileSync(snapshot, 'local snapshot');
    recordModelVisibilityAdoption(database, snapshot);
    expect(readModelDefaultsProfileOrigin(database)).toBe('pending');
    fs.writeFileSync(database, 'existing cloud profile');
    expect(readModelDefaultsProfileOrigin(database)).toBe('existing');
    fs.unlinkSync(database);
    fs.linkSync(snapshot, database);
    fs.unlinkSync(snapshot);
    expect(readModelDefaultsProfileOrigin(database)).toBe('adopted-local');
    prepareModelDefaultsProfile(database);
    expect(readModelDefaultsProfileOrigin(database)).toBe('adopted-local');
    expect(readModelDefaultsProfileOrigin(ownerDatabasePath(root, 'owner-b'))).toBe('pending');
  });

  it('keeps an unreadable adoption receipt pending instead of publishing empty preferences', () => {
    fs.writeFileSync(database, 'adopted profile');
    const marker = `${database}.model-visibility-adoption.v1.json`;
    fs.writeFileSync(marker, '{');
    expect(readModelDefaultsProfileOrigin(database)).toBe('pending');
    fs.renameSync(marker, `${marker}.bak`);
    expect(readModelDefaultsProfileOrigin(database)).toBe('pending');
    expect(fs.existsSync(marker)).toBe(false);
  });

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
