import { describe, expect, it } from 'vitest';

import type { ProviderPreset } from '@cindy/model-providers';

import {
  configuredPresetAgents,
  isConfiguredPresetRuntime,
} from '../../../shared/piRuntimeInitialization.js';

describe('Pi preset runtime initialization', () => {
  it('skips a legacy Pi runtime whose protocol is not declared', () => {
    const preset: ProviderPreset = {
      id: 'legacy-remote',
      name: 'Legacy Remote',
      runtimes: {
        'claude-code': {
          baseUrl: 'https://example.com/anthropic',
          models: [{ id: 'model-a', name: 'Model A' }],
        },
        pi: {
          baseUrl: 'https://example.com/pi',
          models: [{ id: 'model-a', name: 'Model A' }],
        },
      },
    };

    expect(configuredPresetAgents(preset)).toEqual(['claude-code']);
    expect(isConfiguredPresetRuntime('pi', preset.runtimes.pi)).toBe(false);
  });

  it('keeps an explicitly configured Pi runtime', () => {
    const preset: ProviderPreset = {
      id: 'current-remote',
      name: 'Current Remote',
      runtimes: {
        pi: {
          baseUrl: 'https://example.com/pi',
          wireProtocol: 'anthropic-messages',
          models: [{ id: 'model-a', name: 'Model A' }],
        },
      },
    };

    expect(configuredPresetAgents(preset)).toEqual(['pi']);
    expect(isConfiguredPresetRuntime('pi', preset.runtimes.pi)).toBe(true);
  });
});
