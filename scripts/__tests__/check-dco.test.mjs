// check-dco.test.mjs — DCO 门禁的判定契约与端到端行为。
//
// 纯函数部分断言判定规则（签名解析、author 比对、merge 豁免、git log 解析）；
// 端到端部分在 os.tmpdir 里造一个真 git 仓库，跑 CLI 与 prepare-commit-msg hook——
// 格式串、范围解析、hook 里的 sh/sed 写错都只能在真 git 上暴露。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  exemptReason,
  looksLikeBotAddress,
  looksLikeEmail,
  parseGitLog,
  parseSignOffs,
  validateCommit,
  validateCommits,
} from '../check-dco.mjs';
import {
  HOOK_MARKER,
  HOOK_NAME,
  HOOK_SOURCE_PATH,
  classifyHook,
  isExecutable,
  readHookSource,
  resolveHooksDir,
  resolveHooksPathFrom,
} from '../install-dco-hook.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CHECK_DCO = path.join(ROOT, 'scripts', 'check-dco.mjs');
const INSTALL_HOOK = path.join(ROOT, 'scripts', 'install-dco-hook.mjs');

const AUTHOR = { name: 'Contributor', email: 'contributor@example.com' };

function commitFixture(overrides = {}) {
  return {
    sha: '1111111111111111111111111111111111111111',
    parents: ['0000000000000000000000000000000000000000'],
    authorName: AUTHOR.name,
    authorEmail: AUTHOR.email,
    committerName: AUTHOR.name,
    committerEmail: AUTHOR.email,
    message: 'feat: subject\n',
    ...overrides,
  };
}

test('parseSignOffs picks up every sign-off line and ignores other trailers', () => {
  const signOffs = parseSignOffs(
    [
      'fix: something',
      '',
      'Co-authored-by: Someone <someone@example.com>',
      'signed-off-by: Lower Case <lower@example.com> ',
      'Signed-off-by: Contributor <contributor@example.com>',
    ].join('\n')
  );
  // 大小写不敏感、`>` 后的尾随空白允许（App 的 `\s*$` 亦然）。
  assert.deepEqual(signOffs, [
    { name: 'Lower Case', email: 'lower@example.com' },
    { name: 'Contributor', email: 'contributor@example.com' },
  ]);
  assert.deepEqual(parseSignOffs('docs: no trailer here'), []);
  // 「提到」sign-off 不等于签署：正文里的散句不构成 trailer 行。
  assert.deepEqual(parseSignOffs('chore: mention Signed-off-by: nobody in prose'), []);
});

test('sign-off parsing stays as strict as the App on line shape', () => {
  // App 的匹配器锚在行首，缩进过的「签名」在它眼里不存在 —— 本地必须一样看不见它，
  // 否则就是本地绿、PR 红。
  assert.deepEqual(parseSignOffs(` Signed-off-by: ${AUTHOR.name} <${AUTHOR.email}>`), []);
  assert.deepEqual(parseSignOffs(`\tSigned-off-by: ${AUTHOR.name} <${AUTHOR.email}>`), []);

  // 冒号后写两个空格：App 会把多出来的空格算进 name，于是与 author 比不上。这里同样
  // 要判失败 —— 解析得到的 name 带前导空格，比对时不 trim。
  const twoSpaces = parseSignOffs(`Signed-off-by:  ${AUTHOR.name} <${AUTHOR.email}>`);
  assert.deepEqual(twoSpaces, [{ name: ` ${AUTHOR.name}`, email: AUTHOR.email }]);
  const rejected = validateCommit(
    commitFixture({ message: `feat: x\n\nSigned-off-by:  ${AUTHOR.name} <${AUTHOR.email}>\n` })
  );
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /match one of them as a whole/i);

  // name 尾部多空格同理。
  assert.equal(
    validateCommit(
      commitFixture({ message: `feat: x\n\nSigned-off-by: ${AUTHOR.name}  <${AUTHOR.email}>\n` })
    ).length,
    1
  );

  // 规范写法必须通过，别把严格做成一刀切。
  assert.deepEqual(validateCommit(commitFixture({ message: signedOff() })), []);
});

const signedOff = (subject = 'feat: x') =>
  `${subject}\n\nSigned-off-by: ${AUTHOR.name} <${AUTHOR.email}>\n`;

test('validateCommit accepts a sign-off matching author or committer', () => {
  assert.deepEqual(validateCommit(commitFixture({ message: signedOff() })), []);
  // rebase / apply 他人 patch 时 author 与 committer 不同，committer 的签名也算。
  assert.deepEqual(
    validateCommit(commitFixture({ authorEmail: 'original@example.com', message: signedOff() })),
    []
  );
  // 大小写与空白不应造成误报。
  assert.deepEqual(
    validateCommit(
      commitFixture({ message: `feat: x\n\nSigned-off-by: CONTRIBUTOR <CONTRIBUTOR@Example.com> \n` })
    ),
    []
  );
});

test('validateCommit rejects a missing or mismatched sign-off', () => {
  const missing = validateCommit(commitFixture());
  assert.equal(missing.length, 1);
  assert.match(missing[0], /No Signed-off-by trailer/);

  const mismatched = validateCommit(
    commitFixture({ message: 'feat: x\n\nSigned-off-by: Other <other@example.com>\n' })
  );
  assert.equal(mismatched.length, 1);
  assert.match(mismatched[0], /other@example\.com/);
  assert.match(mismatched[0], /Expected a sign-off from/);
});

test('validateCommit matches the DCO App on names and address shape', () => {
  // 只查 email 会比 PR 门禁宽松，导致本地绿、CI 红。
  const wrongName = validateCommit(
    commitFixture({ message: `feat: x\n\nSigned-off-by: Someone Else <${AUTHOR.email}>\n` })
  );
  assert.equal(wrongName.length, 1);
  assert.match(wrongName[0], /match one of them as a whole/i);

  const badEmail = validateCommit(
    commitFixture({
      authorEmail: 'contributor@localhost',
      committerEmail: 'contributor@localhost',
      message: 'feat: x\n\nSigned-off-by: Contributor <contributor@localhost>\n',
    })
  );
  assert.equal(badEmail.length, 1);
  assert.match(badEmail[0], /not a valid email address/);
});

test('a sign-off has to match one identity as a whole, not a mix of two', () => {
  // author=Alice<alice@>、committer=Bob<bob@> 时，`Alice <bob@…>` 谁都不是。App 把
  // name 与 email 拆成两个集合，会放过这种组合；本地刻意更严（偏严只会本地红、PR 绿）。
  const crossed = validateCommit(
    commitFixture({
      authorName: 'Alice',
      authorEmail: 'alice@example.com',
      committerName: 'Bob',
      committerEmail: 'bob@example.com',
      message: 'feat: x\n\nSigned-off-by: Alice <bob@example.com>\n',
    })
  );
  assert.equal(crossed.length, 1);
  assert.match(crossed[0], /match one of them as a whole/i);

  // 同一组身份下，author 与 committer 各自的完整签名都要接受。
  for (const signOff of ['Alice <alice@example.com>', 'Bob <bob@example.com>']) {
    assert.deepEqual(
      validateCommit(
        commitFixture({
          authorName: 'Alice',
          authorEmail: 'alice@example.com',
          committerName: 'Bob',
          committerEmail: 'bob@example.com',
          message: `feat: x\n\nSigned-off-by: ${signOff}\n`,
        })
      ),
      []
    );
  }
});

test('looksLikeEmail rejects everything validator.isEmail would reject', () => {
  for (const good of [
    'contributor@example.com',
    'first.last@sub.example.co.uk',
    'user+tag@example.io',
    "o'brien@example.com",
    'a-b@my-host.example.com',
  ]) {
    assert.equal(looksLikeEmail(good), true, `should accept ${good}`);
  }
  // 放行任何一个 App 会拒的地址就会变成「本地绿、PR 红」。
  for (const bad of [
    'alice..smith@example.com',
    '.alice@example.com',
    'alice.@example.com',
    'alice@example..com',
    'alice@exam_ple.com',
    'alice@-foo.com', // 域名 label 不能以连字符开头
    'alice@foo-.com', // 也不能以连字符结尾
    'a(b)@example.com', // 括号不在 atext 内
    'a<b>@example.com',
    'a b@example.com',
    'contributor@localhost',
    'contributor@example',
    'no-at-sign.example.com',
    '@example.com',
    'alice@',
    '',
    // 方括号同样不在 atext 内，validator 也拒。bot 地址不再被本地豁免（账号类型离线
    // 判不了），所以这类提交会在这里失败——方向安全：本地红、PR 绿，失败输出里有解释。
    '49699333+dependabot[bot]@users.noreply.github.com',
    // 长度上限（validator 同样拒）：local part > 64、单个域名 label > 63、域名 > 254。
    `${'a'.repeat(65)}@example.com`,
    `a@${'b'.repeat(64)}.com`,
    `a@${`${'b'.repeat(60)}.`.repeat(5)}com`,
    // 各段都合规、整体仍超 254：整体上限必须单独查一遍。
    `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}.com`,
  ]) {
    assert.equal(looksLikeEmail(bad), false, `should reject ${bad}`);
  }
  // 恰好在上限上要放行，别把边界一起误杀。
  assert.equal(looksLikeEmail(`${'a'.repeat(64)}@example.com`), true);
  assert.equal(looksLikeEmail(`a@${'b'.repeat(63)}.com`), true);
  const at254 = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
  assert.equal(at254.length, 254, '这个用例的意义就在于长度恰好是 254');
  assert.equal(looksLikeEmail(at254), true);
  assert.equal(looksLikeEmail(`a${at254}`), false, '255 就该拒');
});

test('only merge commits are exempt — bot status is not decidable offline', () => {
  // 父提交数量是唯一能离线可靠判定的豁免依据。
  assert.equal(exemptReason(commitFixture({ parents: ['a'.repeat(40), 'b'.repeat(40)] })), 'merge commit');
  assert.equal(exemptReason(commitFixture()), null);

  // author 邮箱同样是自由填写的：`999999+not-a-real-account[bot]@users.noreply.github.com`
  // 谁都能设，而 App 认的是 GitHub 账号类型。按邮箱豁免就是一个可伪造的后门，
  // 方向还是最坏的「本地绿、PR 红」，所以这里一律不豁免。
  for (const email of [
    '49699333+dependabot[bot]@users.noreply.github.com',
    '999999+not-a-real-account[bot]@users.noreply.github.com',
    'noreply@github.com',
  ]) {
    assert.equal(
      exemptReason(
        commitFixture({ authorEmail: email, committerEmail: email, message: 'chore: unsigned\n' })
      ),
      null,
      `${email} 不该被豁免`
    );
  }

  // 只保留「看起来像 bot 地址」这个判断，用途仅限失败输出里的解释。
  assert.ok(looksLikeBotAddress('49699333+dependabot[bot]@users.noreply.github.com'));
  assert.ok(looksLikeBotAddress('noreply@github.com'));
  assert.equal(looksLikeBotAddress('12345+contributor@users.noreply.github.com'), false);
  assert.equal(looksLikeBotAddress('human@example.com'), false);
});

test('a bot-looking unsigned commit is reported, with an explanation', () => {
  const botEmail = '49699333+dependabot[bot]@users.noreply.github.com';
  const result = validateCommits([
    commitFixture({
      authorName: 'dependabot[bot]',
      authorEmail: botEmail,
      committerName: 'dependabot[bot]',
      committerEmail: botEmail,
      message: 'chore(deps): bump something\n',
    }),
  ]);
  // 不再豁免：算进 checked 并报为失败。
  assert.equal(result.exempted.length, 0);
  assert.equal(result.checked, 1);
  assert.equal(result.failures.length, 1);
  // 这类地址不合 atext，所以先在邮箱形状上失败——App 那边则因为账号是 Bot 直接跳过，
  // 两者结论不同但方向安全（本地红、PR 绿）。
  assert.match(result.failures[0].errors[0], /not a valid email address|No Signed-off-by/);
});

test('validateCommits separates failures from exemptions', () => {
  const result = validateCommits([
    commitFixture({ sha: 'a'.repeat(40) }),
    commitFixture({ sha: 'b'.repeat(40), message: signedOff('fix: y') }),
    commitFixture({ sha: 'c'.repeat(40), parents: ['x'.repeat(40), 'y'.repeat(40)] }),
  ]);
  assert.equal(result.checked, 2);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].commit.sha, 'a'.repeat(40));
  assert.equal(result.exempted.length, 1);
});

test('parseGitLog keeps multi-line messages and parent lists intact', () => {
  const FIELD = '\u001f';
  const RECORD = '\u001e';
  const record = (fields) => fields.join(FIELD) + RECORD + '\n';
  const stdout =
    record([
      'a'.repeat(40),
      `${'p'.repeat(40)} ${'q'.repeat(40)}`,
      'Bot',
      'bot@example.com',
      'Bot',
      'bot@example.com',
      'chore: merge\n\nbody line\n',
    ]) +
    record([
      'b'.repeat(40),
      'p'.repeat(40),
      '贡献者',
      AUTHOR.email,
      '贡献者',
      AUTHOR.email,
      `feat: 中文标题\n\nSigned-off-by: 贡献者 <${AUTHOR.email}>\n`,
    ]);

  const commits = parseGitLog(stdout);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].parents.length, 2);
  assert.match(commits[0].message, /body line/);
  assert.equal(commits[1].authorName, '贡献者');
  assert.deepEqual(validateCommit(commits[1]), []);
});

test('classifyHook never marks a changed hook as safe to overwrite', () => {
  const source = readHookSource();

  // 不传 expectedContent 时按源文件判定；missing 分支不读磁盘（懒求值，见实现注释——
  // 「没读文件」这件事从外部观测需要 mock fs，不值当，这里只钉行为契约）。
  assert.equal(classifyHook(null), 'missing');
  assert.equal(classifyHook(null, 'anything'), 'missing');
  assert.equal(classifyHook(source), 'installed');
  assert.equal(classifyHook('#!/bin/sh\necho unrelated\n'), 'foreign');

  // 复合 hook 有两种来法，两者都不能被当成「可以直接覆盖」：
  // 1. 把本仓逻辑合并进自己的 hook（我们的注释在文件中间）
  const merged = ['#!/bin/sh', 'echo "my own hook"', ...source.split('\n').slice(1)].join('\n');
  // 2. 在本仓装好的 hook 后面追加自己的逻辑（开头几行仍是我们的）
  const appended = `${source}\necho custom\n`;
  for (const composite of [merged, appended]) {
    assert.ok(composite.includes(HOOK_MARKER));
    assert.equal(classifyHook(composite), 'modified');
  }

  // 旧版本 hook 与「被本人改过」在磁盘上分辨不出来，一律 modified 而非可覆盖状态。
  assert.equal(classifyHook(`${source.split('\n').slice(0, 2).join('\n')}\nold body\n`), 'modified');
});

test('legacy hooks-path fallback resolves against the caller cwd', () => {
  // git < 2.31 的回落分支。--git-path 的相对路径基准是执行 git 时的 cwd；用仓库根去解析
  // 会向上多走几级，把 hook 装进别的仓库。CI 上的 git 走不到这个分支，所以直接断言纯函数。
  assert.equal(
    resolveHooksPathFrom(path.join('..', '..', '.git', 'hooks'), '/repo/apps/desktop'),
    path.resolve('/repo/.git/hooks')
  );
  assert.equal(resolveHooksPathFrom(path.join('.git', 'hooks'), '/repo'), path.resolve('/repo/.git/hooks'));
  // 已经是绝对路径时原样返回。
  assert.equal(resolveHooksPathFrom(path.resolve('/abs/.git/hooks'), '/anywhere'), path.resolve('/abs/.git/hooks'));
});

test('the hook source is a POSIX sh script that pins its trailer behaviour', () => {
  const source = readHookSource();
  assert.match(source, /^#!\/bin\/sh\n/);
  assert.ok(source.includes(HOOK_MARKER), 'hook 必须带 marker，否则安装器无法认领它');
  // 必须签 committer：签 author 会在 --author / cherry-pick / rebase 他人 patch 时
  // 伪造别人的 DCO 声明。native `git commit -s` 同样用 committer。
  assert.match(source, /GIT_COMMITTER_IDENT/);
  assert.doesNotMatch(source, /GIT_AUTHOR_IDENT/);
  // 这两个开关的默认值可被开发者的 trailer.ifExists / trailer.ifMissing 配置改掉，
  // 配成 doNothing 时 hook 会在已有他人签名的提交上静默漏签，必须显式钉住。
  assert.match(source, /--if-exists addIfDifferent/);
  assert.match(source, /--if-missing add/);
  // 语法必须是 POSIX sh：hook 由 git 用 /bin/sh 执行，bashism 在 dash 上会直接失败。
  execFileSync('sh', ['-n', path.join(ROOT, HOOK_SOURCE_PATH)]);
});

// --- 端到端：真 git 仓库 ---

const canRunGitFixture = process.platform !== 'win32';

function createRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dco-')));
  // 隔离全局/系统 git 配置，避免宿主机的 hooksPath、gpgsign、template 影响结果。
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const run = (args, options = {}) =>
    execFileSync(args[0], args.slice(1), { cwd: dir, env, encoding: 'utf8', ...options });

  run(['git', 'init', '--quiet', '--initial-branch=main', '.']);
  run(['git', 'config', 'user.name', AUTHOR.name]);
  run(['git', 'config', 'user.email', AUTHOR.email]);
  run(['git', 'config', 'commit.gpgsign', 'false']);

  const write = (name, content) => fs.writeFileSync(path.join(dir, name), content);
  const commit = (name, message, extraArgs = []) => {
    write(name, `${name}\n`);
    run(['git', 'add', name]);
    run(['git', 'commit', '--quiet', ...extraArgs, '-m', message]);
  };
  const checkDco = (args, extraEnv = {}) => {
    try {
      const stdout = run(['node', CHECK_DCO, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env, ...extraEnv },
      });
      return { code: 0, output: stdout };
    } catch (error) {
      return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
  };
  const sha = (ref) => run(['git', 'rev-parse', ref]).trim();
  /** 写一份 pull_request 事件 payload，模拟 CI 里的 GITHUB_EVENT_PATH。 */
  const writeEvent = (baseSha, headSha) => {
    const eventPath = path.join(dir, 'event.json');
    fs.writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { base: { sha: baseSha }, head: { sha: headSha } } })
    );
    return eventPath;
  };

  return { dir, run, commit, checkDco, sha, writeEvent };
}

test('CLI fails on an unsigned commit and passes once it is signed off', { skip: !canRunGitFixture }, (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  // 历史提交故意不签名：门禁只看范围内的新 commit，不追溯历史。
  repo.commit('history.txt', 'chore: pre-DCO history');
  repo.run(['git', 'checkout', '--quiet', '-b', 'feature']);
  repo.commit('feature.txt', 'feat: unsigned work');

  const failed = repo.checkDco(['--base', 'main']);
  assert.equal(failed.code, 1);
  assert.match(failed.output, /DCO check failed/);
  assert.match(failed.output, /No Signed-off-by trailer/);
  assert.match(failed.output, /git rebase --signoff/);

  repo.run(['git', 'commit', '--quiet', '--amend', '-s', '--no-edit']);
  const passed = repo.checkDco(['--base', 'main']);
  assert.equal(passed.code, 0);
  assert.match(passed.output, /DCO check passed/);
});

test('installed hook signs off subsequent commits automatically', { skip: !canRunGitFixture }, (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  repo.commit('history.txt', 'chore: pre-DCO history');
  repo.run(['git', 'checkout', '--quiet', '-b', 'feature']);
  repo.run(['node', INSTALL_HOOK]);

  const hookPath = path.join(repo.dir, '.git', 'hooks', HOOK_NAME);
  assert.equal(classifyHook(fs.readFileSync(hookPath, 'utf8')), 'installed');

  // 注意这里没有 -s：hook 必须自己补上签名。
  repo.commit('feature.txt', 'feat: work committed without -s');
  const message = repo.run(['git', 'log', '-1', '--format=%B']);
  assert.match(message, new RegExp(`Signed-off-by: ${AUTHOR.name} <${AUTHOR.email}>`));

  // 已带签名时不重复追加。
  repo.commit('second.txt', `fix: already signed\n\nSigned-off-by: ${AUTHOR.name} <${AUTHOR.email}>`);
  const secondMessage = repo.run(['git', 'log', '-1', '--format=%B']);
  assert.equal(secondMessage.match(/Signed-off-by:/g).length, 1);

  // 开发者把 trailer.ifExists 配成 doNothing（interpret-trailers 的默认值可被覆盖）时，
  // 带着他人签名的提交仍必须补上本人签名，否则门禁会红而 hook 一声不响。
  repo.run(['git', 'config', 'trailer.ifExists', 'doNothing']);
  repo.commit('third.txt', 'fix: carries someone elses sign-off\n\nSigned-off-by: Other <other@example.com>');
  const thirdMessage = repo.run(['git', 'log', '-1', '--format=%B']);
  assert.match(thirdMessage, new RegExp(`Signed-off-by: ${AUTHOR.name} <${AUTHOR.email}>`));
  repo.run(['git', 'config', '--unset', 'trailer.ifExists']);

  assert.equal(repo.checkDco(['--base', 'main']).code, 0);
});

test('hook signs off the committer, never the overridden author', { skip: !canRunGitFixture }, (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  repo.commit('history.txt', 'chore: pre-DCO history');
  repo.run(['git', 'checkout', '--quiet', '-b', 'feature']);
  repo.run(['node', INSTALL_HOOK]);

  // 用 --author 假冒他人：hook 绝不能替 Alice 签名，那是伪造她的 DCO 声明。
  fs.writeFileSync(path.join(repo.dir, 'feature.txt'), 'feature\n');
  repo.run(['git', 'add', 'feature.txt']);
  repo.run([
    'git',
    'commit',
    '--quiet',
    '--author=Alice <alice@example.com>',
    '-m',
    'feat: committed on behalf of Alice',
  ]);

  const message = repo.run(['git', 'log', '-1', '--format=%B']);
  assert.match(message, new RegExp(`Signed-off-by: ${AUTHOR.name} <${AUTHOR.email}>`));
  assert.doesNotMatch(message, /Signed-off-by: Alice/);

  // 与原生 `git commit -s` 的结果一致。
  fs.writeFileSync(path.join(repo.dir, 'native.txt'), 'native\n');
  repo.run(['git', 'add', 'native.txt']);
  repo.run(['git', 'commit', '--quiet', '-s', '--author=Alice <alice@example.com>', '-m', 'feat: native -s']);
  assert.match(
    repo.run(['git', 'log', '-1', '--format=%B']),
    new RegExp(`Signed-off-by: ${AUTHOR.name} <${AUTHOR.email}>`)
  );

  // committer 的签名同样满足门禁（App 与本脚本都接受 author 或 committer）。
  assert.equal(repo.checkDco(['--base', 'main']).code, 0);
});

test('installer refuses to clobber an edited hook without --force', { skip: !canRunGitFixture }, (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  repo.commit('history.txt', 'chore: pre-DCO history');
  repo.run(['node', INSTALL_HOOK]);
  const hookPath = path.join(repo.dir, '.git', 'hooks', HOOK_NAME);
  assert.equal(fs.readFileSync(hookPath, 'utf8'), readHookSource());

  // resolveHooksDir 必须给出绝对路径，且从子目录调用时也要落在本仓库的 hooks 目录。
  // 回落分支（旧版 git）解析相对路径的基准必须是调用时的 cwd：拿仓库根去解析会向上多走
  // 几级，写进隔壁仓库的 .git/hooks。
  const expectedHooksDir = path.join(repo.dir, '.git', 'hooks');
  assert.equal(resolveHooksDir(repo.dir), expectedHooksDir);
  const subDir = path.join(repo.dir, 'nested', 'deeper');
  fs.mkdirSync(subDir, { recursive: true });
  assert.equal(resolveHooksDir(subDir), expectedHooksDir);

  // 装完之后开发者又追加了自己的逻辑。
  const edited = `${readHookSource()}\necho "my own extra step"\n`;
  fs.writeFileSync(hookPath, edited);

  let refused;
  try {
    repo.run(['node', INSTALL_HOOK], { stdio: ['ignore', 'pipe', 'pipe'] });
    refused = null;
  } catch (error) {
    refused = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  assert.ok(refused, '没有 --force 时必须失败退出');
  assert.match(refused, /Not overwriting it/);
  assert.equal(fs.readFileSync(hookPath, 'utf8'), edited, '拒绝时绝不能改动文件');

  // 显式 --force 才覆盖。
  repo.run(['node', INSTALL_HOOK, '--force']);
  assert.equal(fs.readFileSync(hookPath, 'utf8'), readHookSource());
});

test('installer restores a lost executable bit', { skip: !canRunGitFixture }, (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  repo.commit('history.txt', 'chore: pre-DCO history');
  repo.run(['git', 'checkout', '--quiet', '-b', 'feature']);
  repo.run(['node', INSTALL_HOOK]);
  const hookPath = path.join(repo.dir, '.git', 'hooks', HOOK_NAME);

  // 内容逐字一致但不可执行（手动复制、备份恢复、chmod 0644）：git 会静默忽略这个 hook，
  // 提交照样不带签名，而只看内容的安装器会报「已是最新」把人骗过去。
  fs.chmodSync(hookPath, 0o644);
  assert.equal(isExecutable(hookPath), false);
  assert.equal(classifyHook(fs.readFileSync(hookPath, 'utf8')), 'installed');

  // --check 要点出这个状态，而不是笼统报 installed。
  assert.match(repo.run(['node', INSTALL_HOOK, '--check']), /NOT executable/);

  const output = repo.run(['node', INSTALL_HOOK]);
  assert.match(output, /Restored the executable bit/);
  assert.equal(isExecutable(hookPath), true);

  // 修好之后 hook 真的生效（没有 -s 也自动补签）。
  repo.commit('feature.txt', 'feat: work committed without -s');
  assert.match(
    repo.run(['git', 'log', '-1', '--format=%B']),
    new RegExp(`Signed-off-by: ${AUTHOR.name} <${AUTHOR.email}>`)
  );
  assert.equal(repo.checkDco(['--base', 'main']).code, 0);
});

test('hook keeps the native `commit -s` layout for interactive commits', { skip: !canRunGitFixture }, (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  repo.commit('history.txt', 'chore: pre-DCO history');
  repo.run(['git', 'checkout', '--quiet', '-b', 'feature']);
  repo.run(['node', INSTALL_HOOK]);

  // 模拟交互式提交：编辑器把标题写到消息首行，此时 hook 早已跑过。
  const editor = path.join(repo.dir, 'editor.sh');
  fs.writeFileSync(
    editor,
    ['#!/bin/sh', 'printf "feat: interactive title\\n" > "$1.tmp"', 'cat "$1" >> "$1.tmp"', 'mv "$1.tmp" "$1"', ''].join('\n')
  );
  fs.chmodSync(editor, 0o755);

  fs.writeFileSync(path.join(repo.dir, 'feature.txt'), 'feature\n');
  repo.run(['git', 'add', 'feature.txt']);
  repo.run(['git', 'commit', '--quiet'], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_EDITOR: editor } });

  // 标题与签名之间必须有空行——这正是 `git commit -s` 的模板格式。
  assert.equal(
    repo.run(['git', 'log', '-1', '--format=%B']).trim(),
    `feat: interactive title\n\nSigned-off-by: ${AUTHOR.name} <${AUTHOR.email}>`
  );
  assert.equal(repo.run(['git', 'log', '-1', '--format=%s']).trim(), 'feat: interactive title');
  assert.equal(repo.checkDco(['--base', 'main']).code, 0);
});

test('CLI takes its range from the pull_request payload in CI', { skip: !canRunGitFixture }, (t) => {
  const repo = createRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  repo.commit('history.txt', 'chore: pre-DCO history');
  const prBase = repo.sha('HEAD');
  repo.run(['git', 'checkout', '--quiet', '-b', 'feature']);
  repo.commit('feature.txt', 'feat: signed work', ['-s']);
  const prHead = repo.sha('HEAD');

  const fromPayload = repo.checkDco([], {
    GITHUB_EVENT_PATH: repo.writeEvent(prBase, prHead),
  });
  assert.equal(fromPayload.code, 0);
  assert.match(fromPayload.output, /DCO check passed: 1 commit signed off/);

  // base 分支在 PR 开着期间前进，且新提交没有签名：merge-base 必须把它排除在范围外，
  // 否则每个 PR 都会因为别人推到 main 的提交无端变红。
  repo.run(['git', 'checkout', '--quiet', 'main']);
  repo.commit('other.txt', 'chore: unsigned commit pushed to main by someone else');
  const movedBase = repo.sha('HEAD');
  repo.run(['git', 'checkout', '--quiet', 'feature']);

  const afterBaseMoved = repo.checkDco([], {
    GITHUB_EVENT_PATH: repo.writeEvent(movedBase, prHead),
  });
  assert.equal(afterBaseMoved.code, 0);
  assert.match(afterBaseMoved.output, /DCO check passed: 1 commit signed off/);
});
