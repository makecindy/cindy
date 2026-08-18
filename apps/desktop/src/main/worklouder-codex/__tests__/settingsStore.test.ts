import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkLouderCodexDefaultSettings } from '../../../shared/workLouderCodex.js';

const electronMock = vi.hoisted(() => ({
  userDataDir: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronMock.userDataDir),
  },
}));

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'cloud:owner-a:1',
  ownerScopedUserDataPath: (...parts: string[]) =>
    path.join(electronMock.userDataDir, 'owners', 'owner-a', ...parts),
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
    expect(__testing.normalize(undefined)).toEqual(createWorkLouderCodexDefaultSettings());
    expect(
      __testing.normalize({
        lightingBrightness: '50',
        lightingAutoDim: 'sometimes',
        singleTapAgentKeys: 1,
      }),
    ).toEqual(createWorkLouderCodexDefaultSettings());
  });

  it('rounds and clamps persisted brightness while preserving valid options', () => {
    expect(
      __testing.normalize({
        lightingBrightness: 49.6,
        lightingAutoDim: '30-seconds',
        singleTapAgentKeys: false,
      }),
    ).toEqual({
      ...createWorkLouderCodexDefaultSettings(),
      lightingBrightness: 50,
      lightingAutoDim: '30-seconds',
      singleTapAgentKeys: false,
    });
    expect(__testing.normalize({ lightingBrightness: -9 }).lightingBrightness).toBe(0);
    expect(__testing.normalize({ lightingBrightness: 999 }).lightingBrightness).toBe(100);
    expect(__testing.normalize({ lightingBrightness: Number.NaN }).lightingBrightness).toBe(100);
  });

  it('maps the old pinned and recent sources onto sidebar order', () => {
    expect(__testing.normalize({ agentSource: 'pinned' }).agentSource).toBe('sidebar');
    expect(__testing.normalize({ agentSource: 'recent' }).agentSource).toBe('sidebar');
    expect(__testing.normalize({ agentSource: 'last-sent' }).agentSource).toBe('last-sent');
  });

  it('persists a patch under the Electron userData directory', () => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklouder-settings-'));

    const next = writeWorkLouderCodexSettingsPatch({
      lightingBrightness: 60,
      lightingAutoDim: '1-minute',
      singleTapAgentKeys: false,
    });

    expect(next).toEqual({
      ...createWorkLouderCodexDefaultSettings(),
      lightingBrightness: 60,
      lightingAutoDim: '1-minute',
      singleTapAgentKeys: false,
    });
    expect(readWorkLouderCodexSettings()).toEqual(next);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            electronMock.userDataDir,
            'owners',
            'owner-a',
            'worklouder-codex-settings.json',
          ),
          'utf-8',
        ),
      ),
    ).toEqual({
      lightingBrightness: 60,
      lightingAutoDim: '1-minute',
    });
  });
});
