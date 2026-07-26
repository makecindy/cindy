import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/cindy-subagent-model-test'),
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
  ownerScopedUserDataPath: (...parts: string[]) => path.join('/tmp/cindy-subagent-model-test', ...parts),
}));

import {
  __testing,
  readSubagentModelSettings,
  resetSubagentModelSettings,
  writeSubagentModelSettingsPatch,
} from '../subagent-model-settings-store';

const settingsDir = '/tmp/cindy-subagent-model-test';
const settingsFile = path.join(settingsDir, 'subagent-model-settings.json');

describe('subagent model settings store', () => {
  beforeEach(() => {
    fs.mkdirSync(settingsDir, { recursive: true });
    resetSubagentModelSettings();
  });

  afterEach(() => {
    resetSubagentModelSettings();
    fs.rmSync(settingsDir, { recursive: true, force: true });
  });

  it('defaults both agents to no override', () => {
    expect(readSubagentModelSettings()).toEqual({
      claudeCode: null,
      claudeCodeProviderId: null,
      codex: null,
      codexProviderId: null,
    });
  });

  it('persists only the configured Claude model', () => {
    writeSubagentModelSettingsPatch({ claudeCode: 'claude-haiku-4-5-20251001' });

    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))).toEqual({
      claudeCode: 'claude-haiku-4-5-20251001',
    });
    expect(readSubagentModelSettings()).toEqual({
      claudeCode: 'claude-haiku-4-5-20251001',
      claudeCodeProviderId: null,
      codex: null,
      codexProviderId: null,
    });
  });

  it('persists (model, providerId) written in one patch', () => {
    writeSubagentModelSettingsPatch({
      claudeCode: 'claude-opus-5',
      claudeCodeProviderId: 'anthropic',
    });

    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))).toEqual({
      claudeCode: 'claude-opus-5',
      claudeCodeProviderId: 'anthropic',
    });
    expect(readSubagentModelSettings()).toEqual({
      claudeCode: 'claude-opus-5',
      claudeCodeProviderId: 'anthropic',
      codex: null,
      codexProviderId: null,
    });
  });

  it('removes the override file when Claude returns to unspecified', () => {
    writeSubagentModelSettingsPatch({ claudeCode: 'claude-haiku-4-5-20251001' });
    writeSubagentModelSettingsPatch({ claudeCode: null });

    expect(fs.existsSync(settingsFile)).toBe(false);
    expect(readSubagentModelSettings().claudeCode).toBeNull();
  });

  it('clearing the model together with providerId removes the whole override', () => {
    writeSubagentModelSettingsPatch({
      claudeCode: 'claude-opus-5',
      claudeCodeProviderId: 'anthropic',
    });
    writeSubagentModelSettingsPatch({ claudeCode: null, claudeCodeProviderId: null });

    expect(fs.existsSync(settingsFile)).toBe(false);
    expect(readSubagentModelSettings()).toEqual({
      claudeCode: null,
      claudeCodeProviderId: null,
      codex: null,
      codexProviderId: null,
    });
  });

  it('normalizes malformed disk values to no override', () => {
    expect(
      __testing.normalize({
        claudeCode: '  claude-sonnet-4-6  ',
        claudeCodeProviderId: 42,
        codex: 'bad\nmodel',
        codexProviderId: '  xd  ',
      }),
    ).toEqual({
      claudeCode: 'claude-sonnet-4-6',
      claudeCodeProviderId: null,
      codex: null,
      codexProviderId: 'xd',
    });
  });
});
