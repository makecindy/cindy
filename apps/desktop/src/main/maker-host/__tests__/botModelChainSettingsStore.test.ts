import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import * as locks from '../../device-link/crossProcessLock';
import os from 'node:os';
import path from 'node:path';

import type { ProviderView } from '@cindy/model-providers';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import {
  readBotModelChainSettingsState,
  resetBotModelChainSettings,
  readEffectiveBotModelChain,
  writeBotModelChainSettings,
} from '../bot-model-chain-settings-store';

vi.mock('../createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders: async () => [] }),
}));

vi.mock('../index.js', () => ({ getMakerIfReady: () => ({ listAvailableAgents: () => ['claude-code', 'codex', 'pi'] }) }));

const owner = vi.hoisted(() => ({ root: '', key: 'owner-a:1' }));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ dataOwnerId: owner.key }),
  activeOwnerScopeKey: () => owner.key,
  ownerScopedUserDataPath: () => owner.root,
}));

import { setModelVisibilityMirror } from '../model-visibility-mirror';
import { setNewMakerDraftCache } from '../newMakerDefaultsCache';
beforeEach(() => {
  setModelVisibilityMirror({}, { fallback: true });
  setNewMakerDraftCache({ selectedRoute: { harness: 'codex', providerId: 'openai', model: 'gpt-5.6-sol', effort: 'medium', fastMode: false }, lastByVendor: {}, effortByModel: {}, fastModeByModel: {} }, owner.key);
});

const roots: string[] = [];

async function testRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-bot-model-chain-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('bot model chain settings store', () => {
  it('keeps unconfigured defaults empty without writing a Gateway placeholder', async () => {
    const rootPath = await testRoot();
    expect(await readBotModelChainSettingsState({ rootPath, providers: [] })).toMatchObject({
      isCustomized: false, value: { modelChain: [] },
    });
  });

  it('resolves uncustomized defaults from current connections without writing an override', async () => {
    const rootPath = await testRoot();
    const providers = [{
      id: 'openai', source: 'builtin', connected: true, agents: ['codex'],
      access: { kind: 'subscription', product: 'ChatGPT' },
      routing: { codex: { upstream: 'https://example.invalid', authStrategy: 'oauth-passthrough' } },
      models: { codex: [{ id: 'gpt-5.6-sol', mode: 'chat', status: 'active', efforts: ['medium'], defaultEffort: 'medium' }] },
    }] as ProviderView[];
    // Connected catalog alone cannot select a model while the default mirror is absent.
    setNewMakerDraftCache({ lastByVendor: {}, effortByModel: {}, fastModeByModel: {} }, owner.key);
    expect((await readBotModelChainSettingsState({ rootPath, providers })).value.modelChain).toEqual([]);
    setNewMakerDraftCache({ selectedRoute: { harness: 'codex', providerId: 'openai', model: 'gpt-5.6-sol', effort: 'medium', fastMode: false }, lastByVendor: {}, effortByModel: {}, fastModeByModel: {} }, owner.key);
    const state = await readBotModelChainSettingsState({ rootPath, providers });
    expect(state.isCustomized).toBe(false);
    expect(state.value.modelChain[0]).toMatchObject({
      harness: 'codex', providerId: 'openai', model: 'gpt-5.6-sol', effort: 'medium',
    });
    expect(await fs.readdir(rootPath)).toEqual([]);
    expect(await readEffectiveBotModelChain({ modelChainOverride: null }, { rootPath, providers }))
      .toEqual(state.value.modelChain);
    await writeBotModelChainSettings(state.value.modelChain, { rootPath });
    expect((await readBotModelChainSettingsState({ rootPath, providers: [] })).value)
      .toEqual(state.value);
  });

  it('uses only enabled Luna with Cindy tuning for new and existing default-following partners', async () => {
    const rootPath = await testRoot();
    const providers = [{
      id: 'openai', source: 'builtin', connected: true, agents: ['codex'],
      access: { kind: 'subscription', product: 'ChatGPT' },
      routing: { codex: { upstream: 'https://example.invalid', authStrategy: 'oauth-passthrough' } },
      models: { codex: ['gpt-5.6-sol', 'gpt-5.6-luna'].map(id => ({
        id, mode: 'chat', status: 'active', efforts: ['low', 'medium'], defaultEffort: 'low',
      })) },
    }] as ProviderView[];
    const selectedRoute = { harness: 'codex' as const, providerId: 'openai', model: 'gpt-5.6-luna', effort: 'medium', fastMode: false };
    setModelVisibilityMirror({ 'codex:openai:gpt-5.6-luna': true }, { fallback: false, followCatalogKeys: [] });
    setNewMakerDraftCache({ selectedRoute, lastByVendor: {}, effortByModel: {}, fastModeByModel: {} }, owner.key);
    expect((await readBotModelChainSettingsState({ rootPath, providers })).value.modelChain).toEqual([selectedRoute]);
    expect(await readEffectiveBotModelChain({ modelChainOverride: null, model: 'gpt-5.6-sol', effort: 'low' }, { rootPath, providers })).toEqual([selectedRoute]);
    setNewMakerDraftCache({ selectedRoute: { ...selectedRoute, providerId: null }, lastByVendor: {}, effortByModel: {}, fastModeByModel: {} }, owner.key);
    expect(await readEffectiveBotModelChain({ modelChainOverride: null }, { rootPath, providers })).toEqual([selectedRoute]);
    expect(await fs.readdir(rootPath)).toEqual([]);
    setModelVisibilityMirror({}, { fallback: true });
    expect((await readBotModelChainSettingsState({ rootPath, providers })).value.modelChain).toEqual([selectedRoute]);
    setModelVisibilityMirror({ 'codex:openai:gpt-5.6-luna': false }, { fallback: true });
    expect(await readEffectiveBotModelChain({ modelChainOverride: null }, { rootPath, providers })).toEqual([]);
  });

  it('persists an ordered 1-5 route chain as the Main-owned source of truth', async () => {
    const rootPath = await testRoot();
    const modelChain = [
      {
        harness: 'codex' as const,
        model: 'gpt-5.6-sol',
        providerId: 'openai',
        effort: 'high',
        fastMode: false,
      },
      {
        harness: 'pi' as const,
        model: 'z-ai/glm-5.3-flash',
        providerId: 'xd',
        effort: '',
        fastMode: true,
      },
    ];

    await writeBotModelChainSettings(modelChain, { rootPath });

    expect(await readBotModelChainSettingsState({ rootPath, providers: [] })).toMatchObject({
      isCustomized: true,
      value: { modelChain },
    });

    expect(await readEffectiveBotModelChain({
      model: 'legacy-cache',
      harness: 'claude',
      modelOverride: null,
    }, { rootPath })).toEqual(modelChain);
    expect(await readEffectiveBotModelChain({
      modelChainOverride: null,
      modelChain: [{ harness: 'claude', model: 'stale-cache' }],
    }, { rootPath })).toEqual(modelChain);
  });

  it('keeps an explicit per-Bot chain authoritative even if its cache field drifted', async () => {
    const rootPath = await testRoot();
    const explicit = [{
      harness: 'claude' as const,
      model: 'claude-opus-5',
      providerId: 'anthropic',
      effort: 'high',
      fastMode: false,
    }];

    expect(await readEffectiveBotModelChain({
      modelChain: [{ harness: 'pi', model: 'stale-cache' }],
      modelChainOverride: explicit,
    }, { rootPath })).toEqual(explicit);
  });
  it('clears even an explicitly saved default and leaves per-Bot overrides and other owners intact', async () => {
    const rootPath = await testRoot();
    const otherRoot = await testRoot();
    const providers = [{
      id: 'openai', source: 'builtin', connected: true, agents: ['codex'],
      access: { kind: 'subscription', product: 'ChatGPT' },
      routing: { codex: { upstream: 'https://example.invalid', authStrategy: 'oauth-passthrough' } },
      models: { codex: [{ id: 'gpt-5.6-sol', mode: 'chat', status: 'active', efforts: ['medium'], defaultEffort: 'medium' }] },
    }] as ProviderView[];
    const defaults = (await readBotModelChainSettingsState({ rootPath, providers })).value.modelChain;
    const custom = [{ ...defaults[0]!, model: 'custom-model' }];
    await writeBotModelChainSettings(defaults, { rootPath });
    await writeBotModelChainSettings(custom, { rootPath: otherRoot });
    expect((await readBotModelChainSettingsState({ rootPath })).isCustomized).toBe(true);

    expect(await resetBotModelChainSettings({ rootPath, providers })).toMatchObject({
      value: { modelChain: defaults }, isCustomized: false, customizedKeys: [],
    });
    await expect(fs.stat(path.join(rootPath, 'bot-model-chain-settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readEffectiveBotModelChain({ modelChainOverride: null }, { rootPath, providers })).toEqual(defaults);
    expect(await readEffectiveBotModelChain({ modelChainOverride: custom }, { rootPath })).toEqual(custom);
    expect(await readBotModelChainSettingsState({ rootPath: otherRoot })).toMatchObject({
      isCustomized: true, value: { modelChain: custom },
    });
    // Repeating restore is safe and never writes a default snapshot.
    expect((await resetBotModelChainSettings({ rootPath, providers })).isCustomized).toBe(false);
  });

  it('preserves disk and customized state if removing the override fails', async () => {
    const rootPath = await testRoot();
    const custom = [{ harness: 'pi', model: 'custom-model' }];
    await writeBotModelChainSettings(custom, { rootPath });
    const file = path.join(rootPath, 'bot-model-chain-settings.json');
    const before = await fs.readFile(file, 'utf8');
    const unlink = syncFs.unlinkSync;
    vi.spyOn(syncFs, 'unlinkSync').mockImplementation((target) => {
      if (target === file) throw new Error('permission denied');
      unlink(target);
    });
    await expect(resetBotModelChainSettings({ rootPath })).rejects.toThrow('permission denied');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect((await readBotModelChainSettingsState({ rootPath })).isCustomized).toBe(true);
  });

  it('does not clear either account when the owner changes while waiting for the lock', async () => {
    owner.root = await testRoot();
    owner.key = 'owner-a:1';
    await writeBotModelChainSettings([{ harness: 'pi', model: 'owner-a-model' }]);
    const file = path.join(owner.root, 'bot-model-chain-settings.json');
    const before = await fs.readFile(file, 'utf8');
    const oldRoot = owner.root;
    const otherRoot = await testRoot();
    await writeBotModelChainSettings([{ harness: 'pi', model: 'owner-b-model' }], { rootPath: otherRoot });
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (_path, _options, operation) => {
      owner.root = otherRoot;
      owner.key = 'owner-b:2';
      return operation({ held: true });
    });
    await expect(resetBotModelChainSettings()).rejects.toThrow('scope changed');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect((await readBotModelChainSettingsState({ rootPath: oldRoot })).isCustomized).toBe(true);
    expect((await readBotModelChainSettingsState({ rootPath: otherRoot })).value.modelChain[0]?.model).toBe('owner-b-model');
  });

  it('preserves the override if the shared lock cannot be acquired', async () => {
    const rootPath = await testRoot();
    await writeBotModelChainSettings([{ harness: 'pi', model: 'custom-model' }], { rootPath });
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (_path, _options, operation) => operation({ held: false, reason: 'busy' }));
    await expect(resetBotModelChainSettings({ rootPath })).rejects.toThrow('busy');
    expect((await readBotModelChainSettingsState({ rootPath })).isCustomized).toBe(true);
  });

});
