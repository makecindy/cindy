// 测试价值：生产 CLI 入口 publishScreenshots 写出的 PR 图片链接和 Git 推送目的地。
// Bug：同仓开发只有 origin 时，旧入口强制要求 fork 而无法发布截图；之前没有发布器回归。
// 最小失败输入：origin 指向项目本身，run 内有一张总览图。另保护专用分支边界和追加历史。
// tier：unit；临时文件 + 注入 Git，不访问网络、凭证或真实 Git 仓库。
// 实测耗时：node --test scripts/__tests__/ui-check-publish.test.mjs，墙钟 0.30 秒。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { publishScreenshots } from '../../apps/desktop/scripts/ui-page/publish.mjs';

const commit = 'a'.repeat(40);
const parent = 'b'.repeat(40);

async function fixture({ remotes = { origin: 'git@github.com:makecindy/cindy.git' }, existing = '' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ui-check-publish-'));
  const overview = path.join(root, 'overview.png');
  const pr = 'UI evidence\n\n<!-- 截图：overview.png -->\n';
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ repository: { url: remotes.origin } }));
  await writeFile(path.join(root, 'summary.json'), JSON.stringify({ overviews: [overview] }));
  await writeFile(path.join(root, 'pr.md'), pr);
  const calls = [];
  const git = (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'remote') return args.length === 1 ? Object.keys(remotes).join('\n') : remotes[args.at(-1)];
    if (args[0] === 'rev-parse') return 'feature/plugin-icon-fallback';
    if (args[0] === 'var') return 'Test Author <author@example.invalid> 0 +0000';
    if (args[0] === 'ls-remote') return existing ? `${existing}\t${args.at(-1)}` : '';
    if (args[0] === 'hash-object' || args[0] === 'mktree' || args[0] === 'commit-tree') return commit;
    if (['fetch', 'push', 'check-ref-format'].includes(args[0])) return '';
    throw new Error(`Unexpected git command: ${args.join(' ')}`);
  };
  return { root, pr, calls, git, log() {} };
}

test('同仓 origin 无需 fork，图片使用提交 SHA，产品分支和索引不变', async () => {
  const f = await fixture();
  await publishScreenshots([f.root], f);
  const published = await readFile(path.join(f.root, 'pr.published.md'), 'utf8');
  assert.ok(published.includes(`https://raw.githubusercontent.com/makecindy/cindy/${commit}/${path.basename(f.root)}/overview.png`));
  assert.equal(await readFile(path.join(f.root, 'pr.md'), 'utf8'), f.pr);
  assert.deepEqual(f.calls.filter(({ args }) => args[0] === 'push').map(({ args }) => args), [
    ['push', '--quiet', 'origin', `${commit}:refs/heads/pr-assets/feature/plugin-icon-fallback`],
  ]);
  assert.ok(!f.calls.some(({ args }) => ['checkout', 'switch', 'update-index', 'read-tree'].includes(args[0])));
  assert.match(f.calls.find(({ args }) => args[0] === 'commit-tree').args.at(-1), /Signed-off-by: Test Author <author@example.invalid>/);
});

test('显式远端和已有截图分支沿用同一历史，旧 SHA 链接可保持可达', async () => {
  const f = await fixture({ remotes: { assets: 'https://github.com/makecindy/cindy.git' }, existing: parent });
  await publishScreenshots([f.root, '--remote', 'assets', '--branch', 'pr-assets/icon-evidence'], f);
  const create = f.calls.find(({ args }) => args[0] === 'commit-tree').args;
  assert.equal(create[create.indexOf('-p') + 1], parent);
  assert.ok(f.calls.some(({ args }) => args[0] === 'push' && args[2] === 'assets' && args[3].endsWith(':refs/heads/pr-assets/icon-evidence')));
});

test('拒绝向产品分支发布截图，写入 Git 对象前终止', async () => {
  const f = await fixture();
  await assert.rejects(publishScreenshots([f.root, '--branch', 'main'], f), /pr-assets\//);
  assert.ok(!f.calls.some(({ args }) => ['hash-object', 'mktree', 'commit-tree', 'push'].includes(args[0])));
});

test('没有 origin 时要求显式指定目的地，不自动选中其他仓库', async () => {
  const f = await fixture({ remotes: { another: 'git@github.com:example/unrelated.git' } });
  await assert.rejects(publishScreenshots([f.root], f), /origin|--remote/);
  assert.ok(!f.calls.some(({ args }) => args[0] === 'push'));
});
