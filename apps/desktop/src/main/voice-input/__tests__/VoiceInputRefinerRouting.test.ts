import { beforeEach, describe, expect, it } from 'vitest';

import {
  collectRefinerPrewarmTransports,
  orderVoiceInputRefinerChainForRuntime,
} from '../VoiceInputRefinerRouting.js';
import {
  markVoiceInputProviderFailure,
  resetVoiceInputProviderHealthForTests,
} from '../VoiceInputProviderHealth.js';
import type {
  VoiceInputRefinerProfile,
  VoiceInputRefinerProviderKind,
} from '../../../shared/voiceInputRefinerProfiles.js';

const defaultSelection = {
  refinerProvider: 'codex-gpt-5.4-mini' as VoiceInputRefinerProviderKind,
  refinerProviderChainSource: 'default' as const,
  refinerProviderChain: [
    'codex-gpt-5.4-mini',
    'litellm-gpt-5.4-mini',
    'litellm-kimi-k2.6',
    'litellm-deepseek-v4-flash',
  ] as VoiceInputRefinerProviderKind[],
};

function readiness(
  ready: readonly VoiceInputRefinerProviderKind[],
): Array<{ provider: VoiceInputRefinerProviderKind; ok: boolean }> {
  return defaultSelection.refinerProviderChain.map((provider) => ({
    provider,
    ok: ready.includes(provider),
  }));
}

describe('VoiceInputRefinerRouting', () => {
  beforeEach(() => {
    resetVoiceInputProviderHealthForTests();
  });

  it('keeps configured order when Codex is ready', () => {
    expect(orderVoiceInputRefinerChainForRuntime(defaultSelection, readiness([
      'codex-gpt-5.4-mini',
      'litellm-gpt-5.4-mini',
      'litellm-kimi-k2.6',
      'litellm-deepseek-v4-flash',
    ]))).toEqual([
      'codex-gpt-5.4-mini',
      'litellm-gpt-5.4-mini',
      'litellm-kimi-k2.6',
      'litellm-deepseek-v4-flash',
    ]);
  });

  it('keeps configured order when Codex is unavailable', () => {
    expect(orderVoiceInputRefinerChainForRuntime(defaultSelection, readiness([
      'litellm-gpt-5.4-mini',
      'litellm-kimi-k2.6',
      'litellm-deepseek-v4-flash',
    ]))).toEqual([
      'codex-gpt-5.4-mini',
      'litellm-gpt-5.4-mini',
      'litellm-kimi-k2.6',
      'litellm-deepseek-v4-flash',
    ]);
  });

  it('keeps explicit refiner chains in configured order', () => {
    expect(orderVoiceInputRefinerChainForRuntime({
      refinerProvider: 'codex-gpt-5.4-mini',
      refinerProviderChainSource: 'configured',
      refinerProviderChain: [
        'codex-gpt-5.4-mini',
        'litellm-gpt-5.4-mini',
        'litellm-deepseek-v4-flash',
      ],
    }, readiness([
      'codex-gpt-5.4-mini',
      'litellm-gpt-5.4-mini',
      'litellm-deepseek-v4-flash',
    ]))).toEqual([
      'codex-gpt-5.4-mini',
      'litellm-gpt-5.4-mini',
      'litellm-deepseek-v4-flash',
    ]);
  });

  it('keeps an explicit chain even when it matches the built-in default values', () => {
    expect(orderVoiceInputRefinerChainForRuntime({
      ...defaultSelection,
      refinerProviderChainSource: 'configured',
    }, readiness([
      'codex-gpt-5.4-mini',
      'litellm-gpt-5.4-mini',
      'litellm-kimi-k2.6',
      'litellm-deepseek-v4-flash',
    ]))).toEqual([
      'codex-gpt-5.4-mini',
      'litellm-gpt-5.4-mini',
      'litellm-kimi-k2.6',
      'litellm-deepseek-v4-flash',
    ]);
  });

  it('applies health cooldown without Codex readiness reorder', () => {
    markVoiceInputProviderFailure('refiner', 'codex-gpt-5.4-mini', 'timeout');

    expect(orderVoiceInputRefinerChainForRuntime(defaultSelection, readiness([
      'codex-gpt-5.4-mini',
      'litellm-gpt-5.4-mini',
      'litellm-kimi-k2.6',
      'litellm-deepseek-v4-flash',
    ]))).toEqual([
      'litellm-gpt-5.4-mini',
      'litellm-kimi-k2.6',
      'litellm-deepseek-v4-flash',
      'codex-gpt-5.4-mini',
    ]);
  });

  describe('collectRefinerPrewarmTransports', () => {
    function profile(id: string, transport: VoiceInputRefinerProfile['transport']): VoiceInputRefinerProfile {
      return {
        id,
        model: 'test-model',
        transport,
        auth: transport === 'codex-responses' ? 'codex' : 'api-key',
        settingsTab: 'providers',
        missingCredentialMessage: 'test',
      };
    }

    it('dedupes transports preserving chain order so fallback transports get warmed too', () => {
      expect(collectRefinerPrewarmTransports([
        profile('codex-gpt-5.4-mini', 'codex-responses'),
        profile('litellm-kimi-k2.6', 'litellm-chat-completions'),
        profile('litellm-gpt-5.4-mini', 'litellm-chat-completions'),
        profile('litellm-deepseek-v4-flash', 'litellm-chat-completions'),
      ])).toEqual(['codex-responses', 'litellm-chat-completions']);
    });

    it('returns a single transport for homogeneous chains and empty for empty chains', () => {
      expect(collectRefinerPrewarmTransports([
        profile('litellm-kimi-k2.6', 'litellm-chat-completions'),
      ])).toEqual(['litellm-chat-completions']);
      expect(collectRefinerPrewarmTransports([])).toEqual([]);
    });
  });
});
