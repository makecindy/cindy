import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const composePrompt = (...parts: string[]) => parts
  .map((part) => part.replace(/\r\n?/g, '\n').trim())
  .filter(Boolean)
  .join('\n\n') + '\n';

async function desktopPromptParts(agentFile: string) {
  const directory = '../../apps/desktop/src/main/maker-host';
  return Promise.all([
    readFile(path.resolve(directory, 'host-system-prompt.md'), 'utf8'),
    readFile(path.resolve(directory, 'commit-attribution-prompt.md'), 'utf8'),
    readFile(path.resolve(directory, 'host-runtime-prompt.md'), 'utf8'),
    readFile(path.resolve(directory, agentFile), 'utf8'),
  ]);
}

describe('production prompt parity', () => {
  it('matches the Desktop Claude host prompt after cross-platform newline normalization', async () => {
    const headless = await readFile(path.resolve('profiles/cindy-production-claude/prompt.md'), 'utf8');
    const parts = await desktopPromptParts('claude-system-prompt.md');
    expect(headless.replace(/\r\n?/g, '\n')).toBe(composePrompt(...parts));
  });

  it('matches the Desktop Codex host prompt after cross-platform newline normalization', async () => {
    const headless = await readFile(path.resolve('profiles/cindy-production-codex/prompt.md'), 'utf8');
    const parts = await desktopPromptParts('codex-system-prompt.md');
    expect(headless.replace(/\r\n?/g, '\n')).toBe(composePrompt(...parts));
  });

  it('matches the Desktop Pi host prompt after cross-platform newline normalization', async () => {
    const headless = await readFile(path.resolve('profiles/cindy-production-pi/prompt.md'), 'utf8');
    const parts = await desktopPromptParts('pi-system-prompt.md');
    expect(headless.replace(/\r\n?/g, '\n')).toBe(composePrompt(...parts));
  });
});
