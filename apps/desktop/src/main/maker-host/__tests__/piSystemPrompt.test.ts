import { beforeEach, describe, expect, it, vi } from 'vitest';

let commitAttributionEnabled = true;
vi.mock('../commit-attribution-settings-store.js', () => ({
  readCommitAttributionSettings: () => ({ enabled: commitAttributionEnabled }),
}));

import { composeDesktopPiSystemPrompt, composePiSystemPrompt } from '../pi-prompt-composer.js';
import hostSystemPrompt from '../host-system-prompt.md?raw';
import piSystemPrompt from '../pi-system-prompt.md?raw';

describe('composePiSystemPrompt', () => {
  beforeEach(() => {
    commitAttributionEnabled = true;
  });

  it('keeps the shared identity first and appends the Pi language behavior', () => {
    const prompt = composePiSystemPrompt(
      'You are Cindy.',
      "Infer the user's primary language and use it for reasoning and user-facing content.",
    );

    expect(prompt).toBe(
      "You are Cindy.\n\nInfer the user's primary language and use it for reasoning and user-facing content.",
    );
  });

  it('trims sections and omits empty ones', () => {
    expect(composePiSystemPrompt('  You are Cindy.  ', '   ')).toBe('You are Cindy.');
  });

  it('keeps dedicated file-tool guidance in the Pi behavior section', () => {
    expect(piSystemPrompt).toContain(
      'Use the dedicated grep tool for content search, the find tool for file discovery, the ls tool for directory listings, and the read tool for examining files.',
    );
    expect(piSystemPrompt).toContain(
      'Use Bash for Git, builds, tests, package managers, and shell operations not covered by a dedicated tool.',
    );
  });

  it('does not extend Claude/Codex Skill precedence into Pi', () => {
    expect(composePiSystemPrompt(hostSystemPrompt, piSystemPrompt)).not.toContain(
      '## Skill source precedence',
    );
  });

  it('omits only commit attribution when the persisted preference is disabled', () => {
    expect(composeDesktopPiSystemPrompt()).toContain('Assisted-by: Cindy (https://cindy.app)');

    commitAttributionEnabled = false;
    const prompt = composeDesktopPiSystemPrompt();
    expect(prompt).not.toContain('Assisted-by:');
    expect(prompt).toContain('You are Cindy, an open-source AI assistant.');
    expect(prompt).toContain('The user is working inside Cindy.');
    expect(prompt).toContain(piSystemPrompt.trim());
    expect(prompt).not.toContain('## Skill source precedence');
  });
});
