import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const composePrompt = (...parts: string[]) => parts
  .map((part) => part.replace(/\r\n?/g, '\n').trim())
  .filter(Boolean)
  .join('\n\n') + '\n';

const MAKER_HOST = '../../apps/desktop/src/main/maker-host';

const shared = async () => ({
  desktopHost: await readFile(path.resolve(MAKER_HOST, 'host-system-prompt.md'), 'utf8'),
  desktopPlans: await readFile(path.resolve(MAKER_HOST, 'user-facing-plans-prompt.md'), 'utf8'),
});

describe('production prompt parity', () => {
  it('matches the Desktop Claude host prompt after cross-platform newline normalization', async () => {
    const headless = await readFile(path.resolve('profiles/cindy-production-claude/prompt.md'), 'utf8');
    const { desktopHost, desktopPlans } = await shared();
    const desktopClaude = await readFile(path.resolve(`${MAKER_HOST}/claude-system-prompt.md`), 'utf8');
    expect(headless.replace(/\r\n?/g, '\n')).toBe(composePrompt(desktopHost, desktopClaude, desktopPlans));
  });

  it('matches the Desktop Codex host prompt after cross-platform newline normalization', async () => {
    const headless = await readFile(path.resolve('profiles/cindy-production-codex/prompt.md'), 'utf8');
    const { desktopHost, desktopPlans } = await shared();
    const desktopCodex = await readFile(path.resolve(`${MAKER_HOST}/codex-system-prompt.md`), 'utf8');
    expect(headless.replace(/\r\n?/g, '\n')).toBe(composePrompt(desktopHost, desktopCodex, desktopPlans));
  });

  it('matches the Desktop Pi host prompt after cross-platform newline normalization', async () => {
    const headless = await readFile(path.resolve('profiles/cindy-production-pi/prompt.md'), 'utf8');
    const { desktopHost, desktopPlans } = await shared();
    const desktopPi = await readFile(path.resolve(`${MAKER_HOST}/pi-system-prompt.md`), 'utf8');
    expect(headless.replace(/\r\n?/g, '\n')).toBe(composePrompt(desktopHost, desktopPi, desktopPlans));
  });
});
