import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:/test-user-data') },
}));
vi.mock('../logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

import {
  __testing,
  parseDatabaseSizeWarningSettingsPatch,
  readDatabaseSizeWarningSettings,
  readDatabaseSizeWarningSettingsState,
  writeDatabaseSizeWarningSettings,
  resetDatabaseSizeWarningSettings,
} from '../database-size-warning-settings';

describe('database size warning settings normalization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses defaults for missing or invalid values', () => {
    expect(__testing.normalize(null)).toEqual(__testing.DEFAULTS);
    expect(__testing.normalize({ thresholdGiB: 0, disabled: 'yes' })).toEqual(__testing.DEFAULTS);
    expect(__testing.normalize({ thresholdGiB: 2048, disabled: false })).toEqual(__testing.DEFAULTS);
  });

  it('keeps valid threshold and disabled values', () => {
    expect(__testing.normalize({ thresholdGiB: 25, disabled: true })).toEqual({
      thresholdGiB: 25,
      disabled: true,
    });
    expect(__testing.normalize({ thresholdGiB: 1, disabled: false })).toEqual({
      thresholdGiB: 1,
      disabled: false,
    });
    expect(__testing.normalize({ thresholdGiB: 1024, disabled: false })).toEqual({
      thresholdGiB: 1024,
      disabled: false,
    });
  });

  it('accepts valid IPC patches and rejects invalid payloads', () => {
    expect(parseDatabaseSizeWarningSettingsPatch({ thresholdGiB: 20 })).toEqual({
      patch: { thresholdGiB: 20 },
    });
    expect(parseDatabaseSizeWarningSettingsPatch({ disabled: true })).toEqual({
      patch: { disabled: true },
    });
    expect(parseDatabaseSizeWarningSettingsPatch({})).toEqual({
      error: 'at least one setting is required',
    });
    expect(parseDatabaseSizeWarningSettingsPatch({ thresholdGiB: 0 })).toEqual({
      error: 'thresholdGiB must be between 1 and 1024',
    });
    expect(parseDatabaseSizeWarningSettingsPatch({ disabled: 'true' })).toEqual({
      error: 'disabled must be a boolean',
    });
  });
});

describe('database size warning settings persistence', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-db-warning-test-'));
    file = path.join(dir, 'database-size-warning-settings.json');
    vi.mocked(app.getPath).mockReturnValue(dir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('merges concurrent patches from independently cached stores', async () => {
    const other = createOverrideSettingsFile({
      filePath: () => file,
      defaults: __testing.DEFAULTS,
      normalize: __testing.normalize,
      log: { info: vi.fn(), warn: vi.fn() },
      label: 'other-db-warning-process',
    });
    expect(readDatabaseSizeWarningSettings()).toEqual(__testing.DEFAULTS);
    expect(other.read()).toEqual(__testing.DEFAULTS);

    await Promise.all([
      writeDatabaseSizeWarningSettings({ disabled: true }),
      other.writePatchAtomic({ thresholdGiB: 25 }),
    ]);

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      disabled: true, thresholdGiB: 25,
    });
    expect(readDatabaseSizeWarningSettingsState()).toMatchObject({
      value: { disabled: true, thresholdGiB: 25 }, isCustomized: true,
    });
  });

  it('removes overrides when restoring defaults', async () => {
    await writeDatabaseSizeWarningSettings({ disabled: true, thresholdGiB: 25 });
    expect(readDatabaseSizeWarningSettingsState().isCustomized).toBe(true);

    await expect(resetDatabaseSizeWarningSettings()).resolves.toEqual(__testing.DEFAULTS);
    expect(fs.existsSync(file)).toBe(false);
    expect(readDatabaseSizeWarningSettingsState().isCustomized).toBe(false);
  });

  it.each(['mkdirSync', 'writeFileSync', 'renameSync'] as const)(
    'maps %s failures to a path-free IPC error', async (operation) => {
      vi.spyOn(fs, operation).mockImplementationOnce(() => {
        throw new Error(`EACCES: ${file}`);
      });

      await expect(writeDatabaseSizeWarningSettings({ thresholdGiB: 25 })).rejects.toMatchObject({
        code: 'INTERNAL',
        message: '[INTERNAL] failed to save database size warning settings',
      });
    },
  );

  it('reports a failed reset and retains persisted overrides', async () => {
    await writeDatabaseSizeWarningSettings({ thresholdGiB: 25 });
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw new Error(`EACCES: ${file}`);
    });

    await expect(resetDatabaseSizeWarningSettings()).rejects.toMatchObject({
      code: 'INTERNAL',
      message: '[INTERNAL] failed to reset database size warning settings',
    });
    expect(readDatabaseSizeWarningSettingsState()).toMatchObject({
      value: { thresholdGiB: 25 }, isCustomized: true,
    });
  });
});
