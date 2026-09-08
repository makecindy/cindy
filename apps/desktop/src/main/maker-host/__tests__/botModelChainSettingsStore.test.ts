import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import * as locks from '../../device-link/crossProcessLock';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readBotModelChainSettingsState,
  resetBotModelChainSettings,
  readEffectiveBotModelChain,
  writeBotModelChainSettings,
} from '../bot-model-chain-settings-store';

const owner = vi.hoisted(() => ({ root: '', key: 'owner-a:1' }));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ dataOwnerId: owner.key }),
  activeOwnerScopeKey: () => owner.key,
  ownerScopedUserDataPath: () => owner.root,
}));

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
  it('defaults to Pi + GLM-5.3-Flash without creating an override', async () => {
    const rootPath = await testRoot();

    expect(readBotModelChainSettingsState({ rootPath })).toMatchObject({
      isCustomized: false,
      value: {
        modelChain: [{
          harness: 'pi',
          model: 'z-ai/glm-5.3-flash',
          providerId: 'xd',
          effort: 'high',
          fastMode: false,
        }],
      },
    });
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

    expect(readBotModelChainSettingsState({ rootPath })).toMatchObject({
      isCustomized: true,
      value: { modelChain },
    });

    expect(readEffectiveBotModelChain({
      model: 'legacy-cache',
      harness: 'claude',
      modelOverride: null,
    }, { rootPath })).toEqual(modelChain);
    expect(readEffectiveBotModelChain({
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

    expect(readEffectiveBotModelChain({
      modelChain: [{ harness: 'pi', model: 'stale-cache' }],
      modelChainOverride: explicit,
    }, { rootPath })).toEqual(explicit);
  });
  it('clears even an explicitly saved default and leaves per-Bot overrides and other owners intact', async () => {
    const rootPath = await testRoot();
    const otherRoot = await testRoot();
    const defaults = readBotModelChainSettingsState({ rootPath }).value.modelChain;
    const custom = [{ ...defaults[0]!, model: 'custom-model' }];
    await writeBotModelChainSettings(defaults, { rootPath });
    await writeBotModelChainSettings(custom, { rootPath: otherRoot });
    expect(readBotModelChainSettingsState({ rootPath }).isCustomized).toBe(true);

    expect(await resetBotModelChainSettings({ rootPath })).toMatchObject({
      value: { modelChain: defaults }, isCustomized: false, customizedKeys: [],
    });
    await expect(fs.stat(path.join(rootPath, 'bot-model-chain-settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(readEffectiveBotModelChain({ modelChainOverride: null }, { rootPath })).toEqual(defaults);
    expect(readEffectiveBotModelChain({ modelChainOverride: custom }, { rootPath })).toEqual(custom);
    expect(readBotModelChainSettingsState({ rootPath: otherRoot })).toMatchObject({
      isCustomized: true, value: { modelChain: custom },
    });
    // Repeating restore is safe and never writes a default snapshot.
    expect((await resetBotModelChainSettings({ rootPath })).isCustomized).toBe(false);
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
    expect(readBotModelChainSettingsState({ rootPath }).isCustomized).toBe(true);
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
    expect(readBotModelChainSettingsState({ rootPath: oldRoot }).isCustomized).toBe(true);
    expect(readBotModelChainSettingsState({ rootPath: otherRoot }).value.modelChain[0]?.model).toBe('owner-b-model');
  });

  it('preserves the override if the shared lock cannot be acquired', async () => {
    const rootPath = await testRoot();
    await writeBotModelChainSettings([{ harness: 'pi', model: 'custom-model' }], { rootPath });
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (_path, _options, operation) => operation({ held: false, reason: 'busy' }));
    await expect(resetBotModelChainSettings({ rootPath })).rejects.toThrow('busy');
    expect(readBotModelChainSettingsState({ rootPath }).isCustomized).toBe(true);
  });

});
