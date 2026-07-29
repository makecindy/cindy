import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scopeMocks = vi.hoisted(() => ({
  owner: 'cloud-a',
  join: null as unknown as (...parts: string[]) => string,
  claimLegacy: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
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

vi.mock('../ownerScopedStorage.js', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) =>
    scopeMocks.join('/tmp/xdt-maker-test', 'owners', scopeMocks.owner, ...parts),
  claimLegacyImPath: scopeMocks.claimLegacy,
}));

import { IM_DEFAULT_SETTINGS } from '../../../shared/imDefaultSettings.js';
import {
  __testing,
  readImDefaultSettings,
  readImDefaultSettingsState,
  resetImDefaultSettings,
  resetImDefaultSettingsChannel,
  writeImDefaultSettingsPatch,
} from '../defaultSettingsStore';

const settingsDir = '/tmp/xdt-maker-test';
const settingsFile = () =>
  path.join(settingsDir, 'owners', scopeMocks.owner, 'im-default-settings.json');

describe('im default settings store', () => {
  beforeEach(() => {
    scopeMocks.join = path.join;
    scopeMocks.owner = 'cloud-a';
    scopeMocks.claimLegacy.mockReset();
    fs.mkdirSync(settingsDir, { recursive: true });
    resetImDefaultSettings();
  });

  afterEach(() => {
    resetImDefaultSettings();
    fs.rmSync(settingsDir, { recursive: true, force: true });
  });

  it('migrates legacy single-slot overrides after override defaults are merged', () => {
    const normalized = __testing.normalize({
      ...IM_DEFAULT_SETTINGS,
      agentKind: 'codex',
      providerId: 'openai',
      model: 'gpt-5.5',
      effort: 'medium',
    });

    expect(normalized.agents.codex).toEqual({
      providerId: 'openai',
      model: 'gpt-5.5',
      effort: 'medium',
    });
    expect(normalized.agents['claude-code']).toEqual(IM_DEFAULT_SETTINGS.agents['claude-code']);
  });

  it('persists only the changed agent override so untouched agents keep inheriting future defaults', () => {
    writeImDefaultSettingsPatch({
      agents: {
        codex: {
          providerId: 'openai',
          model: 'gpt-5.5',
          effort: 'high',
        },
      },
    });

    const persisted = JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'));
    expect(persisted.schemaVersion).toBe(3);
    expect(persisted.global).toEqual({
      agents: {
        codex: {
          providerId: 'openai',
          model: 'gpt-5.5',
          effort: 'high',
        },
      },
    });
    // Legacy flat fields preserved for old app versions
    expect(persisted.agentKind).toBe(IM_DEFAULT_SETTINGS.agentKind);
    expect(persisted.agents).toBeDefined();
  });

  it('preserves existing agent overrides when another agent is updated', () => {
    writeImDefaultSettingsPatch({
      agents: {
        'claude-code': {
          providerId: 'anthropic',
          model: 'claude-sonnet-4-8',
          effort: 'xhigh',
        },
      },
    });

    writeImDefaultSettingsPatch({
      agents: {
        codex: {
          providerId: 'openai',
          model: 'gpt-5.5',
          effort: 'high',
        },
      },
    });

    const persisted = JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'));
    expect(persisted.schemaVersion).toBe(3);
    expect(persisted.global).toEqual({
      agents: {
        'claude-code': {
          providerId: 'anthropic',
          model: 'claude-sonnet-4-8',
          effort: 'xhigh',
        },
        codex: {
          providerId: 'openai',
          model: 'gpt-5.5',
          effort: 'high',
        },
      },
    });
    // Legacy flat fields mirror global route for backward compatibility
    expect(persisted.agentKind).toBe(IM_DEFAULT_SETTINGS.agentKind);
    expect(persisted.agents).toEqual({
      'claude-code': {
        providerId: 'anthropic',
        model: 'claude-sonnet-4-8',
        effort: 'xhigh',
      },
      codex: {
        providerId: 'openai',
        model: 'gpt-5.5',
        effort: 'high',
      },
    });
  });

  it('keeps local and cloud default settings in separate owner files', () => {
    writeImDefaultSettingsPatch({ agentKind: 'codex' });

    scopeMocks.owner = 'local-v1';
    expect(readImDefaultSettings()).toEqual(IM_DEFAULT_SETTINGS);
    writeImDefaultSettingsPatch({
      agents: {
        'claude-code': {
          providerId: 'anthropic',
          model: 'claude-sonnet-4-8',
          effort: 'high',
        },
      },
    });

    scopeMocks.owner = 'cloud-a';
    expect(readImDefaultSettings().agentKind).toBe('codex');
    const persisted = JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'));
    expect(persisted.schemaVersion).toBe(3);
    expect(persisted.global).toEqual({ agentKind: 'codex' });
    expect(persisted.agentKind).toBe('codex');
  });

  it('migrates a legacy global override into independent channel routes', () => {
    const migrated = __testing.normalizeDocument({
      ...IM_DEFAULT_SETTINGS,
      agentKind: 'codex',
      agents: {
        ...IM_DEFAULT_SETTINGS.agents,
        codex: {
          providerId: 'openai',
          model: 'gpt-5.5',
          effort: 'high',
        },
      },
    });

    expect(migrated.global.agentKind).toBe('codex');
    expect(migrated.channels.feishu).toEqual(migrated.global);
    expect(migrated.channels.discord).toEqual(migrated.global);
    expect(migrated.channels.slack).toEqual(migrated.global);
    expect(migrated.channels.wechat).toEqual(migrated.global);
  });

  it('migrates v2 documents to auto permission and seeds an independent WeChat route', () => {
    const withoutPermission = {
      agentKind: IM_DEFAULT_SETTINGS.agentKind,
      agents: IM_DEFAULT_SETTINGS.agents,
    };
    const migrated = __testing.normalizeDocument({
      schemaVersion: 2,
      global: withoutPermission,
      channels: {
        feishu: withoutPermission,
        discord: withoutPermission,
        slack: withoutPermission,
      },
    });

    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.global.permissionMode).toBe('auto');
    expect(migrated.channels.wechat.permissionMode).toBe('auto');
    expect(migrated.channels.wechat.agentKind).toBe(IM_DEFAULT_SETTINGS.agentKind);
  });

  it.each(['acceptEdits', 'bypassPermissions'] as const)(
    'rejects %s for personal WeChat without changing saved defaults',
    (permissionMode) => {
      expect(() =>
        writeImDefaultSettingsPatch({ permissionMode }, 'wechat'),
      ).toThrow('WECHAT_PERMISSION_MODE_UNSUPPORTED');
      expect(readImDefaultSettings('wechat').permissionMode).toBe('auto');
    },
  );

  it('detects legacy files even when v2 defaults are merged in by createOverrideSettingsFile', () => {
    // createOverrideSettingsFile calls normalize({ ...defaults(), ...overrides }).
    // For a v1 file the overrides are flat route fields; defaults inject
    // schemaVersion/global/channels. Legacy detection must still trigger.
    const v2Defaults = {
      schemaVersion: 2,
      global: IM_DEFAULT_SETTINGS,
      channels: {
        feishu: IM_DEFAULT_SETTINGS,
        discord: IM_DEFAULT_SETTINGS,
        slack: IM_DEFAULT_SETTINGS,
      },
    };

    // Case 1: v1 file with scalar fields (providerId/model/effort)
    const v1WithScalars = { agentKind: 'codex', providerId: 'openai', model: 'gpt-5.5', effort: 'high' };
    const merged1 = { ...v2Defaults, ...v1WithScalars };
    const migrated1 = __testing.normalizeDocument(merged1);
    expect(migrated1.global.agentKind).toBe('codex');
    expect(migrated1.global.agents.codex.providerId).toBe('openai');
    expect(migrated1.channels.feishu).toEqual(migrated1.global);

    // Case 2: v1 file with only agentKind (no scalar fields)
    const v1AgentOnly = { agentKind: 'codex' };
    const merged2 = { ...v2Defaults, ...v1AgentOnly };
    const migrated2 = __testing.normalizeDocument(merged2);
    expect(migrated2.global.agentKind).toBe('codex');
    expect(migrated2.channels.feishu.agentKind).toBe('codex');
    expect(migrated2.channels.discord.agentKind).toBe('codex');

    // Case 3: v1 file with only agents (user changed model/provider, kept default agent)
    const v1AgentsOnly = {
      agents: {
        'claude-code': { providerId: 'anthropic', model: 'claude-sonnet-4-8', effort: 'high' },
      },
    };
    const merged3 = { ...v2Defaults, ...v1AgentsOnly };
    const migrated3 = __testing.normalizeDocument(merged3);
    expect(migrated3.global.agents['claude-code'].model).toBe('claude-sonnet-4-8');
    expect(migrated3.global.agents['claude-code'].providerId).toBe('anthropic');
    expect(migrated3.channels.feishu.agents['claude-code'].model).toBe('claude-sonnet-4-8');
    expect(migrated3.channels.slack.agents['claude-code'].model).toBe('claude-sonnet-4-8');
  });

  it('does not misidentify a v2 file with partial global as legacy after channel edit', () => {
    // Simulate: user customizes global, then edits one channel. The on-disk v2
    // file has a partial `global` override and full root `agents` mirror.
    // After defaults merge this must NOT trigger legacy migration.
    const v2Defaults = {
      schemaVersion: 2,
      global: IM_DEFAULT_SETTINGS,
      channels: {
        feishu: IM_DEFAULT_SETTINGS,
        discord: IM_DEFAULT_SETTINGS,
        slack: IM_DEFAULT_SETTINGS,
      },
    };
    const v2FileOverrides = {
      schemaVersion: 2,
      global: { agentKind: 'codex' },
      channels: { feishu: { agentKind: 'codex', agents: { codex: { providerId: 'openai', model: 'gpt-5.5', effort: 'high' } } } },
      agentKind: 'codex',
      agents: { 'claude-code': IM_DEFAULT_SETTINGS.agents['claude-code'], codex: { providerId: null, model: IM_DEFAULT_SETTINGS.agents.codex.model, effort: IM_DEFAULT_SETTINGS.agents.codex.effort } },
    };
    const merged = { ...v2Defaults, ...v2FileOverrides };
    const result = __testing.normalizeDocument(merged);

    // Must preserve per-channel data, NOT flatten everything from global
    expect(result.channels.feishu.agentKind).toBe('codex');
    expect(result.channels.feishu.agents.codex.providerId).toBe('openai');
    // Discord should remain at defaults (not overwritten by global's codex)
    expect(result.channels.discord.agentKind).toBe(IM_DEFAULT_SETTINGS.agentKind);
  });

  it('writes and resets one channel without changing another channel', () => {
    writeImDefaultSettingsPatch({ agentKind: 'codex' }, 'feishu');
    writeImDefaultSettingsPatch(
      {
        agents: {
          'claude-code': {
            providerId: 'anthropic',
            model: 'claude-sonnet-4-8',
            effort: 'high',
          },
        },
      },
      'discord',
    );

    expect(readImDefaultSettings('feishu').agentKind).toBe('codex');
    expect(readImDefaultSettings('discord').agentKind).toBe('claude-code');
    expect(readImDefaultSettings('discord').agents['claude-code'].model).toBe('claude-sonnet-4-8');

    resetImDefaultSettingsChannel('feishu');

    expect(readImDefaultSettingsState('feishu').isCustomized).toBe(false);
    expect(readImDefaultSettings('feishu')).toEqual(IM_DEFAULT_SETTINGS);
    expect(readImDefaultSettings('discord').agents['claude-code'].model).toBe('claude-sonnet-4-8');
  });
});
