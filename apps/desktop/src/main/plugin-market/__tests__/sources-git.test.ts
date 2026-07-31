import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyGitFailure,
  cloneMarketplace,
  fetchMarketplace,
  gitVersion,
  isGitVersionSupported,
  type GitExecutor,
} from '../sources/git';
import { checkGitPreflight } from '../sources/preflight';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function destPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-market-git-'));
  roots.push(root);
  return path.join(root, 'clone');
}

/** 记录调用并按需造出克隆目录的假执行器。 */
function fakeExecutor(
  handler?: (args: readonly string[], cwd?: string) => { stdout?: string; stderr?: string },
): { executor: GitExecutor; calls: Array<{ args: readonly string[]; cwd?: string }> } {
  const calls: Array<{ args: readonly string[]; cwd?: string }> = [];
  const executor: GitExecutor = async (args, options) => {
    calls.push({ args, ...(options.cwd ? { cwd: options.cwd } : {}) });
    if (args[0] === 'clone') {
      fs.mkdirSync(String(args[args.length - 1]), { recursive: true });
    }
    const result = handler?.(args, options.cwd) ?? {};
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { executor, calls };
}

describe('cloneMarketplace', () => {
  it('clones plainly without ref or sparse paths', async () => {
    const { executor, calls } = fakeExecutor((_args) => ({ stdout: 'abc123\n' }));
    const dest = destPath();
    const revision = await cloneMarketplace(
      { url: 'https://x.test/r.git', sparsePaths: [] },
      dest,
      executor,
    );
    expect(calls[0]?.args.slice(0, 1)).toEqual(['clone']);
    expect(calls[0]?.args).not.toContain('--filter=blob:none');
    expect(calls[0]?.args).not.toContain('--branch');
    expect(revision).toBe('abc123');
    expect(fs.existsSync(dest)).toBe(true);
  });

  it('checks out the requested ref after a plain clone', async () => {
    const { executor, calls } = fakeExecutor(() => ({ stdout: 'abc123\n' }));
    await cloneMarketplace(
      { url: 'https://x.test/r.git', ref: 'v1.2', sparsePaths: [] },
      destPath(),
      executor,
    );
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['clone']));
    expect(calls[0]?.args).not.toContain('--branch');
    expect(calls[1]?.args).toEqual(['checkout', 'v1.2']);
  });

  it('uses blobless clone + sparse-checkout when sparse paths are given', async () => {
    const { executor, calls } = fakeExecutor(() => ({ stdout: 'abc123\n' }));
    await cloneMarketplace(
      { url: 'https://x.test/r.git', ref: 'main', sparsePaths: ['plugins/a', 'plugins/b'] },
      destPath(),
      executor,
    );
    expect(calls[0]?.args).toContain('--filter=blob:none');
    expect(calls[0]?.args).toContain('--no-checkout');
    expect(calls[1]?.args).toEqual(['sparse-checkout', 'set', '--', 'plugins/a', 'plugins/b']);
    expect(calls[2]?.args).toEqual(['checkout', 'main']);
  });

  it('checks out the default branch for sparse clones without an explicit ref', async () => {
    const { executor, calls } = fakeExecutor((args) =>
      args[0] === 'symbolic-ref' ? { stdout: 'origin/trunk\n' } : { stdout: 'abc123\n' },
    );
    await cloneMarketplace(
      { url: 'https://x.test/r.git', sparsePaths: ['plugins/a'] },
      destPath(),
      executor,
    );
    // 必须 checkout 真实分支:`checkout HEAD` 会留下 detached HEAD,后续刷新的
    // `git pull --ff-only` 稳定失败,每次刷新都退化成整仓重克隆。
    expect(calls.map((call) => call.args[0])).toContain('symbolic-ref');
    expect(calls.some((call) => call.args[0] === 'checkout' && call.args[1] === 'trunk')).toBe(true);
    expect(calls.some((call) => call.args[0] === 'checkout' && call.args[1] === 'HEAD')).toBe(false);
  });

  it('falls back to HEAD when the default branch cannot be resolved', async () => {
    const { executor, calls } = fakeExecutor((args) => {
      if (args[0] === 'symbolic-ref') throw new Error('no origin/HEAD');
      return { stdout: 'abc123\n' };
    });
    await cloneMarketplace(
      { url: 'https://x.test/r.git', sparsePaths: ['plugins/a'] },
      destPath(),
      executor,
    );
    expect(calls.some((call) => call.args[0] === 'checkout' && call.args[1] === 'HEAD')).toBe(true);
  });

  it('cleans the staging directory and classifies auth failures', async () => {
    const { executor } = fakeExecutor(() => {
      throw Object.assign(new Error('fatal: Authentication failed'), {
        stderr: 'fatal: Authentication failed',
      });
    });
    const dest = destPath();
    await expect(
      cloneMarketplace({ url: 'https://x.test/r.git', sparsePaths: [] }, dest, executor),
    ).rejects.toMatchObject({ code: 'MARKET_CLONE_AUTH_FAILED' });
    expect(fs.readdirSync(path.dirname(dest)).filter((n) => n.includes('staging'))).toEqual([]);
  });
});

describe('fetchMarketplace', () => {
  it('pulls fast-forward when no ref is pinned', async () => {
    const { executor, calls } = fakeExecutor(() => ({ stdout: 'def456\n' }));
    const dir = destPath();
    fs.mkdirSync(dir, { recursive: true });
    const revision = await fetchMarketplace(dir, undefined, executor);
    expect(calls.map((call) => call.args[0])).toEqual(['pull', 'rev-parse']);
    expect(calls[0]?.args).toContain('--ff-only');
    expect(revision).toBe('def456');
  });

  it('resets to FETCH_HEAD when a ref is pinned', async () => {
    const { executor, calls } = fakeExecutor(() => ({ stdout: 'def456\n' }));
    const dir = destPath();
    fs.mkdirSync(dir, { recursive: true });
    await fetchMarketplace(dir, 'v1.2', executor);
    expect(calls.map((call) => call.args[0])).toEqual(['fetch', 'reset', 'rev-parse']);
    expect(calls[1]?.args).toEqual(['reset', '--hard', 'FETCH_HEAD']);
  });
});

describe('git environment', () => {
  it('parses git versions and enforces the sparse-checkout floor', async () => {
    const { executor } = fakeExecutor(() => ({ stdout: 'git version 2.43.0\n' }));
    expect(await gitVersion(executor)).toEqual({ major: 2, minor: 43 });
    expect(isGitVersionSupported({ major: 2, minor: 25 })).toBe(true);
    expect(isGitVersionSupported({ major: 2, minor: 24 })).toBe(false);
    expect(isGitVersionSupported({ major: 3, minor: 0 })).toBe(true);
  });

  it('preflight fails closed when git cannot execute', async () => {
    const executor: GitExecutor = async () => {
      throw new Error('spawn git ENOENT');
    };
    expect(await checkGitPreflight(executor)).toEqual({ ok: false, version: null });
  });

  it('preflight reports versions below the floor', async () => {
    const { executor } = fakeExecutor(() => ({ stdout: 'git version 2.20.1\n' }));
    expect(await checkGitPreflight(executor)).toEqual({ ok: false, version: '2.20' });
  });
});

describe('classifyGitFailure', () => {
  it.each([
    'fatal: Authentication failed',
    'fatal: could not read Username for https://github.com: terminal prompts disabled',
    'ERROR: Repository not found.',
    'git@github.com: Permission denied (publickey).',
    // SSH 无权限的标准英文输出(LC_ALL=C 保证不被本地化文案绕过)
    'fatal: Could not read from remote repository.\nPlease make sure you have the correct access rights',
    // 组织强制 SAML SSO、SSH key 未授权该组织
    "ERROR: The 'acme' organization has enabled or enforced SAML SSO.",
  ])('classifies %s as an auth failure', (message) => {
    expect(classifyGitFailure(new Error(message)).code).toBe('MARKET_CLONE_AUTH_FAILED');
  });

  it.each([
    'fatal: Remote branch main not found in upstream origin',
    "fatal: couldn't find remote ref v9.9",
  ])('classifies %s as a missing ref', (message) => {
    expect(classifyGitFailure(new Error(message)).code).toBe('MARKET_REF_NOT_FOUND');
  });

  it('classifies other failures as generic clone failures', () => {
    expect(classifyGitFailure(new Error('Could not resolve host')).code).toBe(
      'MARKET_CLONE_FAILED',
    );
  });
});
