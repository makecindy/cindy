/* 测试价值（PR #12731 维护者评审 2026-11-25 两轮 + Codex P1）
 * - 生产入口与可观察结果：resolveFetchUrl 在真实 git 下解析出的实际取包地址（及其去敏仓库标识）；
 *   MarketSourceManager.refreshSource 用真实 git 刷新后落位版本的 HEAD。
 * - 缺口：sources-manager.test.ts 用 fake 执行器模拟 git，不能证明真实 git 会按 insteadOf / includeIf 改写，
 *   也不能证明上游停在祖先时 pull --ff-only 的真实行为。
 * - 最小失败输入：url.<mirror>.insteadOf 改写到另一仓库；只注入凭证的改写；只对缓存仓库路径生效的
 *   includeIf；只在初始分支上生效的 onbranch 规则；同一配置改写到落后于缓存的仓库 B 后刷新。
 * - tier：git-integration（真实 git，隔离的全局配置，不联网，不读本机 git 配置）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { marketSourceKey, pluginMarketRepositoryFromUrl } from '../../../shared/pluginMarket';
import { MarketSourceManager, marketCloneSlug } from '../sources/index';
import { resolveFetchUrl, type GitExecutor } from '../sources/git';
import { MarketSourceStore } from '../sources/store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function isolatedGit(config: string | ((root: string) => string)): { executor: GitExecutor; root: string; setConfig: (text: string) => void } {
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
  return { executor, root, setConfig };
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
