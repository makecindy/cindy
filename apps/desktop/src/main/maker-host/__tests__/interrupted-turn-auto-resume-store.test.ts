import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-interrupted-resume-settings-'));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tempRoot) },
}));

vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  },
}));

import {
  __testing,
  readInterruptedTurnAutoResumeSettings,
  readInterruptedTurnAutoResumeSettingsState,
  resetInterruptedTurnAutoResumeSettings,
  writeInterruptedTurnAutoResumeEnabled,
} from '../interrupted-turn-auto-resume-store';

const settingsFile = path.join(tempRoot, 'interrupted-turn-auto-resume-settings.json');

describe('interrupted turn auto-resume settings store', () => {
  beforeEach(async () => {
    fs.mkdirSync(tempRoot, { recursive: true });
    await resetInterruptedTurnAutoResumeSettings();
    __testing.invalidate();
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('defaults to enabled without materializing an override file', () => {
    expect(readInterruptedTurnAutoResumeSettings()).toEqual({ enabled: true });
    expect(readInterruptedTurnAutoResumeSettingsState()).toMatchObject({
      value: { enabled: true },
      defaults: { enabled: true },
      isCustomized: false,
    });
    expect(fs.existsSync(settingsFile)).toBe(false);
  });

  it('persists only an explicit opt-out and removes it when restored to the default', async () => {
    await writeInterruptedTurnAutoResumeEnabled(false);
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))).toEqual({ enabled: false });
    expect(readInterruptedTurnAutoResumeSettingsState().isCustomized).toBe(true);

    await writeInterruptedTurnAutoResumeEnabled(true);
    expect(fs.existsSync(settingsFile)).toBe(false);
    expect(readInterruptedTurnAutoResumeSettingsState().isCustomized).toBe(false);
  });

  it('observes an external kill-switch edit without restarting the app', async () => {
    await writeInterruptedTurnAutoResumeEnabled(false);
    const originalTimes = fs.statSync(settingsFile);
    fs.writeFileSync(settingsFile, JSON.stringify({ enabled: true }), 'utf-8');
    fs.utimesSync(settingsFile, originalTimes.atime, originalTimes.mtime);

    expect(readInterruptedTurnAutoResumeSettings()).toEqual({ enabled: true });
  });

  it('preserves malformed configuration, falls back to enabled, and exposes reset', async () => {
    fs.writeFileSync(settingsFile, '{"enabled":', 'utf-8');
    __testing.invalidate();

    expect(readInterruptedTurnAutoResumeSettings()).toEqual({ enabled: true });
    expect(readInterruptedTurnAutoResumeSettingsState().isCustomized).toBe(true);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe('{"enabled":');

    await expect(writeInterruptedTurnAutoResumeEnabled(false)).rejects.toThrow(
      'settings file is unreadable',
    );
    await resetInterruptedTurnAutoResumeSettings();
    expect(fs.existsSync(settingsFile)).toBe(false);
  });
});
