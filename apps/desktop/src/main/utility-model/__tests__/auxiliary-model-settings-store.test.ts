import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dir: '',
  mode: 'cloud' as 'cloud' | 'local' | 'signed-out',
  ownerId: 'test-owner' as string | null,
  exclusive: true,
  exclusiveReads: [] as boolean[],
  legacyClaim: true,
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
  getActiveAppSession: () => ({
    mode: h.mode,
    dataOwnerId: h.ownerId,
    generation: 0,
  }),
}));

vi.mock('../../ownerNamespaceMigration.js', () => ({
  hasExclusiveSharedLegacyUserDataAccess: () => h.exclusiveReads.shift() ?? h.exclusive,
  hasLegacyOwnerNamespaceClaim: () => h.legacyClaim,
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
    h.mode = 'cloud';
    h.ownerId = 'test-owner';
    h.exclusive = true;
    h.exclusiveReads = [];
    h.legacyClaim = true;
    mkdirSync(path.join(h.dir, 'owner'), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it('migrates legacy dual pins with the title pin first', async () => {
    writeJson(settingsPath(), {
      sessionTitleModel: TITLE_PIN,
      promptRecommendationModel: PROMPT_PIN,
    });

    expect(readAuxiliaryModelSettings()).toEqual({ models: [TITLE_PIN, PROMPT_PIN] });
    await __testing.flushLegacyMigration();
    expect(readJson(settingsPath())).toEqual({ models: [TITLE_PIN, PROMPT_PIN] });
  });

  it('defers legacy migration while shared userData is not exclusive', async () => {
    writeJson(settingsPath(), {
      sessionTitleModel: TITLE_PIN,
      promptRecommendationModel: PROMPT_PIN,
    });
    h.exclusive = false;

    expect(readAuxiliaryModelSettings()).toEqual({ models: [TITLE_PIN, PROMPT_PIN] });
    await __testing.flushLegacyMigration();
    expect(readJson(settingsPath())).toEqual({
      sessionTitleModel: TITLE_PIN,
      promptRecommendationModel: PROMPT_PIN,
    });

    h.exclusive = true;
    expect(readAuxiliaryModelSettings()).toEqual({ models: [TITLE_PIN, PROMPT_PIN] });
    await __testing.flushLegacyMigration();
    expect(readJson(settingsPath())).toEqual({ models: [TITLE_PIN, PROMPT_PIN] });
  });

  it('rechecks shared-userData exclusivity after waiting for the migration lock', async () => {
    writeJson(settingsPath(), {
      sessionTitleModel: TITLE_PIN,
      promptRecommendationModel: PROMPT_PIN,
    });
    // First check passes, but another shared instance appears before the
    // updateAtomic callback obtains its lock.
    h.exclusiveReads = [true, false];

    expect(readAuxiliaryModelSettings()).toEqual({ models: [TITLE_PIN, PROMPT_PIN] });
    await __testing.flushLegacyMigration();
    expect(readJson(settingsPath())).toEqual({
      sessionTitleModel: TITLE_PIN,
      promptRecommendationModel: PROMPT_PIN,
    });

    h.exclusive = true;
    expect(readAuxiliaryModelSettings()).toEqual({ models: [TITLE_PIN, PROMPT_PIN] });
    await __testing.flushLegacyMigration();
    expect(readJson(settingsPath())).toEqual({ models: [TITLE_PIN, PROMPT_PIN] });
  });

  it('seals legacy voice migration when old auxiliary pins win, so reset stays automatic', async () => {
    writeJson(settingsPath(), {
      sessionTitleModel: TITLE_PIN,
      promptRecommendationModel: PROMPT_PIN,
    });
    writeJson(ownerVoicePath(), {
      refinerProvider: 'litellm-kimi-k2.6',
      refinerProviderChain: ['litellm-kimi-k2.6', 'litellm-deepseek-v4-flash'],
    });

    expect(readAuxiliaryModelSettings()).toEqual({ models: [TITLE_PIN, PROMPT_PIN] });
    await __testing.flushLegacyMigration();
    expect(readJson(migrationStatePath())).toEqual({ legacyVoiceMigrationCompleted: true });

    await writeAuxiliaryModelSettingsPatch({ models: [] });

    expect(readAuxiliaryModelSettings()).toEqual({ models: [] });
    expect(isAuxiliaryModelCustomized()).toBe(false);
    expect(() => readFileSync(settingsPath())).toThrow();
    expect(readJson(migrationStatePath())).toEqual({ legacyVoiceMigrationCompleted: true });
  });

  it('migrates a legacy voice chain when auxiliary settings were never customized', async () => {
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
    await __testing.flushLegacyMigration();
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

  it('merges legacy file pins with the environment-provided fallback chain', async () => {
    vi.stubEnv('XDT_UTILITY_MODEL_PROVIDER_CHAIN', 'codex-gpt-5.4-mini,litellm-deepseek-v4-flash');
    writeJson(ownerVoicePath(), {
      utilityModelProvider: 'litellm-kimi-k2.6',
    });

    expect(readAuxiliaryModelSettings()).toEqual({
      models: ['litellm-kimi-k2.6', 'codex-gpt-5.4-mini', 'litellm-deepseek-v4-flash'],
    });
    await __testing.flushLegacyMigration();
    expect(readJson(settingsPath())).toEqual({
      models: ['litellm-kimi-k2.6', 'codex-gpt-5.4-mini', 'litellm-deepseek-v4-flash'],
    });
  });

  it('keeps an environment-only legacy chain dynamic', async () => {
    vi.stubEnv('XDT_UTILITY_MODEL_PROVIDER_CHAIN', 'litellm-kimi-k2.6,litellm-deepseek-v4-flash');

    expect(readAuxiliaryModelSettings()).toEqual({ models: [] });
    await __testing.flushLegacyMigration();

    expect(() => readFileSync(settingsPath())).toThrow();
    expect(() => readFileSync(migrationStatePath())).toThrow();
  });

  it('does not import the unscoped legacy voice file without a claimed cloud owner', async () => {
    writeJson(unscopedVoicePath(), {
      refinerProvider: 'litellm-kimi-k2.6',
      refinerProviderChain: ['litellm-kimi-k2.6', 'litellm-deepseek-v4-flash'],
    });
    h.mode = 'local';
    h.ownerId = 'local-owner';
    h.legacyClaim = false;

    expect(readAuxiliaryModelSettings()).toEqual({ models: [] });
    await __testing.flushLegacyMigration();
    expect(() => readFileSync(settingsPath())).toThrow();

    h.mode = 'cloud';
    h.ownerId = 'test-owner';
    h.legacyClaim = true;
    expect(readAuxiliaryModelSettings()).toEqual({
      models: ['litellm-kimi-k2.6', 'litellm-deepseek-v4-flash'],
    });
    await __testing.flushLegacyMigration();
    expect(readJson(settingsPath())).toEqual({
      models: ['litellm-kimi-k2.6', 'litellm-deepseek-v4-flash'],
    });
  });

  it('does not re-import the legacy voice chain after restoring automatic defaults', async () => {
    writeJson(ownerVoicePath(), {
      refinerProvider: 'litellm-kimi-k2.6',
      refinerProviderChain: ['litellm-kimi-k2.6', 'litellm-deepseek-v4-flash'],
    });

    expect(readAuxiliaryModelSettings()).toEqual({
      models: ['litellm-kimi-k2.6', 'litellm-deepseek-v4-flash'],
    });
    await __testing.flushLegacyMigration();

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
    expect(
      __testing.legacyVoiceOverrideRefs({
        refinerProvider: 'litellm',
        refinerModel: 'qwen/qwen3.6-plus',
      }),
    ).toEqual(['litellm-qwen3.6-plus']);
  });

  it('keeps legacy refiner file fields ahead of utility environment overrides', () => {
    vi.stubEnv('XDT_UTILITY_MODEL_PROVIDER', 'litellm-deepseek-v4-flash');
    vi.stubEnv('XDT_UTILITY_MODEL_PROVIDER_CHAIN', 'codex-gpt-5.4-mini');

    expect(
      __testing.legacyVoiceOverrideRefs({
        refinerProvider: 'litellm-kimi-k2.6',
        refinerProviderChain: ['litellm-qwen3.6-plus'],
      }),
    ).toEqual(['litellm-kimi-k2.6', 'litellm-qwen3.6-plus']);
  });

  it('keeps the implicit default head when migrating a legacy fallback-only chain', () => {
    expect(
      __testing.legacyVoiceOverrideRefs({
        refinerProviderChain: ['litellm-kimi-k2.6', 'litellm-deepseek-v4-flash'],
      }),
    ).toEqual(['codex-gpt-5.4-mini', 'litellm-kimi-k2.6', 'litellm-deepseek-v4-flash']);
  });
});
