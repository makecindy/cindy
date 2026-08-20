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
  // merge 把 main 上的 archive 带进 feature 树，但它是从 main parent 继承的既有文件，
  // 不算本 PR 新引入，根本不该进入候选。
  const baseArchive = candidates.find((candidate) => candidate.path === 'assets/base-input.zip');
  assert.ok(!baseArchive, 'merge 带入的 base 已有 archive 不应被算作新引入候选');
});

test('merging a base ancestor that carried a temporary file does not false positive', (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  // main 历史：引入 tmp/legacy.json 后删除（base tip 上已没有该文件）。
  repo.write('tmp/legacy.json', '{"temporary":true}\n');
  const introduced = repo.commitAll('main introduces temporary file');
  fs.rmSync(path.join(repo.dir, 'tmp'), { recursive: true, force: true });
  const movedBase = repo.commitAll('main deletes temporary file');

  // feature 从初始 base 分叉，然后 merge 了「仍含 tmp 的 main 历史点」，把该文件带进
  // 自己的历史（blob 已在 main 可达历史里，feature 只是继承，没有新写），随后再删除它。
  // 最终树不含 tmp，不应误报。
  repo.git('switch', '--quiet', '-c', 'feature', repo.base);
  repo.write('feature.txt', 'feature\n');
  repo.commitAll('feature work');
  repo.git('merge', '--quiet', '--no-ff', introduced, '-m', 'merge main (still had tmp)');
  fs.rmSync(path.join(repo.dir, 'tmp'), { recursive: true, force: true });
  repo.commitAll('drop inherited tmp');

  // base 指向删除后的 main tip：tmp/legacy.json 只在历史里短暂继承、最终树已删除，门禁
  // 应通过而非误报。
  const result = repo.runCheck('HEAD', [], movedBase);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

  const head = repo.git('rev-parse', 'HEAD');
  const candidates = scanHistory(movedBase, head, { cwd: repo.dir });
  assert.ok(candidates.some((candidate) => candidate.path === 'feature.txt'));
  assert.ok(
    !candidates.some((candidate) => candidate.path === 'tmp/legacy.json'),
    'merge 短暂继承后删除的临时文件不应被算作新引入'
  );
});

test('merging a base ancestor that carried a temporary file and leaving it in the final tree fails', (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  // main 历史：引入 tmp/legacy.json 后删除。
  repo.write('tmp/legacy.json', '{"temporary":true}\n');
  const introduced = repo.commitAll('main introduces temporary file');
  fs.rmSync(path.join(repo.dir, 'tmp'), { recursive: true, force: true });
  const movedBase = repo.commitAll('main deletes temporary file');

  // feature merge 含 tmp 的历史点，但**不再删除**：HEAD 最终树仍含 tmp/legacy.json，
  // 相对当前 base（已删除）会把这个禁止临时产物重新带回 main——必须失败。
  repo.git('switch', '--quiet', '-c', 'feature', repo.base);
  repo.write('feature.txt', 'feature\n');
  repo.commitAll('feature work');
  repo.git('merge', '--quiet', '--no-ff', introduced, '-m', 'merge main (still had tmp)');

  const result = repo.runCheck('HEAD', [], movedBase);
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /tmp\/legacy\.json/);
});

test('merge resolving an existing path into a new unregistered binary fails', (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  // base 已有一个小 assets/tool.zip；这是「既有路径」，merge 把它解析成第三个 blob 时
  // 必须被未登记二进制规则拦住，不能被 merge 交集逻辑丢掉。
  repo.write('assets/tool.zip', 'base small\n');
  const movedBase = repo.commitAll('base adds archive');

  // 两个分支改不同文件，merge 不冲突；随后手动把 tool.zip 覆盖成新 blob（merge 自造）。
  repo.git('switch', '--quiet', '-c', 'feature', movedBase);
  repo.write('feature.txt', 'feature\n');
  repo.commitAll('feature work');

  repo.git('switch', '--quiet', '-c', 'side', movedBase);
  repo.write('side.txt', 'side\n');
  repo.commitAll('side work');

  repo.git('switch', '--quiet', 'feature');
  repo.git('merge', '--quiet', '--no-ff', '--no-commit', 'side');
  repo.write('assets/tool.zip', 'merge-generated unregistered archive\n');
  repo.git('add', '--all');
  repo.git('commit', '--quiet', '-m', 'merge resolves archive to new blob');

  const result = repo.runCheck('HEAD', [], movedBase);
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /assets\/tool\.zip/);
  assert.match(`${result.stdout}${result.stderr}`, /unregistered binary\/archive/);
});

test('merge tree identical to a history-tmp parent does not false positive', (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  // main 历史：引入 tmp/legacy.json 后删除。
  repo.write('tmp/legacy.json', '{"temporary":true}\n');
  const withTmp = repo.commitAll('main introduces temporary file');
  fs.rmSync(path.join(repo.dir, 'tmp'), { recursive: true, force: true });
  const movedBase = repo.commitAll('main deletes temporary file');

  // feature 从初始 base 分叉，merge 含 tmp 的历史点时，其 merge tree 恰好等于含 tmp 的
  // parent（没有 feature 自己的文件改动）——相对另一个 parent 的 diff 为空，Git 会省略
  // 该空段。若只按 -m 输出段数判断，会把 merge 误当普通 commit 而误报；按真实 parentCount
  // 判断应通过。随后删除 tmp，使最终树不含禁止路径（最终树检查也不误报）。
  repo.git('switch', '--quiet', '-c', 'feature', repo.base);
  repo.git('merge', '--quiet', '--no-ff', withTmp, '-m', 'merge main history point verbatim');
  fs.rmSync(path.join(repo.dir, 'tmp'), { recursive: true, force: true });
  repo.commitAll('drop inherited tmp');

  const result = repo.runCheck('HEAD', [], movedBase);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('deleting a path named like a header does not desync the parser', (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  // base 里放一个「__C__...」开头的文件（文件名长得像 %H %P header），feature 同一
  // commit 删除它并新增 tmp 产物。删除记录若在消费 path 前就 continue，path 会被下一轮
  // 误读成 header，伪 commit 被算成 merge，tmp 候选被丢掉，门禁错误 exit 0。
  repo.write('__C__deadbeef cafebabecafebabecafebabecafebabecafebabe', 'x\n');
  repo.commitAll('base adds header-like file');

  repo.git('switch', '--quiet', '-c', 'feature');
  fs.rmSync(path.join(repo.dir, '__C__deadbeef cafebabecafebabecafebabecafebabecafebabe'));
  repo.write('tmp/artifact.json', '{"temporary":true}\n');
  repo.commitAll('delete header-like file and add tmp artifact');

  const result = repo.runCheck();
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /tmp\/artifact\.json/);
});

test('mode-only change on a merged history-tmp path does not false positive in history scan', (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  // main 历史：引入 tmp/legacy.sh 后删除。
  repo.write('tmp/legacy.sh', 'echo hi\n');
  const withTmp = repo.commitAll('main introduces temporary script');
  fs.rmSync(path.join(repo.dir, 'tmp'), { recursive: true, force: true });
  const movedBase = repo.commitAll('main deletes temporary script');

  // feature merge 含该文件的旧 base commit，并在 merge 中仅 chmod +x（mode-only 变化，
  // 相对含文件 parent 是 oldsha==newsha 的 M，相对无文件 parent 是 A）。这不引入新
  // path/blob，只是继承 + 改 mode，历史扫描不应把它算作新引入的临时路径。
  repo.git('switch', '--quiet', '-c', 'feature', repo.base);
  repo.git('merge', '--quiet', '--no-ff', '--no-commit', withTmp);
  repo.git('update-index', '--chmod=+x', 'tmp/legacy.sh');
  repo.git('commit', '--quiet', '-m', 'merge history tmp and chmod');

  // 用 scanHistory 直接断言 parser 层：mode-only merge 不应产生 tmp/legacy.sh 历史候选。
  const head = repo.git('rev-parse', 'HEAD');
  const candidates = scanHistory(movedBase, head, { cwd: repo.dir });
  assert.ok(
    !candidates.some((candidate) => candidate.path === 'tmp/legacy.sh'),
    'mode-only 继承不应被算作新引入的临时路径'
  );
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
