import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-compaction-settings-'));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => tempRoot),
  },
}));

vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: 'test-owner', generation: 1 }),
  ownerScopedUserDataPath: (...parts: string[]) => path.join(tempRoot, ...parts),
}));

import {
  __testing,
  readCompactionState,
  readPiCompactionPct,
  readPiCompactionState,
  resetCompactionPct,
  resetPiCompactionPct,
  writeCompactionPct,
} from '../compaction-settings-store';

describe('compaction settings store', () => {
  beforeEach(() => {
    fs.mkdirSync(tempRoot, { recursive: true });
    __testing.resetStores();
    for (const name of [
      'compaction-settings.json',
      'pi-compaction-settings.json',
      'pi-compaction-migrated.json',
    ]) {
      fs.rmSync(path.join(tempRoot, name), { force: true });
    }
  });

  afterEach(() => {
    __testing.resetStores();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
  });

  it('does not migrate Pi when Claude still follows the default', () => {
    expect(readCompactionState()).toMatchObject({
      isCustomized: false,
      value: { claudeCodeAutoCompactPct: 90 },
    });
    expect(readPiCompactionPct()).toBe(90);
    expect(readPiCompactionState().isCustomized).toBe(false);
    expect(fs.existsSync(path.join(tempRoot, 'pi-compaction-settings.json'))).toBe(false);
  });

  it('copies a customized Claude threshold into Pi only when the Pi file is missing', () => {
    writeCompactionPct(80);
    __testing.resetStores();
    expect(readPiCompactionPct()).toBe(80);
    expect(readPiCompactionState().isCustomized).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(tempRoot, 'pi-compaction-settings.json'), 'utf8'))).toEqual({
      piAutoCompactPct: 80,
    });
  });

  it('leaves an existing Pi override untouched after Claude changes', () => {
    writeCompactionPct(80);
    __testing.resetStores();
    expect(readPiCompactionPct()).toBe(80);
    writeCompactionPct(90);
    resetCompactionPct();
    __testing.resetStores();
    expect(readPiCompactionPct()).toBe(80);
    expect(readPiCompactionState().isCustomized).toBe(true);
  });

  it('repairs a truncated Pi override from the customized Claude threshold before marking migration done', () => {
    writeCompactionPct(80);
    fs.writeFileSync(path.join(tempRoot, 'pi-compaction-settings.json'), '{ "piAutoCompactPct": 8');
    __testing.resetStores();
    expect(readPiCompactionPct()).toBe(80);
    expect(readPiCompactionState().isCustomized).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(tempRoot, 'pi-compaction-settings.json'), 'utf8'))).toEqual({
      piAutoCompactPct: 80,
    });
    expect(fs.existsSync(path.join(tempRoot, 'pi-compaction-migrated.json'))).toBe(true);
  });

  it('does not remigrate Pi after the user restores the Pi default', () => {
    writeCompactionPct(80);
    __testing.resetStores();
    expect(readPiCompactionPct()).toBe(80);
    expect(resetPiCompactionPct()).toBe(90);
    __testing.resetStores();
    expect(readPiCompactionPct()).toBe(90);
    expect(readPiCompactionState().isCustomized).toBe(false);
    expect(fs.existsSync(path.join(tempRoot, 'pi-compaction-settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(tempRoot, 'pi-compaction-migrated.json'))).toBe(true);
  });
});
