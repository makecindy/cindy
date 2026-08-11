import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  userDataDir: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronMock.userDataDir),
  },
}));

vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

import {
  __testing,
  readWorkLouderCodexSettings,
  writeWorkLouderCodexSettingsPatch,
} from '../settingsStore.js';

describe('Work Louder Codex settings store', () => {
  afterEach(() => {
    if (electronMock.userDataDir) {
      fs.rmSync(electronMock.userDataDir, { recursive: true, force: true });
      electronMock.userDataDir = '';
    }
  });

  it('uses the shipped defaults for missing or invalid persisted values', () => {
    expect(__testing.normalize(undefined)).toEqual({
      lightingBrightness: 100,
      lightingAutoDim: '3-minutes',
      singleTapAgentKeys: true,
    });
    expect(
      __testing.normalize({
        lightingBrightness: '50',
        lightingAutoDim: 'sometimes',
        singleTapAgentKeys: 1,
      }),
    ).toEqual({
      lightingBrightness: 100,
      lightingAutoDim: '3-minutes',
      singleTapAgentKeys: true,
    });
  });

  it('rounds and clamps persisted brightness while preserving valid options', () => {
    expect(
      __testing.normalize({
        lightingBrightness: 49.6,
        lightingAutoDim: '30-seconds',
        singleTapAgentKeys: false,
      }),
    ).toEqual({
      lightingBrightness: 50,
      lightingAutoDim: '30-seconds',
      singleTapAgentKeys: false,
    });
    expect(__testing.normalize({ lightingBrightness: -9 }).lightingBrightness).toBe(0);
    expect(__testing.normalize({ lightingBrightness: 999 }).lightingBrightness).toBe(100);
    expect(__testing.normalize({ lightingBrightness: Number.NaN }).lightingBrightness).toBe(100);
  });

  it('persists a patch under the Electron userData directory', () => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklouder-settings-'));

    const next = writeWorkLouderCodexSettingsPatch({
      lightingBrightness: 60,
      lightingAutoDim: '1-minute',
      singleTapAgentKeys: false,
    });

    expect(next).toEqual({
      lightingBrightness: 60,
      lightingAutoDim: '1-minute',
      singleTapAgentKeys: false,
    });
    expect(readWorkLouderCodexSettings()).toEqual(next);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(electronMock.userDataDir, 'worklouder-codex-settings.json'),
          'utf-8',
        ),
      ),
    ).toEqual(next);
  });
});
