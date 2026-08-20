import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { scanHistory } from '../check-git-hygiene.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '..', 'check-git-hygiene.mjs');

function createRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-git-hygiene-')));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
  };
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '--quiet', '--initial-branch=main', '.');
  git('config', 'user.name', 'Git Hygiene Test');
  git('config', 'user.email', 'git-hygiene@example.invalid');
  git('config', 'commit.gpgsign', 'false');

  const write = (name, content) => {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const commitAll = (message) => {
    git('add', '--all');
    git('commit', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  write('README.md', 'base\n');
  commitAll('base');
  const base = git('rev-parse', 'HEAD');

  const writeAllowlist = (allowlist = []) => {
    fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.github', 'git-hygiene-allowlist.json'),
      `${JSON.stringify({ version: 1, entries: allowlist }, null, 2)}\n`
    );
  };

  const runCheck = (head = 'HEAD', allowlist = [], baseRef = base) => {
    writeAllowlist(allowlist);
    return spawnSync('node', [SCRIPT, '--base', baseRef, '--head', head], {
      cwd: dir,
      env,
      encoding: 'utf8',
    });
  };

  const runCheckFromEvent = (head = 'HEAD') => {
    writeAllowlist();
    const eventPath = path.join(dir, 'pull-request-event.json');
    fs.writeFileSync(
      eventPath,
      `${JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: git('rev-parse', head) } } })}\n`
    );
    return spawnSync('node', [SCRIPT], {
      cwd: dir,
      env: { ...env, GITHUB_EVENT_PATH: eventPath },
      encoding: 'utf8',
    });
  };

  return { dir, git, write, commitAll, base, runCheck, runCheckFromEvent };
}

test('real Git history catches a temporary file after later deletion', (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));
  repo.git('switch', '--quiet', '-c', 'feature');
  repo.write('tmp/github-result-review.json', '{"temporary":true}\n');
  const introducingCommit = repo.commitAll('add temporary export');
  fs.rmSync(path.join(repo.dir, 'tmp'), { recursive: true, force: true });
  repo.commitAll('delete temporary export');

  const head = repo.git('rev-parse', 'HEAD');
  const candidates = scanHistory(repo.base, head, { cwd: repo.dir });
  assert.ok(candidates.some((candidate) => candidate.path === 'tmp/github-result-review.json'));

  const result = repo.runCheck();
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, new RegExp(introducingCommit));
  assert.match(output, /tmp\/github-result-review\.json/);
  assert.match(output, /Deleting the file in a later commit does not remove its blob/);
});

test('real Git history catches a nested tmp/ path after later deletion', (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));
  repo.git('switch', '--quiet', '-c', 'feature');
  repo.write('packages/foo/tmp/github-result-1.json', '{"temporary":true}\n');
  const introducingCommit = repo.commitAll('add nested temporary export');
  fs.rmSync(path.join(repo.dir, 'packages', 'foo', 'tmp'), { recursive: true, force: true });
  repo.commitAll('delete nested temporary export');

  const result = repo.runCheck();
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, new RegExp(introducingCommit));
  assert.match(output, /packages\/foo\/tmp\/github-result-1\.json/);
});

test('real Git history catches a gitlink/submodule under tmp/', (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  // 建一个独立子仓库作为 submodule 目标。
  const subDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-git-hygiene-sub-')));
  const subGit = (...args) =>
    execFileSync('git', args, { cwd: subDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  subGit('init', '--quiet', '--initial-branch=main', '.');
  subGit('config', 'user.name', 'Sub Repo');
  subGit('config', 'user.email', 'sub@example.invalid');
  fs.writeFileSync(path.join(subDir, 'README.md'), 'sub\n');
  subGit('add', '--all');
  subGit('commit', '--quiet', '-m', 'sub base');

  repo.git('switch', '--quiet', '-c', 'feature');
  // 真实 submodule 流程：写入 .gitmodules + gitlink（mode 160000）。
  repo.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', subDir, 'tmp/embedded-repo');
  const introducingCommit = repo.commitAll('add tmp submodule');

  const result = repo.runCheck();
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, new RegExp(introducingCommit));
  assert.match(output, /tmp\/embedded-repo/);
  fs.rmSync(subDir, { recursive: true, force: true });
});

test('updating an existing gitlink under tmp/ does not false positive', (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  const subDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-git-hygiene-sub-')));
  const subGit = (...args) =>
    execFileSync('git', args, { cwd: subDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  subGit('init', '--quiet', '--initial-branch=main', '.');
  subGit('config', 'user.name', 'Sub Repo');
  subGit('config', 'user.email', 'sub@example.invalid');
  fs.writeFileSync(path.join(subDir, 'README.md'), 'sub\n');
  subGit('add', '--all');
  subGit('commit', '--quiet', '-m', 'sub base');

  // 先在 main 上建立 tmp/ 下的 gitlink（baseline 已存在该路径）。
  repo.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', subDir, 'tmp/embedded-repo');
  const movedBase = repo.commitAll('baseline adds tmp gitlink');

  // feature 分支仅更新该 submodule 指针，不新增路径。
  repo.git('switch', '--quiet', '-c', 'feature');
  subGit('commit', '--quiet', '--allow-empty', '-m', 'sub advance');
  const newSubSha = subGit('rev-parse', 'HEAD');
  repo.git('update-index', '--cacheinfo', '160000', newSubSha, 'tmp/embedded-repo');
  // 指针已在 index 里，直接 commit（不经 git add --all，避免 worktree submodule 状态干扰）。
  repo.git('commit', '--quiet', '-m', 'bump tmp submodule pointer');

  // base 指向推进后的 main：tmp/embedded-repo 已在 baseline paths 里，不得误报为临时路径。
  const result = repo.runCheck('HEAD', [], movedBase);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  fs.rmSync(subDir, { recursive: true, force: true });
});

test('real Git history catches an artifact introduced by a merge', (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  repo.git('switch', '--quiet', '-c', 'feature');
  repo.write('feature.txt', 'feature\n');
  repo.commitAll('feature work');

  repo.git('switch', '--quiet', '-c', 'artifact-side', repo.base);
  repo.write('side.txt', 'side work\n');
  repo.commitAll('side branch work');
  repo.git('switch', '--quiet', 'feature');
  repo.git('merge', '--quiet', '--no-ff', '--no-commit', 'artifact-side');
  repo.write('tmp/windows-1-logs.zip', 'fake zip\n');
  repo.git('add', '--all');
  repo.git('commit', '--quiet', '-m', 'merge side branch with artifact');
  const mergeCommit = repo.git('rev-parse', 'HEAD');
  fs.rmSync(path.join(repo.dir, 'tmp'), { recursive: true, force: true });
  repo.commitAll('remove merged artifact');

  const result = repo.runCheck();
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /tmp\/windows-1-logs\.zip/);
  assert.match(output, new RegExp(mergeCommit));
});

test('real Git history accepts small source and an exactly registered archive', (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));
  repo.git('switch', '--quiet', '-c', 'feature');
  repo.write('src/feature.txt', 'small source\n');
  repo.write('assets/vendor-input.zip', 'reviewed fixture\n');
  repo.commitAll('add reviewed assets');
  const blob = repo.git('rev-parse', 'HEAD:assets/vendor-input.zip');

  const result = repo.runCheck('HEAD', [
    { path: 'assets/vendor-input.zip', blob, reason: 'Reviewed vendor build input.' },
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Git history hygiene check passed/);
});

test('CLI resolves the pull request base and head from the GitHub event payload', (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));
  repo.git('switch', '--quiet', '-c', 'feature');
  repo.write('src/feature.txt', 'small source\n');
  repo.commitAll('feature work');

  const result = repo.runCheckFromEvent();
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Git history hygiene check passed/);
  assert.match(result.stdout, /\(base [0-9a-f]{40}\)/);
});

test('merging main that already added an archive does not false positive', (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  repo.git('switch', '--quiet', '-c', 'feature');
  repo.write('feature.txt', 'feature\n');
  repo.commitAll('feature work');

  repo.git('switch', '--quiet', 'main');
  repo.write('assets/base-input.zip', 'already accepted on main\n');
  const movedBase = repo.commitAll('base adds archive');
  repo.git('switch', '--quiet', 'feature');
  repo.git('merge', '--quiet', '--no-ff', 'main', '-m', 'sync main');

  // base 指向推进后的 main（movedBase）：merge 引入的 archive 已在 base 树里，不得误报。
  const result = repo.runCheck('HEAD', [], movedBase);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

  const head = repo.git('rev-parse', 'HEAD');
  const candidates = scanHistory(movedBase, head, { cwd: repo.dir });
  assert.ok(candidates.some((candidate) => candidate.path === 'feature.txt'));
  const baseArchive = candidates.find((candidate) => candidate.path === 'assets/base-input.zip');
  // merge 会把 main 上的 archive 带进 feature 树，但它不是本 PR 新对象（blob 已在 base
  // 树里），isNewBlob=false，因此不会被判成「未登记二进制」。
  assert.ok(baseArchive && baseArchive.isNewBlob === false);
});

test('the files this PR introduces pass the gate (self-check)', (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));
  repo.git('switch', '--quiet', '-c', 'feature');

  // 本次门禁 PR 实际引入的文件路径：都必须通过检查，不能命中临时产物/二进制规则。
  const selfFiles = {
    '.github/git-hygiene-allowlist.json': '{\n  "version": 1,\n  "entries": []\n}\n',
    '.github/workflows/ci.yml': 'name: client-ci\n',
    'CONTRIBUTING.md': '# contributing\n',
    'CONTRIBUTING.en.md': '# contributing\n',
    'package.json': '{ "scripts": {} }\n',
    'scripts/check-git-hygiene.mjs': '// gate\n',
    'scripts/__tests__/check-git-hygiene.test.mjs': 'import test from "node:test"\n',
    'scripts/__tests__/check-git-hygiene.git-integration.test.mjs': 'import test from "node:test"\n',
  };
  for (const [name, content] of Object.entries(selfFiles)) repo.write(name, content);
  repo.commitAll('add git history hygiene gate');

  const result = repo.runCheck();
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Git history hygiene check passed/);
});
