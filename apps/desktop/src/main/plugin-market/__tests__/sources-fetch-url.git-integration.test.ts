/* 测试价值（PR #12731 维护者评审 2026-11-25 两轮 + Codex P1）
 * - 生产入口与可观察结果：resolveFetchUrl 在真实 git 下解析出的实际取包地址（及其去敏仓库标识）；
 *   MarketSourceManager.refreshSource 用真实 git 刷新后落位版本的 HEAD。
 * - 缺口：sources-manager.test.ts 用 fake 执行器模拟 git，不能证明真实 git 会按 insteadOf / includeIf 改写，
 *   也不能证明上游停在祖先时 pull --ff-only 的真实行为。
 * - 最小失败输入：url.<mirror>.insteadOf 改写到另一仓库；只注入凭证的改写；只对缓存仓库路径生效的
 *   includeIf；只在初始分支上生效的 onbranch 规则；同一配置改写到落后于缓存的仓库 B 后刷新；初始分支（main）
 *   与远端默认分支（master）不同时，onbranch 规则只在 clone 中途生效（Codex P1）。
 * - tier：git-integration（真实 git，隔离的全局配置，不联网，不读本机 git 配置）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { marketSourceKey, pluginMarketFetchAddress, pluginMarketRepositoryFromUrl } from '../../../shared/pluginMarket';
import { MarketSourceManager, marketCloneSlug } from '../sources/index';
import { cloneMarketplace, hasBranchConditionalConfig, resolveFetchUrl, type GitExecutor } from '../sources/git';
import { MarketSourceStore } from '../sources/store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function isolatedGit(config: string | ((root: string) => string)): {
  executor: GitExecutor; root: string; setConfig: (text: string) => void; env: NodeJS.ProcessEnv;
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-fetch-url-')));
  roots.push(root);
  const globalConfig = path.join(root, 'gitconfig');
  const setConfig = (text: string) => fs.writeFileSync(globalConfig, `[init]\n\tdefaultBranch = main\n${text}`);
  setConfig(typeof config === 'string' ? config : config(root));
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test',
    LC_ALL: 'C',
  };
  const executor: GitExecutor = (args, options) =>
    new Promise((resolve, reject) => {
      execFile('git', [...args], { cwd: options.cwd ?? root, timeout: options.timeoutMs, env }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderr }));
        else resolve({ stdout, stderr });
      });
    });
  return { executor, root, setConfig, env };
}

describe('resolveFetchUrl with real git', () => {
  it('follows an insteadOf rewrite to another repository', async () => {
    const { executor, root } = isolatedGit(
      '[url "https://mirror.example.test/tenant/"]\n\tinsteadOf = https://origin.example.test/acme/\n',
    );
    const resolved = await resolveFetchUrl('https://origin.example.test/acme/plugins.git', executor);
    expect(pluginMarketRepositoryFromUrl(resolved)).toBe('mirror.example.test/tenant/plugins');
    // The same applies to `origin` inside a cloned working directory (the refresh path).
    const repo = path.join(root, 'repo');
    await executor(['init', '-q', repo], { timeoutMs: 10_000 });
    await executor(['remote', 'add', 'origin', 'https://origin.example.test/acme/plugins.git'], { cwd: repo, timeoutMs: 10_000 });
    expect(pluginMarketRepositoryFromUrl(await resolveFetchUrl('origin', executor, repo))).toBe('mirror.example.test/tenant/plugins');
  });

  it('keeps a token injected by an insteadOf rewrite out of the repository identity', async () => {
    const { executor } = isolatedGit('[url "https://ghp_SECRET@github.com/"]\n\tinsteadOf = https://github.com/\n');
    const resolved = await resolveFetchUrl('https://github.com/acme/plugins.git', executor);
    // git itself resolves to the credentialed address; only the whitelist result may leave Main.
    expect(resolved).toContain('ghp_SECRET');
    expect(pluginMarketRepositoryFromUrl(resolved)).toBe('github.com/acme/plugins');
  });
});

// PR #12731 maintainer review 6054636680: the host recorded as the verified source must be the host git itself
// parses. git hands a credential helper the protocol and host it will contact; every address the whitelist accepts
// must name the same host and port, and the ambiguous shapes it rejects are the ones where they would differ.
describe('fetch address whitelist against git URL parsing', () => {
  /**
   * The host git parses from `url`: a credential helper that echoes its input receives `host=` (with port). git
   * skips the helper when the URL already holds a username and password, so such URLs are not listed here.
   */
  function gitHost(env: NodeJS.ProcessEnv, cwd: string, url: string): Promise<string | null> {
    return new Promise((resolve) => {
      const child = execFile('git', ['-c', 'credential.helper=!f() { cat >&2; }; f', 'credential', 'fill'],
        { cwd, env, timeout: 10_000 }, (_error, _stdout, stderr) => resolve(/^host=(.*)$/m.exec(String(stderr))?.[1] ?? null));
      child.stdin?.end(`url=${url}\n\n`);
    });
  }
  it('accepts only addresses whose host and port match what git parses', async () => {
    const { env, root } = isolatedGit('');
    const accepted = [
      'https://git.example.test/acme/plugins.git',
      'https://ghp_ONE@git.example.test/acme/plugins.git',
      'https://git.example.test:8443/acme/plugins.git',
      'HTTPS://Git.Example.TEST/acme/plugins.git',
      'http://git.example.test/acme/plugins/',
    ];
    const ambiguous = [
      'https://git.example.test?@evil.example/acme/plugins.git',
      'https://git.example.test#@evil.example/acme/plugins.git',
      'https://git.example.test/@evil.example/acme/plugins.git',
    ];
    for (const url of accepted) {
      const address = pluginMarketFetchAddress(url);
      expect(address, url).not.toBeNull();
      const parsed = await gitHost(env, root, url);
      expect(parsed?.toLowerCase(), url).toBe(address!.port ? `${address!.host}:${address!.port}` : address!.host);
    }
    // git contacts git.example.test for these, while a greedy userinfo match would name evil.example: rejected.
    for (const url of ambiguous) {
      expect(await gitHost(env, root, url), url).toBe('git.example.test');
      expect(pluginMarketFetchAddress(url), url).toBeNull();
      expect(pluginMarketRepositoryFromUrl(url), url).toBeNull();
    }
  });
});

describe('fetch address context and refresh target with real git', () => {
  it('sees an includeIf rewrite only inside the cache repository, so a global resolution alone is not enough', async () => {
    const { executor, root } = isolatedGit((dir) => {
      fs.writeFileSync(path.join(dir, 'inner.gitconfig'),
        '[url "https://mirror.example.test/tenant/"]\n\tinsteadOf = https://origin.example.test/acme/\n');
      return `[includeIf "gitdir:${dir}/sources/"]\n\tpath = ${dir}/inner.gitconfig\n`;
    });
    const repo = path.join(root, 'sources', 'repo');
    fs.mkdirSync(repo, { recursive: true });
    await executor(['init', '-q', repo], { timeoutMs: 10_000 });
    await executor(['remote', 'add', 'origin', 'https://origin.example.test/acme/plugins.git'], { cwd: repo, timeoutMs: 10_000 });
    const outside = await resolveFetchUrl('https://origin.example.test/acme/plugins.git', executor);
    const inside = await resolveFetchUrl('origin', executor, repo);
    expect(pluginMarketRepositoryFromUrl(outside)).toBe('origin.example.test/acme/plugins');
    expect(pluginMarketRepositoryFromUrl(inside)).toBe('mirror.example.test/tenant/plugins');
  });

  it('sees an onbranch rewrite only while on that branch, so the address must be sampled before detaching', async () => {
    const { executor, root } = isolatedGit((dir) => {
      fs.writeFileSync(path.join(dir, 'inner.gitconfig'),
        '[url "https://mirror.example.test/tenant/"]\n\tinsteadOf = https://origin.example.test/acme/\n');
      return `[includeIf "onbranch:main"]\n\tpath = ${dir}/inner.gitconfig\n`;
    });
    const repo = path.join(root, 'repo');
    const git = (args: string[]) => executor(args, { cwd: repo, timeoutMs: 10_000 });
    await executor(['init', '-q', repo], { timeoutMs: 10_000 });
    await git(['remote', 'add', 'origin', 'https://origin.example.test/acme/plugins.git']);
    await git(['commit', '-q', '--allow-empty', '-m', 'first']);
    expect(pluginMarketRepositoryFromUrl(await resolveFetchUrl('origin', executor, repo))).toBe('mirror.example.test/tenant/plugins');
    await git(['checkout', '-q', '--detach']);
    expect(pluginMarketRepositoryFromUrl(await resolveFetchUrl('origin', executor, repo))).toBe('origin.example.test/acme/plugins');
  });

  // Codex P1 on PR #12731: some git versions fetch while the new repository is on its initial branch
  // (init.defaultBranch) and switch to the remote's default branch before returning, so no sample taken afterwards
  // can see a rule that only applied mid-clone. The manager therefore refuses to verify a clone whenever such rules exist.
  it('cannot see an onbranch rewrite that applied only mid-clone, but detects that such a rule exists', async () => {
    const { executor, root, setConfig } = isolatedGit('');
    const git = (args: string[], cwd?: string) => executor(args, { ...(cwd ? { cwd } : {}), timeoutMs: 30_000 });
    for (const name of ['a', 'b']) {
      const work = path.join(root, `work-${name}`);
      await git(['init', '-q', '-b', 'master', work]);
      fs.writeFileSync(path.join(work, 'marker'), name);
      await git(['add', '-A'], work);
      await git(['commit', '-q', '-m', name], work);
      await git(['clone', '-q', '--bare', work, path.join(root, `${name}.git`)]);
    }
    const configured = `file://${path.join(root, 'a.git')}`;
    fs.writeFileSync(path.join(root, 'inner.gitconfig'),
      `[url "file://${path.join(root, 'b.git')}"]\n\tinsteadOf = ${configured}\n`);
    setConfig(`[includeIf "onbranch:main"]\n\tpath = ${path.join(root, 'inner.gitconfig')}\n`);

    const samples = [await resolveFetchUrl(configured, executor)];
    const dest = path.join(root, 'sources', 'clone');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await cloneMarketplace({ url: configured, sparsePaths: [] }, dest, executor, async (repoDir) => {
      samples.push(await resolveFetchUrl('origin', executor, repoDir));
    });
    samples.push(await resolveFetchUrl(configured, executor));
    // Every sample names A. Which repository the clone actually fetched depends on the git version (2.43 applies the
    // rule on the initial branch and fetches B; 2.56 fetches A), so the samples cannot tell; only detecting the rule
    // makes the result safe on every version.
    expect(new Set(samples)).toEqual(new Set([configured]));
    expect(['a', 'b']).toContain(fs.readFileSync(path.join(dest, 'marker'), 'utf8'));
    expect(await hasBranchConditionalConfig(executor)).toBe(true);
    expect(await hasBranchConditionalConfig(executor, dest)).toBe(true);
    setConfig('');
    expect(await hasBranchConditionalConfig(executor)).toBe(false);
  });

  it('clones afresh when the rewritten repository is behind the cached commit', async () => {
    const { executor, root, setConfig } = isolatedGit('');
    const git = (args: string[], cwd?: string) => executor(args, { ...(cwd ? { cwd } : {}), timeoutMs: 30_000 });
    // Repository A has two commits; repository B only has the first one (an ancestor of A's HEAD).
    const work = path.join(root, 'work');
    await git(['init', '-q', work]);
    fs.mkdirSync(path.join(work, 'p'), { recursive: true });
    fs.writeFileSync(path.join(work, 'p', 'ghost.json'), JSON.stringify({ schemaVersion: 2, id: 'alpha', name: 'Alpha', version: '1.0.0', entry: 'main.js', slots: ['notify'] }));
    fs.writeFileSync(path.join(work, 'p', 'main.js'), '// entry');
    fs.mkdirSync(path.join(work, '.agents', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(work, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'hub', plugins: [{ name: 'alpha', source: 'p' }] }));
    await git(['add', '-A'], work);
    await git(['commit', '-q', '-m', 'first'], work);
    const first = (await git(['rev-parse', 'HEAD'], work)).stdout.trim();
    fs.writeFileSync(path.join(work, 'README.md'), 'second');
    await git(['add', '-A'], work);
    await git(['commit', '-q', '-m', 'second'], work);
    await git(['clone', '-q', '--bare', work, path.join(root, 'a.git')]);
    await git(['clone', '-q', '--bare', work, path.join(root, 'b.git')]);
    await git(['update-ref', 'refs/heads/main', first], path.join(root, 'b.git'));

    const configured = 'https://origin.example.test/acme/plugins.git';
    const rewriteTo = (bare: string) => setConfig(`[url "file://${path.join(root, bare)}"]\n\tinsteadOf = ${configured}\n`);
    rewriteTo('a.git');
    const store = new MarketSourceStore(path.join(root, 'sources.v1.json'));
    const manager = new MarketSourceManager({ store, cloneRoot: path.join(root, 'sources'), homeDir: root, gitExecutor: executor });
    await manager.addSource({ source: configured });
    const slot = path.join(root, 'sources', marketCloneSlug('hub', { type: 'git', url: configured, sparsePaths: [] }));
    const currentHead = async () => {
      const version = fs.readFileSync(path.join(slot, 'current'), 'utf8').trim();
      return (await git(['rev-parse', 'HEAD'], path.join(slot, 'versions', version))).stdout.trim();
    };
    expect(await currentHead()).not.toBe(first);

    // Same configuration, now rewritten to B, which sits on A's ancestor: pull --ff-only would keep A's commit.
    rewriteTo('b.git');
    await manager.refreshSource('hub');
    expect(await currentHead()).toBe(first);
    expect(marketSourceKey(store.get('hub')!.source)).toContain(configured);
  });
});
