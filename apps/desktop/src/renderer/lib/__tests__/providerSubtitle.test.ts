import { describe, expect, it } from 'vitest';

import {
  customProviderSubtitleForDisplay,
  providerAgentSupportLabel,
  providerSubtitleForDisplay,
} from '../providerSubtitle';

import type { ProviderView } from '@cindy/model-providers';

describe('provider subtitle display', () => {
  it('renders supported agents from provider.agents', () => {
    expect(providerAgentSupportLabel({ agents: ['claude-code', 'codex'] })).toBe('Claude Code / Codex');
    expect(providerAgentSupportLabel({ agents: ['codex'] })).toBe('Codex');
  });

  it('combines localized model label with dynamic agent support and optional suffix', () => {
    expect(
      providerSubtitleForDisplay(
        { agents: ['claude-code', 'codex'] },
        'Grok models',
        { suffix: 'SuperGrok subscription (direct)' },
      ),
    ).toBe('Grok models · Claude Code / Codex · SuperGrok subscription (direct)');
  });

  it('lists Grok Build on SuperGrok/xAI even though catalog agents omit it', () => {
    expect(
      providerAgentSupportLabel({
        id: 'xai',
        agents: ['claude-code', 'codex', 'pi'],
      }),
    ).toBe('Claude Code / Codex / Pi / Grok Build');
    expect(
      providerSubtitleForDisplay(
        { id: 'xai', agents: ['claude-code', 'codex', 'pi'] },
        'Grok models',
        { suffix: 'SuperGrok subscription (direct)' },
      ),
    ).toBe(
      'Grok models · Claude Code / Codex / Pi / Grok Build · SuperGrok subscription (direct)',
    );
  });

  it('falls back when provider data is not loaded yet', () => {
    expect(providerSubtitleForDisplay(undefined, 'Grok models', { fallback: 'legacy subtitle' }))
      .toBe('legacy subtitle');
  });

  it('uses the same dynamic agent labels for custom providers', () => {
    const provider = {
      agents: ['claude-code'],
      routing: {
        'claude-code': {
          upstream: 'https://vendor.example/anthropic',
          authStrategy: 'api-key-header',
        },
      },
    } as Pick<ProviderView, 'agents' | 'routing'>;

    expect(customProviderSubtitleForDisplay(provider)).toBe('vendor.example/anthropic · Claude Code');
  });
});
