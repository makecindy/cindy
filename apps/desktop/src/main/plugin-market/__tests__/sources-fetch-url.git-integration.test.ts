/* 测试价值（PR #12731 维护者评审 2026-11-25：insteadOf 改写会让确认显示配置里的 A、实际取包来自 B）
 * - 生产入口与可观察结果：resolveFetchUrl 在真实 git 下解析出的实际取包地址，以及它经
 *   pluginMarketRepositoryFromUrl 去敏后进入来源身份的仓库标识。
 * - 缺口：sources-manager.test.ts 用 fake 执行器模拟解析结果，不能证明真实 git 会按 insteadOf 改写。
 * - 最小失败输入：url.<mirror>.insteadOf 改写到另一仓库；url.<带令牌地址>.insteadOf 只注入凭证；
 *   已克隆工作目录里的 origin。
 * - tier：git-integration（真实 git，隔离的全局配置，不联网，不读本机 git 配置）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { pluginMarketRepositoryFromUrl } from '../../../shared/pluginMarket';
import { resolveFetchUrl, type GitExecutor } from '../sources/git';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function isolatedGit(config: string): { executor: GitExecutor; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-fetch-url-'));
  roots.push(root);
  const globalConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(globalConfig, config);
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
  const executor: GitExecutor = (args, options) =>
    new Promise((resolve, reject) => {
      execFile('git', [...args], { cwd: options.cwd ?? root, timeout: options.timeoutMs, env }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderr }));
        else resolve({ stdout, stderr });
      });
    });
  return { executor, root };
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
