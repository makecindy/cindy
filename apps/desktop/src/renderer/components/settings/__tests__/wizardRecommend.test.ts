import { describe, expect, it } from 'vitest';

import { pickWizardRecommend } from '../wizardRecommend.js';

describe('pickWizardRecommend', () => {
  it('prefers Ollama when local models are already installed', () => {
    expect(
      pickWizardRecommend({
        ollamaAlreadyAdded: false,
        ollamaAppInstalled: true,
        installedLocalModelCount: 2,
        memoryGb: 8,
        fallbackOauthProviderId: 'anthropic',
      }),
    ).toEqual([{ kind: 'ollama', reason: 'has-local-models' }]);
  });

  it('recommends Ollama when this machine has enough memory', () => {
    expect(
      pickWizardRecommend({
        ollamaAlreadyAdded: false,
        ollamaAppInstalled: false,
        installedLocalModelCount: 0,
        memoryGb: 32,
        fallbackOauthProviderId: 'anthropic',
      }),
    ).toEqual([{ kind: 'ollama', reason: 'machine-capable' }]);
  });

  it('does not push Ollama on a small machine without local models', () => {
    expect(
      pickWizardRecommend({
        ollamaAlreadyAdded: false,
        ollamaAppInstalled: false,
        installedLocalModelCount: 0,
        memoryGb: 8,
        fallbackOauthProviderId: 'anthropic',
      }),
    ).toEqual([{ kind: 'oauth', providerId: 'anthropic', reason: 'subscription' }]);
  });

  it('falls back to Ollama when memory is unknown but the app is installed', () => {
    expect(
      pickWizardRecommend({
        ollamaAlreadyAdded: false,
        ollamaAppInstalled: true,
        installedLocalModelCount: 0,
        memoryGb: 0,
        fallbackOauthProviderId: 'anthropic',
      }),
    ).toEqual([{ kind: 'ollama', reason: 'machine-capable' }]);
  });

  it('skips Ollama once it is already added', () => {
    expect(
      pickWizardRecommend({
        ollamaAlreadyAdded: true,
        ollamaAppInstalled: true,
        installedLocalModelCount: 3,
        memoryGb: 64,
        fallbackOauthProviderId: 'anthropic',
      }),
    ).toEqual([{ kind: 'oauth', providerId: 'anthropic', reason: 'subscription' }]);
  });

  it('returns an empty list when nothing is left to recommend', () => {
    expect(
      pickWizardRecommend({
        ollamaAlreadyAdded: true,
        ollamaAppInstalled: false,
        installedLocalModelCount: 0,
        memoryGb: 8,
      }),
    ).toEqual([]);
  });

  it('stacks installed CLI authorization after Ollama', () => {
    expect(
      pickWizardRecommend({
        ollamaAlreadyAdded: false,
        ollamaAppInstalled: false,
        installedLocalModelCount: 0,
        memoryGb: 32,
        cliCandidates: [
          { providerId: 'anthropic', loggedIn: true, cli: 'claude-cli' },
          { providerId: 'openai', loggedIn: false, cli: 'codex-cli' },
        ],
        fallbackOauthProviderId: 'xai',
      }),
    ).toEqual([
      { kind: 'ollama', reason: 'machine-capable' },
      { kind: 'oauth', providerId: 'anthropic', reason: 'cli-logged-in', cli: 'claude-cli' },
      { kind: 'oauth', providerId: 'openai', reason: 'cli-installed', cli: 'codex-cli' },
    ]);
  });

  it('does not recommend a CLI whose provider is already connected', () => {
    expect(
      pickWizardRecommend({
        ollamaAlreadyAdded: true,
        ollamaAppInstalled: true,
        installedLocalModelCount: 1,
        memoryGb: 64,
        connectedProviderIds: ['anthropic'],
        cliCandidates: [{ providerId: 'anthropic', loggedIn: true, cli: 'claude-cli' }],
        fallbackOauthProviderId: 'openai',
      }),
    ).toEqual([{ kind: 'oauth', providerId: 'openai', reason: 'subscription' }]);
  });

  it('does not fall back to a subscription when Ollama or a CLI already filled the list', () => {
    expect(
      pickWizardRecommend({
        ollamaAlreadyAdded: false,
        ollamaAppInstalled: false,
        installedLocalModelCount: 0,
        memoryGb: 8,
        cliCandidates: [{ providerId: 'anthropic', loggedIn: false, cli: 'claude-cli' }],
        fallbackOauthProviderId: 'xai',
      }),
    ).toEqual([
      { kind: 'oauth', providerId: 'anthropic', reason: 'cli-installed', cli: 'claude-cli' },
    ]);
  });

  it('caps the short list at three items', () => {
    expect(
      pickWizardRecommend({
        ollamaAlreadyAdded: false,
        ollamaAppInstalled: false,
        installedLocalModelCount: 0,
        memoryGb: 64,
        cliCandidates: [
          { providerId: 'anthropic', loggedIn: true, cli: 'claude-cli' },
          { providerId: 'openai', loggedIn: false, cli: 'codex-cli' },
          { providerId: 'xai', loggedIn: false, cli: 'codex-cli' },
        ],
      }),
    ).toHaveLength(3);
  });
});
