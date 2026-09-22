import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const paths = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => paths.userData } }));

import {
  __testing,
  readCindyMakeSettings,
  resetCindyMakeSettings,
  writeCindyMakeSyncLatestBeforeBuild,
} from '../settingsStore.js';

describe('Cindy Make settings store', () => {
  beforeEach(() => {
    paths.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-make-settings-'));
  });

  afterEach(() => {
    fs.rmSync(paths.userData, { recursive: true, force: true });
  });

  it('defaults build-time source sync to off', () => {
    expect(readCindyMakeSettings()).toEqual({ syncLatestBeforeBuild: false });
    expect(__testing.normalize({ syncLatestBeforeBuild: 'true' })).toEqual({
      syncLatestBeforeBuild: false,
    });
  });

  it('persists explicit on and off choices until reset', () => {
    expect(writeCindyMakeSyncLatestBeforeBuild(true)).toEqual({
      syncLatestBeforeBuild: true,
    });
    expect(writeCindyMakeSyncLatestBeforeBuild(false)).toEqual({
      syncLatestBeforeBuild: false,
    });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(paths.userData, 'cindy-make-settings.json'), 'utf8'),
      ),
    ).toEqual({ syncLatestBeforeBuild: false });

    expect(resetCindyMakeSettings()).toEqual({ syncLatestBeforeBuild: false });
    expect(fs.existsSync(path.join(paths.userData, 'cindy-make-settings.json'))).toBe(false);
  });
});
