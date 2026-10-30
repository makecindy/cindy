import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveMakeRuntime, type RuntimeGit } from '../runtimeVersion';

const commit = 'a'.repeat(40);
const candidate = 'b'.repeat(40);
const root = path.resolve('runtime-checkout');
const build = { commit, dirty: false, root };
const signal = () => new AbortController().signal;
const cleanGit = () =>
  vi.fn<RuntimeGit>(async (_root, args) => ({
    code: 0,
    stdout: args[0] === 'rev-parse' ? commit : '',
  }));

describe('Cindy Make running source identity', () => {
  it.each([
    [false, '0.0.0', 'dev'],
    [true, '1.2.3-beta.1', 'beta'],
    [true, '1.2.3', 'release'],
    [true, '0.0.0', 'release'],
  ] as const)(
    'identifies packaged=%s version=%s without using prepared source',
    async (packaged, version, channel) => {
      const git = cleanGit();
      const result = await resolveMakeRuntime({ packaged, version }, signal(), build, git);
      expect(result.runtime).toEqual({ channel, version, commit, confidence: 'exact' });
      expect(await result.containsCommit(commit)).toBe('included');
      if (packaged) expect(git).not.toHaveBeenCalled();
      else expect(git.mock.calls.every(([cwd]) => cwd === root)).toBe(true);
    },
  );

  it.each([{}, { commit }, { commit, dirty: true }, { commit: 'main', dirty: false }])(
    'never guesses a commit from a version/tag when source metadata is uncertain: %j',
    async (source) => {
      const git = cleanGit();
      const result = await resolveMakeRuntime(
        { packaged: true, version: '1.2.3' },
        signal(),
        source,
        git,
      );
      expect(result.runtime.confidence).toBe('unknown');
      expect(await result.containsCommit(commit)).toBe('unknown');
      expect(git).not.toHaveBeenCalled();
    },
  );

  it.each(['moved', 'dirty', 'failed', 'missing-root'])(
    'keeps Dev identity uncertain for %s',
    async (reason) => {
      const git = cleanGit();
      if (reason === 'moved') git.mockImplementation(async () => ({ code: 0, stdout: candidate }));
      if (reason === 'dirty')
        git.mockImplementation(async (_root, args) => ({
          code: 0,
          stdout: args[0] === 'rev-parse' ? commit : ' M file.ts\0',
        }));
      if (reason === 'failed') git.mockRejectedValue(new Error('git unavailable'));
      const result = await resolveMakeRuntime(
        { packaged: false, version: '0.0.0' },
        signal(),
        { ...build, root: reason === 'missing-root' ? undefined : root },
        git,
      );
      expect(result.runtime.confidence).toBe('unknown');
      expect(await result.containsCommit(candidate)).toBe('unknown');
      expect(result.runtime.commit).toBe(commit);
    },
  );

  it('invalidates Dev results if files change after the initial snapshot', async () => {
    const git = cleanGit();
    const result = await resolveMakeRuntime(
      { packaged: false, version: '0.0.0' },
      signal(),
      build,
      git,
    );
    git.mockResolvedValue({ code: 0, stdout: ' M changed.ts\0' });
    expect(await result.isCurrent()).toBe(false);
    expect(await result.containsCommit(commit)).toBe('unknown');
    git.mockImplementation(async (_root, args) => ({
      code: 0,
      stdout: args[0] === 'rev-parse' ? commit : '',
    }));
    expect(await result.isCurrent()).toBe(false);
  });

  it.each([
    ['ancestor', 0, '', 'included'],
    ['reverted', 0, 'Revert original\nThis reverts commit ' + candidate, 'unknown'],
    ['later', 1, '', 'notIncluded'],
    ['diverged', 1, '', 'unknown'],
    ['unavailable', 128, '', 'unknown'],
  ] as const)('checks immutable commits for %s', async (kind, ancestorCode, log, expected) => {
    const git = cleanGit();
    git.mockImplementation(async (_root, args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: commit };
      if (args[0] === 'merge-base')
        return {
          code: args[2] === candidate ? ancestorCode : kind === 'later' ? 0 : 1,
          stdout: '',
        };
      return { code: 0, stdout: args[0] === 'log' ? log : '' };
    });
    const result = await resolveMakeRuntime(
      { packaged: false, version: '0.0.0' },
      signal(),
      build,
      git,
    );
    expect(await result.containsCommit(candidate)).toBe(expected);
    expect(git.mock.calls.some(([, args]) => args.includes('origin/main'))).toBe(false);
  });

  it('does not treat an aborted query as a verified runtime', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await resolveMakeRuntime(
      { packaged: true, version: '1.0.0' },
      controller.signal,
      build,
      cleanGit(),
    );
    expect(result.runtime.confidence).toBe('unknown');
  });
});
