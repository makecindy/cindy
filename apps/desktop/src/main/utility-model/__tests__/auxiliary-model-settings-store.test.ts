import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/cindy-auxiliary-model-test') },
}));

vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn() }),
  },
}));

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'test-owner:1',
  ownerScopedUserDataPath: (...parts: string[]) =>
    path.join('/tmp/cindy-auxiliary-model-test', ...parts),
}));

import {
  __testing,
  readAuxiliaryModelSelection,
  readAuxiliaryModelSettings,
  readAuxiliaryModelSettingsState,
  resetAuxiliaryModelSettings,
  writeAuxiliaryModelSettingsPatch,
} from '../auxiliary-model-settings-store.js';

const settingsDir = '/tmp/cindy-auxiliary-model-test';
const settingsFile = path.join(settingsDir, 'auxiliary-model-settings.json');
const TITLE_PIN = 'cat:openrouter:codex:openai/gpt-5-mini';
const RECOMMENDATION_PIN = 'cat:anthropic:claude-code:claude-haiku-4-5';

describe('auxiliary model settings store', () => {
  beforeEach(async () => {
    fs.mkdirSync(settingsDir, { recursive: true });
    await resetAuxiliaryModelSettings();
  });

  afterEach(async () => {
    await resetAuxiliaryModelSettings();
    fs.rmSync(settingsDir, { recursive: true, force: true });
  });

  it('defaults both auxiliary tasks to their existing automatic routes', () => {
    expect(readAuxiliaryModelSettings()).toEqual({
      sessionTitleModel: null,
      promptRecommendationModel: null,
    });
    expect(readAuxiliaryModelSettingsState()).toMatchObject({
      isCustomized: false,
      customizedKeys: [],
    });
  });

  it('persists the two model selections independently as overrides', async () => {
    await writeAuxiliaryModelSettingsPatch({ sessionTitleModel: TITLE_PIN });
    await writeAuxiliaryModelSettingsPatch({
      promptRecommendationModel: RECOMMENDATION_PIN,
    });

    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))).toEqual({
      sessionTitleModel: TITLE_PIN,
      promptRecommendationModel: RECOMMENDATION_PIN,
    });
    expect(readAuxiliaryModelSelection('sessionTitleModel')).toEqual({
      pin: TITLE_PIN,
      providerId: 'openrouter',
      agentKind: 'codex',
      model: 'openai/gpt-5-mini',
    });
    expect(readAuxiliaryModelSelection('promptRecommendationModel')).toEqual({
      pin: RECOMMENDATION_PIN,
      providerId: 'anthropic',
      agentKind: 'claude-code',
      model: 'claude-haiku-4-5',
    });
  });

  it('removes only the restored key, then removes the file at all defaults', async () => {
    await writeAuxiliaryModelSettingsPatch({
      sessionTitleModel: TITLE_PIN,
      promptRecommendationModel: RECOMMENDATION_PIN,
    });
    await writeAuxiliaryModelSettingsPatch({ sessionTitleModel: null });

    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))).toEqual({
      promptRecommendationModel: RECOMMENDATION_PIN,
    });

    await writeAuxiliaryModelSettingsPatch({ promptRecommendationModel: null });
    expect(fs.existsSync(settingsFile)).toBe(false);
  });

  it('normalizes malformed or non-canonical disk values to automatic', () => {
    expect(
      __testing.normalize({
        sessionTitleModel: 'cat:openrouter:pi:model',
        promptRecommendationModel: '  cat:anthropic:claude-code:model  ',
      }),
    ).toEqual({
      sessionTitleModel: null,
      promptRecommendationModel: 'cat:anthropic:claude-code:model',
    });
  });
});
