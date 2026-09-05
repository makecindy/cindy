import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_CODE_MINIMUM_VERSION,
  resolveSystemClaudeCode,
  __testing,
} from '../system-claude-code.js';

function deps(
  options: {
    platform?: NodeJS.Platform;
    version?: string | null;
    exists?: boolean;
    executable?: boolean;
  } = {},
) {
  return {
    platform: options.platform ?? process.platform,
    envPath: '',
    homeDir: path.parse(process.cwd()).root,
    stat: vi.fn(async () => {
      if (options.exists === false) throw new Error('missing');
      return { isFile: () => true };
    }),
    access: vi.fn(async () => {
      if (options.executable === false) throw new Error('denied');
    }),
    probeVersion: vi.fn(async () => options.version ?? CLAUDE_CODE_MINIMUM_VERSION),
  };
}

describe('system Claude Code resolver', () => {
  it('accepts a compatible absolute executable path', async () => {
    const candidate = path.resolve('claude-test-bin');
    const result = await resolveSystemClaudeCode(candidate, undefined, deps());

    expect(result).toMatchObject({
      ok: true,
      binaryPath: candidate,
      version: CLAUDE_CODE_MINIMUM_VERSION,
    });
  });

  it('rejects a system version older than Cindy minimum without losing diagnostics', async () => {
    const candidate = path.resolve('claude-old-bin');
    const result = await resolveSystemClaudeCode(candidate, undefined, deps({ version: '1.0.0' }));

    expect(result).toMatchObject({
      ok: false,
      reason: 'version_too_old',
      binaryPath: candidate,
      version: '1.0.0',
      minimumVersion: CLAUDE_CODE_MINIMUM_VERSION,
    });
  });

  it('accepts a stable system version newer than Cindy minimum', async () => {
    const candidate = path.resolve('claude-new-bin');
    await expect(
      resolveSystemClaudeCode(candidate, undefined, deps({ version: '99.0.0' })),
    ).resolves.toMatchObject({ ok: true, binaryPath: candidate, version: '99.0.0' });
  });

  it.each([
    ['an unreadable version', null],
    ['an outdated version', '1.0.0'],
  ])('continues PATH discovery after %s', async (_label, firstVersion) => {
    const firstDirectory = path.resolve('first-claude-bin');
    const secondDirectory = path.resolve('second-claude-bin');
    const firstCandidate = path.join(firstDirectory, 'claude');
    const secondCandidate = path.join(secondDirectory, 'claude');
    const probeVersion = vi.fn(async (candidate: string) =>
      candidate === firstCandidate ? firstVersion : '99.0.0',
    );
    const resolverDeps = {
      ...deps({ platform: 'linux' }),
      envPath: [firstDirectory, secondDirectory].join(path.delimiter),
      stat: vi.fn(async (candidate: string) => {
        if (candidate !== firstCandidate && candidate !== secondCandidate) throw new Error('missing');
        return { isFile: () => true };
      }),
      probeVersion,
    };

    await expect(resolveSystemClaudeCode('', undefined, resolverDeps)).resolves.toMatchObject({
      ok: true,
      binaryPath: secondCandidate,
      version: '99.0.0',
    });
    expect(probeVersion).toHaveBeenNthCalledWith(1, firstCandidate, undefined);
    expect(probeVersion).toHaveBeenNthCalledWith(2, secondCandidate, undefined);
  });

  it('returns the most actionable version failure after exhausting PATH candidates', async () => {
    const unreadableDirectory = path.resolve('unreadable-claude-bin');
    const outdatedDirectory = path.resolve('outdated-claude-bin');
    const unreadableCandidate = path.join(unreadableDirectory, 'claude');
    const outdatedCandidate = path.join(outdatedDirectory, 'claude');
    const resolverDeps = {
      ...deps({ platform: 'linux' }),
      envPath: [unreadableDirectory, outdatedDirectory].join(path.delimiter),
      stat: vi.fn(async (candidate: string) => {
        if (candidate !== unreadableCandidate && candidate !== outdatedCandidate) {
          throw new Error('missing');
        }
        return { isFile: () => true };
      }),
      probeVersion: vi.fn(async (candidate: string) =>
        candidate === outdatedCandidate ? '1.0.0' : null,
      ),
    };

    await expect(resolveSystemClaudeCode('', undefined, resolverDeps)).resolves.toMatchObject({
      ok: false,
      reason: 'version_too_old',
      binaryPath: outdatedCandidate,
      version: '1.0.0',
    });
  });

  it('distinguishes missing and non-executable custom paths', async () => {
    await expect(
      resolveSystemClaudeCode(path.resolve('missing-claude'), undefined, deps({ exists: false })),
    ).resolves.toMatchObject({ ok: false, reason: 'not_found' });

    await expect(
      resolveSystemClaudeCode(
        path.resolve('denied-claude'),
        undefined,
        deps({ executable: false }),
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'not_executable' });
  });

  it('rejects prerelease versions even when their numeric core is newer', async () => {
    const result = await resolveSystemClaudeCode(
      path.resolve('claude-prerelease-bin'),
      undefined,
      deps({ version: '99.0.0-beta.1' }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'version_too_old' });
  });

  it('recognizes Claude Code version output', () => {
    expect(__testing.parseClaudeVersion('2.1.258 (Claude Code)\n')).toBe('2.1.258');
    expect(__testing.parseClaudeVersion('unrelated output')).toBeNull();
  });

  it('rejects Windows command shims as SDK executable paths', async () => {
    const candidate = path.resolve('claude.cmd');
    const result = await resolveSystemClaudeCode(candidate, undefined, deps({ platform: 'win32' }));
    expect(result).toMatchObject({ ok: false, reason: 'unsupported_launcher' });
  });
});
