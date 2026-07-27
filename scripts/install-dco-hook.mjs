#!/usr/bin/env node
// 本地 DCO 签名 hook 安装器：把仓库里的 .githooks/prepare-commit-msg 复制进当前仓库的
// hooks 目录，让此后每次 `git commit`（含 agent 自动提交）都自动追加 Signed-off-by
// trailer——签的是 commit 的 committer，与原生 `git commit -s` 一致。这样可以避免 PR 被
// DCO check（DCO GitHub App，配置见 .github/dco.yml）拦下后返工；本地提交前的自查是
// scripts/check-dco.mjs，PR 上的权威结论则以 App 的 check 为准。
//
// 用法：
//   pnpm dco:install-hook                      安装 hook（已存在且被改过时会拒绝，见下）
//   node scripts/install-dco-hook.mjs --check  只报告状态，不写文件
//   node scripts/install-dco-hook.mjs --force  覆盖一份源自本仓但已被改动的 hook
//
// hook 的正本是 .githooks/prepare-commit-msg（普通 shell 脚本，可直接 review 与
// shellcheck）；本脚本只负责复制、判断能否安全覆盖，不生成脚本内容。想跳过安装器的
// 开发者可以直接 `git config core.hooksPath .githooks`——但那会接管整个 hooks 目录，
// 所以默认走复制，与开发者已有的其他 hook 共存。
//
// hook 是纯本地便利设施：不改远端、不改 core.hooksPath，删掉已安装的文件即卸载。

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 用于识别「这个 hook 是本仓装的」，据此判断可否安全覆盖。与 hook 源文件里的注释一致。 */
export const HOOK_MARKER = 'cindy-dco-signoff-hook';
export const HOOK_NAME = 'prepare-commit-msg';
export const HOOK_SOURCE_PATH = join('.githooks', HOOK_NAME);

/** hook 内容的单一事实源。 */
export function readHookSource() {
  return readFileSync(join(REPO_ROOT, HOOK_SOURCE_PATH), 'utf8');
}

/**
 * 把 `git rev-parse --git-path hooks` 的返回值化成绝对路径。
 *
 * 关键点：它给的相对路径是相对于**执行 git 时的 cwd**，不是仓库根。从子目录调用时返回的
 * 是形如 `../../.git/hooks` 的路径，若拿仓库根去解析就会向上多走几级，把 hook 写进隔壁
 * 或上层仓库的 .git/hooks——所以基准必须是同一个 cwd。单独抽出来是为了能直接断言这点：
 * 走到这个分支需要 git < 2.31，CI 上跑不到。
 */
export function resolveHooksPathFrom(hooksPath, cwd) {
  return isAbsolute(hooksPath) ? hooksPath : resolve(cwd, hooksPath);
}

/**
 * hooks 目录：走 `git rev-parse --git-path hooks`，因此自动尊重已设置的 core.hooksPath；
 * 多 worktree 共享 common dir，装一次全部 worktree 生效。--path-format 要 git 2.31+，
 * 旧版回落到 resolveHooksPathFrom。
 */
export function resolveHooksDir(cwd = process.cwd()) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    return git(['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  } catch {
    // --path-format 要 git 2.31+，旧版回落到这里。
    return resolveHooksPathFrom(git(['rev-parse', '--git-path', 'hooks']), cwd);
  }
}

/**
 * 返回 `missing`（没有）/ `installed`（内容与源文件逐字一致）/ `modified`（认得出源自本仓，
 * 但内容已经不同）/ `foreign`（完全不是本仓的东西）。
 *
 * 只有 `installed` 与 `missing` 允许无条件写入。刻意不去区分「本仓装的旧版本」与「装完
 * 之后被人改过」——这两者在磁盘上无法可靠分辨：无论是把本仓逻辑合并进自己的 hook，还是
 * 在本仓装好的 hook 后面追加几行，得到的都是「像本仓的、但不等于源文件」。任何试图靠开头
 * 几行或 marker 位置来认领它们的判定，都会在某一种组合上误判并整份覆盖，抹掉开发者的
 * 逻辑。所以这里一律要求显式 --force 才覆盖。
 */
export function classifyHook(existingContent, expectedContent) {
  // 先判 missing 再取源文件：默认参数会在调用时就求值，那样 `classifyHook(null)` 也要读一次
  // 磁盘，还把「没装 hook」这个判断绑到源文件可读上。
  if (existingContent === null) return 'missing';
  const expected = expectedContent ?? readHookSource();
  if (existingContent === expected) return 'installed';
  return existingContent.includes(HOOK_MARKER) ? 'modified' : 'foreign';
}

export function readHook(hookPath) {
  try {
    return readFileSync(hookPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** git 只执行带 owner 执行位的 hook；缺了它内容再对也不会生效。 */
export function isExecutable(hookPath) {
  try {
    return (statSync(hookPath).mode & 0o100) !== 0;
  } catch {
    return false;
  }
}

/** 供 check-dco.mjs 在本地校验通过后决定是否提示安装。探测失败一律当「已装」处理，不打扰。 */
export function isSignOffHookInstalled(cwd = process.cwd()) {
  try {
    const hookPath = join(resolveHooksDir(cwd), HOOK_NAME);
    return classifyHook(readHook(hookPath)) !== 'missing';
  } catch {
    return true;
  }
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const force = process.argv.includes('--force');
  const hooksDir = resolveHooksDir();
  const hookPath = join(hooksDir, HOOK_NAME);
  const source = readHookSource();
  const state = classifyHook(readHook(hookPath), source);

  // --check 只报告，不写文件、不因状态失败：调用方要的是事实，不是门禁。
  if (checkOnly) {
    const executableNote =
      state === 'installed' && !isExecutable(hookPath) ? ', but NOT executable — Git will ignore it' : '';
    const label = {
      installed: `installed, matching ${HOOK_SOURCE_PATH}${executableNote}`,
      modified: "present but differs from this repo's version (older, or edited locally)",
      missing: 'not installed',
      foreign: 'a different prepare-commit-msg hook is present; not taken over',
    }[state];
    console.log(`DCO sign-off hook: ${label} (${hookPath})`);
    return;
  }

  if (state === 'installed') {
    // 内容一致但丢了可执行位（手动复制、备份恢复、chmod 0644 都会这样）时 git 会直接
    // 忽略这个 hook，提交照样不带签名——而安装器如果只看内容就会报「已是最新」，把人骗过去。
    if (!isExecutable(hookPath)) {
      chmodSync(hookPath, 0o755);
      console.log(`Restored the executable bit on ${hookPath}`);
      console.log('(Git silently ignores hooks that are not executable, so commits were unsigned.)');
      return;
    }
    console.log(`DCO sign-off hook already up to date: ${hookPath}`);
    return;
  }

  if (state === 'foreign') {
    console.error(`A ${HOOK_NAME} hook not managed by this repository already exists:`);
    console.error(`  ${hookPath}`);
    console.error(`Leaving it untouched. Either merge the logic from ${HOOK_SOURCE_PATH} into it`);
    console.error('— this installer will then keep its hands off that file, so you own keeping the');
    console.error('merged copy in sync — or use `git config core.hooksPath .githooks` instead.');
    process.exit(1);
  }

  // modified：可能是本仓的旧版本，也可能是装完之后你自己加过东西。磁盘上分辨不出来，
  // 所以不猜，要求显式 --force——猜错的代价是删掉别人的 hook 逻辑。
  if (state === 'modified' && !force) {
    console.error(`${hookPath} came from this repository but no longer matches ${HOOK_SOURCE_PATH}.`);
    console.error('It is either an older version of the hook, or a copy you have edited since.');
    console.error('Not overwriting it. Compare first, then decide:');
    // 用 git diff 而不是 diff(1)：git 本来就是本仓的前置依赖，而 diff 在部分 Windows
    // 环境里没有。
    console.error(`  git diff --no-index ${hookPath} ${join(REPO_ROOT, HOOK_SOURCE_PATH)}`);
    console.error('  node scripts/install-dco-hook.mjs --force   # overwrite with this repo\'s version');
    process.exit(1);
  }

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hookPath, source, 'utf8');
  chmodSync(hookPath, 0o755);
  console.log(`${state === 'modified' ? 'Overwrote' : 'Installed'} DCO sign-off hook: ${hookPath}`);
  console.log(
    `Copied from ${HOOK_SOURCE_PATH}. git commit will now append Signed-off-by; ` +
      'delete the installed file to uninstall.'
  );
}

// 仅作为入口执行时运行；被 import 时只导出纯函数与探测函数。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
}
