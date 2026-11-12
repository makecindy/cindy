import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';

const h = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: h.execFile }));

import {
  isBinaryVersionNotOlder,
  parseBinaryVersionOutput,
  probeBinaryVersion,
} from '../binary-version-probe.js';

describe('binary version probe', () => {
  it('normalizes bare, v-prefixed, and Pi-prefixed semantic versions', () => {
    expect(parseBinaryVersionOutput('0.84.4\n', '')).toBe('0.84.4');
    expect(parseBinaryVersionOutput('v0.84.4-beta.1\n', '')).toBe('0.84.4-beta.1');
    expect(parseBinaryVersionOutput('pi 0.84.4\n', '')).toBe('0.84.4');
    expect(parseBinaryVersionOutput('pi v0.84.4-beta.1\n', '')).toBe('0.84.4-beta.1');
  });

  it('normalizes the Claude Code and codex --version shapes', () => {
    expect(parseBinaryVersionOutput('2.1.258 (Claude Code)\n', '')).toBe('2.1.258');
    expect(parseBinaryVersionOutput('codex-cli 0.145.0\n', '')).toBe('0.145.0');
    expect(parseBinaryVersionOutput('codex-cli v0.145.0\n', '')).toBe('0.145.0');
  });

  it('uses SemVer precedence for prerelease arbitration', () => {
    expect(isBinaryVersionNotOlder('0.84.5-beta.1', '0.84.4')).toBe(true);
    expect(isBinaryVersionNotOlder('0.84.5-beta.1', '0.84.5')).toBe(false);
  });

  it('rejects unrelated or multiline-leading output', () => {
    expect(parseBinaryVersionOutput('other 0.84.4\n', '')).toBeNull();
    expect(parseBinaryVersionOutput('warning\n0.84.4\n', '')).toBeNull();
    expect(parseBinaryVersionOutput('codex-cli 0.145.0 (extra)\n', '')).toBeNull();
    expect(parseBinaryVersionOutput('(Claude Code) 2.1.258\n', '')).toBeNull();
  });

  it('returns null instead of throwing when the executable cannot be spawned', async () => {
    h.execFile.mockImplementation(() => { throw new Error('spawn failed'); });
    await expect(probeBinaryVersion('/definitely/missing/cindy-runtime')).resolves.toBeNull();
  });

  it('returns null when the host cancels the startup probe', async () => {
    h.execFile.mockImplementation((_file, _args, options, callback) => {
      callback(options.signal.aborted ? new Error('aborted') : null, '', '');
    });
    const controller = new AbortController();
    controller.abort();
    await expect(probeBinaryVersion(process.execPath, controller.signal)).resolves.toBeNull();
  });

  // Unit regression: --version itself writes Codex helper files. Previous tests only
  // checked parsing/spawn failure, not the child environment or temporary-home lifetime.
  it.each([false, true])('isolates and cleans the Codex home even on failure=%s', async (fails) => {
    let home = '';
    h.execFile.mockImplementation((_file, args, options, callback) => {
      expect(args).toEqual(['--version']);
      home = options.env?.CODEX_HOME;
      expect(home).toBeTruthy();
      expect(home).not.toBe(process.env.CODEX_HOME);
      expect(existsSync(home)).toBe(true);
      callback(fails ? new Error('probe failed') : null, 'codex-cli 0.166.0', '');
    });
    await expect(probeBinaryVersion('/managed/codex')).resolves.toBe(fails ? null : '0.166.0');
    expect(home).toBeTruthy();
    expect(existsSync(home)).toBe(false);
  });
});
