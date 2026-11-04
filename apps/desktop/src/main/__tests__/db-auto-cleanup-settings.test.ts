import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testing,
  DB_AUTO_CLEANUP_DEFAULT_COOLDOWN_DAYS,
  DB_AUTO_CLEANUP_DEFAULT_RETENTION_DAYS,
  DB_AUTO_CLEANUP_SETTINGS_FILE_NAME,
  dbAutoCleanupArchiveAgeForRetentionDays,
  dbAutoCleanupRetentionCutoffMs,
  readDbAutoCleanupSettings,
  recordDbAutoCleanupRun,
} from '../db-auto-cleanup-settings';

const log = { info: vi.fn(), warn: vi.fn() };

let userDataDir: string;
let settingsPath: string;

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-db-auto-cleanup-'));
  settingsPath = path.join(userDataDir, DB_AUTO_CLEANUP_SETTINGS_FILE_NAME);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('db auto cleanup settings', () => {
  it('falls back to defaults when the file is missing or unreadable', () => {
    expect(readDbAutoCleanupSettings(userDataDir, log)).toEqual(__testing.DEFAULTS);
    expect(__testing.DEFAULTS).toMatchObject({
      enabled: true,
      retentionDays: DB_AUTO_CLEANUP_DEFAULT_RETENTION_DAYS,
      cooldownDays: DB_AUTO_CLEANUP_DEFAULT_COOLDOWN_DAYS,
      lastAutoRunAt: null,
    });

    fs.writeFileSync(settingsPath, '{ not json', 'utf8');
    expect(readDbAutoCleanupSettings(userDataDir, log)).toEqual(__testing.DEFAULTS);
    // The unreadable file is kept so a hand-edited config is never destroyed.
    expect(fs.existsSync(settingsPath)).toBe(true);
  });

  it('keeps valid overrides and rejects out-of-range values', () => {
    expect(
      __testing.normalize({
        enabled: false,
        retentionDays: 90,
        minMessageCount: 25,
        minEstimatedMessageBytes: 4_096,
        cooldownDays: 30,
        lastAutoRunAt: 1_700_000_000_000,
      }),
    ).toEqual({
      enabled: false,
      retentionDays: 90,
      minMessageCount: 25,
      minEstimatedMessageBytes: 4_096,
      cooldownDays: 30,
      lastAutoRunAt: 1_700_000_000_000,
    });

    expect(
      __testing.normalize({
        enabled: 'yes',
        // 30 days cannot be expressed by the shared archive-age enum, but it is
        // a valid retention preset and must survive normalization.
        retentionDays: 30,
        minMessageCount: 0,
        minEstimatedMessageBytes: -1,
        cooldownDays: 0,
        lastAutoRunAt: -5,
      }),
    ).toEqual(__testing.DEFAULTS);
  });

  it('maps retention presets onto the shared archive-age enum', () => {
    // A raw `30` in `archiveAgeMonths` makes the persisted request unreadable
    // (`isArchiveAge` only accepts '7-days' | 1 | 3 | 6).
    expect(dbAutoCleanupArchiveAgeForRetentionDays(7)).toBe('7-days');
    expect(dbAutoCleanupArchiveAgeForRetentionDays(30)).toBe(1);
    expect(dbAutoCleanupArchiveAgeForRetentionDays(90)).toBe(3);
    expect(dbAutoCleanupArchiveAgeForRetentionDays(180)).toBe(6);
    expect(dbAutoCleanupRetentionCutoffMs(10 * 86_400_000, 30)).toBe(-20 * 86_400_000);
  });

  it('persists the cooldown stamp without dropping other overrides', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ retentionDays: 90 }), 'utf8');

    recordDbAutoCleanupRun(userDataDir, 1_700_000_000_000, log);

    expect(readDbAutoCleanupSettings(userDataDir, log)).toMatchObject({
      retentionDays: 90,
      lastAutoRunAt: 1_700_000_000_000,
    });
    // The stamp must survive the renderer reading and deleting the last result,
    // which is why it does not live in db-slimming-result.json.
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toMatchObject({
      retentionDays: 90,
      lastAutoRunAt: 1_700_000_000_000,
    });
  });

  it('keeps startup running when the cooldown stamp cannot be written', () => {
    fs.writeFileSync(settingsPath, '{ not json', 'utf8');

    expect(() => recordDbAutoCleanupRun(userDataDir, 1_700_000_000_000, log)).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(
      'database auto cleanup cooldown could not be recorded',
      expect.objectContaining({ error: expect.any(String) }),
    );
  });
});
