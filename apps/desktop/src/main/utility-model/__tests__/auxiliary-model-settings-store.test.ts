import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dir: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return h.dir;
      throw new Error(`unexpected path ${name}`);
    },
  },
}));

vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(h.dir, 'owner', ...parts),
  activeOwnerScopeKey: () => 'test-owner',
}));

vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  isAuxiliaryModelCustomized,
  readAuxiliaryModelSettings,
  readAuxiliaryModelSettingsState,
  writeAuxiliaryModelSettingsPatch,
  __testing,
} from '../auxiliary-model-settings-store.js';

const TITLE_PIN = 'cat:openai:codex:gpt-5.4-mini';
const PROMPT_PIN = 'cat:xd:claude-code:kimi-k2.5';
const CUSTOM_MODEL_PIN = 'cat:xd:codex:moonshotai/kimi-k2.6-custom';

function settingsPath(): string {
  return path.join(h.dir, 'owner', 'auxiliary-model-settings.json');
}

function ownerVoicePath(): string {
  return path.join(h.dir, 'owner', 'voice-input-models.json');
}

function unscopedVoicePath(): string {
  return path.join(h.dir, 'voice-input-models.json');
}

function migrationStatePath(): string {
  return path.join(h.dir, 'owner', 'auxiliary-model-settings-migration.json');
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value), 'utf8');
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

describe('auxiliary-model-settings-store', () => {
  beforeEach(() => {
    h.dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-auxiliary-model-'));
    mkdirSync(path.join(h.dir, 'owner'), { recursive: true });
  });

  afterEach(() => {
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('treats an empty models list as automatic', () => {
    expect(readAuxiliaryModelSettings()).toEqual({ models: [] });
    expect(isAuxiliaryModelCustomized()).toBe(false);
    expect(readAuxiliaryModelSettingsState().customizedKeys).toEqual([]);
  });

  it('persists a unique custom list and reports it as customized', async () => {
    await writeAuxiliaryModelSettingsPatch({ models: [TITLE_PIN, PROMPT_PIN, TITLE_PIN] });

    expect(readAuxiliaryModelSettings()).toEqual({ models: [TITLE_PIN, PROMPT_PIN] });
    expect(isAuxiliaryModelCustomized()).toBe(true);
    expect(readJson(settingsPath())).toEqual({ models: [TITLE_PIN, PROMPT_PIN] });
  });

  it('deletes the override file when restoring the empty automatic list', async () => {
    await writeAuxiliaryModelSettingsPatch({ models: [TITLE_PIN] });
    await writeAuxiliaryModelSettingsPatch({ models: [] });

    expect(readAuxiliaryModelSettings()).toEqual({ models: [] });
    expect(isAuxiliaryModelCustomized()).toBe(false);
    expect(() => readFileSync(settingsPath())).toThrow();
  });

  it('keeps an existing models array and leaves legacy voice settings untouched', () => {
    writeJson(settingsPath(), {
      models: [TITLE_PIN],
      sessionTitleModel: PROMPT_PIN,
    });
    writeJson(ownerVoicePath(), {
      refinerProvider: 'litellm-kimi-k2.6',
      sttProvider: 'cindy-voice',
    });

    expect(readAuxiliaryModelSettings()).toEqual({ models: [TITLE_PIN] });
    expect(readJson(settingsPath())).toEqual({
      models: [TITLE_PIN],
      sessionTitleModel: PROMPT_PIN,
    });
    expect(readJson(ownerVoicePath())).toEqual({
      refinerProvider: 'litellm-kimi-k2.6',
      sttProvider: 'cindy-voice',
    });
  });

  it('migrates legacy dual pins with the title pin first', () => {
    writeJson(settingsPath(), {
      sessionTitleModel: TITLE_PIN,
      promptRecommendationModel: PROMPT_PIN,
    });

    expect(readAuxiliaryModelSettings()).toEqual({ models: [TITLE_PIN, PROMPT_PIN] });
    expect(readJson(settingsPath())).toEqual({ models: [TITLE_PIN, PROMPT_PIN] });
  });

  it('migrates a legacy voice chain when auxiliary settings were never customized', () => {
    writeJson(ownerVoicePath(), {
      utilityModelProvider: 'litellm-kimi-k2.6',
      utilityModel: 'moonshotai/kimi-k2.6-custom',
      utilityModelProviderChain: ['codex-gpt-5.4-mini', 'litellm-kimi-k2.6'],
      refinerProvider: 'codex-gpt-5.4-mini',
      refinerModel: 'gpt-5.4-mini-custom',
      refinerProviderChain: ['codex-gpt-5.4-mini', 'litellm-kimi-k2.6'],
      sttProvider: 'cindy-voice',
    });

    expect(readAuxiliaryModelSettings()).toEqual({
      models: [CUSTOM_MODEL_PIN, 'codex-gpt-5.4-mini', 'litellm-kimi-k2.6'],
    });
    expect(readJson(ownerVoicePath())).toEqual({
      utilityModelProvider: 'litellm-kimi-k2.6',
      utilityModel: 'moonshotai/kimi-k2.6-custom',
      utilityModelProviderChain: ['codex-gpt-5.4-mini', 'litellm-kimi-k2.6'],
      refinerProvider: 'codex-gpt-5.4-mini',
      refinerModel: 'gpt-5.4-mini-custom',
      refinerProviderChain: ['codex-gpt-5.4-mini', 'litellm-kimi-k2.6'],
      sttProvider: 'cindy-voice',
    });
    expect(readJson(migrationStatePath())).toEqual({ legacyVoiceMigrationCompleted: true });
  });

  it('does not re-import the legacy voice chain after restoring automatic defaults', async () => {
    writeJson(ownerVoicePath(), {
      refinerProvider: 'litellm-kimi-k2.6',
      refinerProviderChain: ['litellm-kimi-k2.6', 'litellm-deepseek-v4-flash'],
    });

    expect(readAuxiliaryModelSettings()).toEqual({
      models: ['litellm-kimi-k2.6', 'litellm-deepseek-v4-flash'],
    });

    await writeAuxiliaryModelSettingsPatch({ models: [] });

    expect(readAuxiliaryModelSettings()).toEqual({ models: [] });
    expect(isAuxiliaryModelCustomized()).toBe(false);
    expect(() => readFileSync(settingsPath())).toThrow();
    expect(readJson(migrationStatePath())).toEqual({ legacyVoiceMigrationCompleted: true });
  });

  it('lets a customized auxiliary list win over a customized voice chain', () => {
    writeJson(settingsPath(), {
      sessionTitleModel: TITLE_PIN,
      promptRecommendationModel: PROMPT_PIN,
    });
    writeJson(unscopedVoicePath(), {
      refinerProvider: 'litellm-deepseek-v4-flash',
      refinerProviderChain: ['litellm-deepseek-v4-flash', 'codex-gpt-5.4-mini'],
    });

    expect(readAuxiliaryModelSettings()).toEqual({ models: [TITLE_PIN, PROMPT_PIN] });
    expect(readJson(unscopedVoicePath())).toEqual({
      refinerProvider: 'litellm-deepseek-v4-flash',
      refinerProviderChain: ['litellm-deepseek-v4-flash', 'codex-gpt-5.4-mini'],
    });
  });

  it('does not migrate a leftover voice file a second time after models already exist', () => {
    writeJson(settingsPath(), { models: [TITLE_PIN] });
    writeJson(ownerVoicePath(), {
      refinerProvider: 'litellm-kimi-k2.6',
      refinerProviderChain: ['litellm-kimi-k2.6', 'litellm-deepseek-v4-flash'],
    });

    expect(readAuxiliaryModelSettings()).toEqual({ models: [TITLE_PIN] });
    expect(readJson(settingsPath())).toEqual({ models: [TITLE_PIN] });
    expect(readJson(ownerVoicePath())).toEqual({
      refinerProvider: 'litellm-kimi-k2.6',
      refinerProviderChain: ['litellm-kimi-k2.6', 'litellm-deepseek-v4-flash'],
    });
  });

  it('exposes the same list normalization used on persist', () => {
    expect(__testing.normalize({ models: [TITLE_PIN, '  ', TITLE_PIN, PROMPT_PIN] })).toEqual({
      models: [TITLE_PIN, PROMPT_PIN],
    });
  });

  it('preserves a legacy provider model override as the matching profile', () => {
    expect(__testing.legacyVoiceOverrideRefs({
      refinerProvider: 'litellm',
      refinerModel: 'qwen/qwen3.6-plus',
    })).toEqual(['litellm-qwen3.6-plus']);
  });
});
