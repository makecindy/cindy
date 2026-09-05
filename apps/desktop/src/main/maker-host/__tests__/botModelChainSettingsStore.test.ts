import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  readBotModelChainSettingsState,
  readEffectiveBotModelChain,
  writeBotModelChainSettings,
} from '../bot-model-chain-settings-store';

const roots: string[] = [];

async function testRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-bot-model-chain-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
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
});
