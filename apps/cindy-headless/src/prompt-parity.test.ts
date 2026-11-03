import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const composePrompt = (...parts: string[]) => parts
  .map((part) => part.replace(/\r\n?/g, '\n').trim())
  .filter(Boolean)
  .join('\n\n') + '\n';

describe('production prompt parity', () => {
  it('matches the Desktop Claude host prompt after cross-platform newline normalization', async () => {
    const headless = await readFile(path.resolve('profiles/cindy-production-claude/prompt.md'), 'utf8');
    const desktopHost = await readFile(path.resolve('../../apps/desktop/src/main/maker-host/host-system-prompt.md'), 'utf8');
    const desktopClaude = await readFile(path.resolve('../../apps/desktop/src/main/maker-host/claude-system-prompt.md'), 'utf8');
    expect(headless.replace(/\r\n?/g, '\n')).toBe(composePrompt(desktopHost, desktopClaude));
  });

  it('matches the Desktop Codex host prompt after cross-platform newline normalization', async () => {
    const headless = await readFile(path.resolve('profiles/cindy-production-codex/prompt.md'), 'utf8');
    const desktopHost = await readFile(path.resolve('../../apps/desktop/src/main/maker-host/host-system-prompt.md'), 'utf8');
    const desktopCodex = await readFile(path.resolve('../../apps/desktop/src/main/maker-host/codex-system-prompt.md'), 'utf8');
    expect(headless.replace(/\r\n?/g, '\n')).toBe(composePrompt(desktopHost, desktopCodex));
  });

  it('matches the Desktop Pi host prompt after cross-platform newline normalization', async () => {
    const headless = await readFile(path.resolve('profiles/cindy-production-pi/prompt.md'), 'utf8');
    const desktopHost = await readFile(path.resolve('../../apps/desktop/src/main/maker-host/host-system-prompt.md'), 'utf8');
    const desktopPi = await readFile(path.resolve('../../apps/desktop/src/main/maker-host/pi-system-prompt.md'), 'utf8');
    expect(headless.replace(/\r\n?/g, '\n')).toBe(composePrompt(desktopHost, desktopPi));
  });
});
