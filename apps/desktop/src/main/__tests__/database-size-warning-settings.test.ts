import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:/test-user-data') },
}));
vi.mock('../logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));
vi.mock('../maker-host/override-settings-file.js', () => ({
  createOverrideSettingsFile: vi.fn(() => ({
    read: vi.fn(() => ({ thresholdGiB: 10, disabled: false })),
    readState: vi.fn(() => ({ value: { thresholdGiB: 10, disabled: false }, isCustomized: false })),
    writePatch: vi.fn(),
  })),
}));

import {
  __testing,
  parseDatabaseSizeWarningSettingsPatch,
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
