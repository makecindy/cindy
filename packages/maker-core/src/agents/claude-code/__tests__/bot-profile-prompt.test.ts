import { describe, expect, it } from 'vitest';

import { buildClaudeSystemPromptAppend } from '../index';

describe('Claude Bot Profile prompt assembly', () => {
  it('keeps the Bot SOUL as the first Cindy-owned stable segment', () => {
    const prompt = buildClaudeSystemPromptAppend({
      botProfilePrompt: 'BOT SOUL',
      botProfileContextPrompt: 'ACTIVE BOT PROFILE',
      makerMemoryRules: 'MEMORY RULES',
      hostSystemPrompt: 'HOST RULES',
      makerMemoryIndex: 'MEMORY INDEX',
      botUserProfilePrompt: 'USER PROFILE SNAPSHOT',
      userPrompt: 'USER OVERRIDE',
    });

    expect(prompt.startsWith('BOT SOUL\n\n')).toBe(true);
    expect(prompt.indexOf('BOT SOUL')).toBeLessThan(prompt.indexOf('MEMORY RULES'));
    expect(prompt.indexOf('ACTIVE BOT PROFILE')).toBeGreaterThan(prompt.indexOf('MEMORY RULES'));
    expect(prompt.indexOf('ACTIVE BOT PROFILE')).toBeLessThan(prompt.indexOf('HOST RULES'));
    expect(prompt.indexOf('MEMORY INDEX')).toBeLessThan(prompt.indexOf('USER OVERRIDE'));
    expect(prompt.indexOf('MEMORY INDEX')).toBeLessThan(prompt.indexOf('USER PROFILE SNAPSHOT'));
    expect(prompt.indexOf('USER PROFILE SNAPSHOT')).toBeLessThan(prompt.indexOf('USER OVERRIDE'));
  });

  it('omits the Bot segment when the caller disables it for an isolated mode', () => {
    expect(buildClaudeSystemPromptAppend({ botProfilePrompt: undefined })).not.toContain(
      'BOT SOUL',
    );
  });
});
