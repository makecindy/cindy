import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readCommitAttributionSettingsState,
  resetCommitAttributionSettings,
  writeCommitAttributionEnabled,
  type CommitAttributionSettings,
} from '../../maker-host/commit-attribution-settings-store.js';
import type { OverrideSettingsState } from '../../maker-host/override-settings-file.js';
import { createCommitAttributionSettingsIpc } from '../commit-attribution-settings-ipc.js';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected path: ${name}`);
      return userDataDir;
    },
  },
}));

function settingsFile(): string {
  return path.join(userDataDir, 'commit-attribution-settings.json');
}

function state(
  enabled: boolean,
  customized = enabled !== true,
): OverrideSettingsState<CommitAttributionSettings> {
  return {
    value: { enabled },
    defaults: { enabled: true },
    isCustomized: customized,
    customizedKeys: customized ? ['enabled'] : [],
  };
}

describe('commit attribution settings', () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-commit-attribution-'));
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('persists only the opt-out and removes it through either restore path', () => {
    expect(readCommitAttributionSettingsState()).toMatchObject({
      value: { enabled: true },
      isCustomized: false,
      customizedKeys: [],
    });

    expect(writeCommitAttributionEnabled(false)).toMatchObject({
      value: { enabled: false },
      isCustomized: true,
      customizedKeys: ['enabled'],
    });
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))).toEqual({ enabled: false });

    expect(writeCommitAttributionEnabled(true).isCustomized).toBe(false);
    expect(fs.existsSync(settingsFile())).toBe(false);

    writeCommitAttributionEnabled(false);
    expect(resetCommitAttributionSettings().value.enabled).toBe(true);
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it('applies trusted IPC writes and restores the default', () => {
    let current = state(true, false);
    const trusted = vi.fn();
    const ipc = createCommitAttributionSettingsIpc({
      assertTrustedSender: trusted,
      readState: () => current,
      write: (enabled) => {
        current = state(enabled);
        return current;
      },
      reset: () => {
        current = state(true, false);
        return current;
      },
    });

    expect(ipc.set('renderer', false)).toMatchObject({
      enabled: false,
      isCustomized: true,
      defaultEnabled: true,
      effective: 'new-agent-sessions',
    });
    expect(ipc.get('renderer').enabled).toBe(false);
    expect(ipc.reset('renderer')).toMatchObject({ enabled: true, isCustomized: false });
    expect(trusted).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid input and hides persistence failures behind IPC errors', () => {
    const ipc = createCommitAttributionSettingsIpc({
      assertTrustedSender: () => undefined,
      readState: () => state(true, false),
      write: () => { throw new Error('/private/settings.json: disk full'); },
      reset: () => { throw new Error('/private/settings.json: disk full'); },
    });

    expect(() => ipc.set('renderer', 'false')).toThrow('[INVALID_PARAMS]');
    expect(() => ipc.set('renderer', false)).toThrow('[INTERNAL] commit attribution setting write failed');
    expect(() => ipc.set('renderer', false)).not.toThrow('/private/settings.json');
    expect(() => ipc.reset('renderer')).toThrow('[INTERNAL] commit attribution setting reset failed');
  });
});
