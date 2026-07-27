#!/usr/bin/env node
// DCO（Developer Certificate of Origin）门禁：校验一段 commit 范围里每个非豁免 commit
// 都带有与其 author（或 committer）一致的 Signed-off-by trailer。DCO 全文见仓库根
// 的 DCO 文件，贡献者侧说明见 CONTRIBUTING.md「贡献的许可与署名（DCO）」。
//
// 只检查 PR 引入的新 commit（merge-base..head），不追溯仓库历史，因此对 DCO 生效前
// 的既有提交无影响。只读 git 元数据，不访问网络、不读任何私有配置或凭证。
//
// PR 上的权威门禁是 DCO GitHub App 的 check（配置见 .github/dco.yml），本脚本是提交前
// 的本地自查，判定刻意与 App 对齐或更严，好让本地通过一定意味着 App 通过。
//
// 本地用法：
//   pnpm check:dco                                  校验 origin/main..HEAD
//   node scripts/check-dco.mjs --base <ref> --head <ref>
// 在 pull_request 事件下运行时（GITHUB_EVENT_PATH 存在）自动从 payload 取
// base.sha 与 head.sha 作为范围。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { isSignOffHookInstalled } from './install-dco-hook.mjs';

// git log 的字段/记录分隔符：用 ASCII 控制字符，避免与 commit message 内容碰撞。
const FIELD_SEP = '\u001f';
const RECORD_SEP = '\u001e';
const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%cn', '%ce', '%B'].join(FIELD_SEP) + RECORD_SEP;

// 与 DCO App 的匹配器逐字对齐（dcoapp/app 的 `lib/dco.js`：
// `/^Signed-off-by: (.*) <(.*)>\s*$/gim`）。逐行匹配而不强求在 message 末尾：trailer
// 之后常见还有 Co-authored-by 等其他 trailer。
//
// 刻意不放宽这三处，它们都会造成「本地绿、PR 红」：
// - 不允许行首空白：App 的 `^Signed-off-by:` 锚在行首，缩进过的行在它眼里根本不是签名。
// - `Signed-off-by:` 后只允许一个空格：写两个空格时 App 会把多出来的空格算进 name，
//   于是 name 与 author 比不上。
// - 捕获值不 trim（见 validateCommit）：App 拿原样捕获去比，`Alice ` 不等于 `Alice`。
const SIGN_OFF_LINE = /^Signed-off-by: (.*) <(.*)>\s*$/i;

// bot 地址的形状特征：dependabot 等用 `<name>[bot]@users.noreply.github.com`，
// GitHub Web UI 用 web-flow 的 noreply@github.com。
//
// **这只用于在失败输出里提示，不用于豁免。** App 判定 bot 的依据是 GitHub 账号类型
// （`author.type === "Bot"`），离线拿不到也伪造不了；而 author 邮箱谁都能设成
// `999999+not-a-real-account[bot]@users.noreply.github.com`。按邮箱豁免就等于给本地检查
// 留一个可伪造的后门，方向还是最坏的那种——「本地绿、PR 红」。所以本地一律检查，
// 只在输出里说明「若它真是 bot，PR 上的 App 会豁免」。
const BOT_EMAILS = new Set(['noreply@github.com']);
const BOT_EMAIL_SUFFIX = '[bot]@users.noreply.github.com';

// 本地默认基准。upstream/main 排在前面：从 fork 干活时 origin/main 可能领先于上游，
// 拿它当基准会把 fork 自己那些未签名的提交排除在范围外，而 PR 的真实 base 是上游。
// 这只是本地自查的启发式——真实 base 以 PR 上的 DCO check 为准，所以通过时会把实际用的
// 基准打印出来。
const DEFAULT_BASE_CANDIDATES = ['upstream/main', 'origin/main', 'main'];

const git = (args, options = {}) =>
  execFileSync('git', args, { encoding: 'utf8', ...options }).trim();

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function normalizeName(name) {
  return String(name ?? '').trim().toLowerCase();
}

// 邮箱形状：对齐 DCO App 用的 validator.isEmail 的默认规则。
// - local part 限定为 RFC 5322 的 atext 字符集，点分隔且不允许连续点或首尾点。
//   注意 atext 不含括号、方括号、引号等，所以 `a(b)@x.com` 会被拒——validator 也拒。
// - 域名每个 label 不能以连字符开头或结尾，不允许下划线，且必须有字母 TLD（于是 git 未配
//   user.email 时自动生成的 `user@hostname` 会被拒）。
// 无法逐条复刻 validator，取舍上刻意偏严：宁可本地误报，也不要放行一个 App 会拒的地址，
// 那才会变成「本地绿、PR 红」。含方括号的 bot 邮箱（dependabot 等）同样不符合 atext，
// 于是这类提交在本地会被报出来——而 App 因为账号是 Bot 直接跳过。结论不同但方向安全
// （本地红、PR 绿），失败输出里会说明这一点。
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]";
const DOMAIN_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const EMAIL_LOCAL_PART = new RegExp(`^${ATEXT}+(?:\\.${ATEXT}+)*$`);
const EMAIL_DOMAIN = new RegExp(`^${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*\\.[A-Za-z]{2,}$`);
// validator.isEmail 的长度上限，超出即拒。整体上限单独存在：local part 与 domain 各自
// 合规、加起来仍可能超过 254。
const MAX_TOTAL = 254;
const MAX_LOCAL_PART = 64;
const MAX_DOMAIN = 254;
const MAX_DOMAIN_LABEL = 63;

export function looksLikeEmail(email) {
  const value = String(email ?? '').trim();
  if (value.length > MAX_TOTAL) return false;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return false;

  const localPart = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (localPart.length > MAX_LOCAL_PART || domain.length > MAX_DOMAIN) return false;
  if (domain.split('.').some((label) => label.length > MAX_DOMAIN_LABEL)) return false;

  return EMAIL_LOCAL_PART.test(localPart) && EMAIL_DOMAIN.test(domain);
}

/**
 * 提取 message 里所有 Signed-off-by 行。捕获值原样保留、不 trim——App 也不 trim，
 * 多出来的空白会让它与 author 比对失败，这里跟着一起失败才不会「本地绿、PR 红」。
 */
export function parseSignOffs(message) {
  const signOffs = [];
  for (const line of String(message ?? '').split(/\r?\n/)) {
    const match = SIGN_OFF_LINE.exec(line);
    if (match) signOffs.push({ name: match[1], email: match[2] });
  }
  return signOffs;
}

/** 只判断「地址长得像 bot」，供失败输出提示用；不构成豁免，理由见上面的注释。 */
export function looksLikeBotAddress(email) {
  const normalizedEmail = normalizeEmail(email);
  return BOT_EMAILS.has(normalizedEmail) || normalizedEmail.endsWith(BOT_EMAIL_SUFFIX);
}

/**
 * 返回豁免原因，不豁免则返回 null。
 *
 * 只有 merge commit 能离线可靠判定（父提交数量），所以只豁免它。bot 提交交给 App 按账号
 * 类型豁免——本地宁可多报一条，也不放过一个可伪造的身份。
 */
export function exemptReason(commit) {
  if (commit.parents.length > 1) return 'merge commit';
  return null;
}

/**
 * 返回错误列表；空列表即通过。判定与 DCO App（dcoapp/app 的 lib/dco.js）对齐，两处
 * 刻意更严——偏严只会「本地红、PR 绿」，偏宽才会「本地绿、PR 红」，后者才是要避免的：
 *
 * 1. 签名必须整体匹配 author 或 committer 这一个身份。App 是把 name 与 email 拆成两个
 *    集合分别判断，于是 author=Alice<a@x>、committer=Bob<b@x> 时 `Alice <b@x>` 也能过，
 *    尽管这个身份并不存在——这里按 name+email 成对比较。
 * 2. 邮箱形状见 looksLikeEmail。
 *
 * 本脚本同样不识别 remediation commit（App 侧由 .github/dco.yml 开启），也是同一取舍。
 * 面向贡献者的文案统一用英文。
 */
export function validateCommit(commit) {
  const signOffs = parseSignOffs(commit.message);
  if (signOffs.length === 0) {
    return ['No Signed-off-by trailer.'];
  }

  // 与 App 一致：只看 author.email（缺失时回落 committer.email）。改成「两者都非法才
  // 失败」会比 App 宽松，反而制造本地绿、PR 红。
  const email = commit.authorEmail || commit.committerEmail;
  if (!looksLikeEmail(email)) {
    return [`${email} is not a valid email address.`];
  }

  const identities = [
    { name: normalizeName(commit.authorName), email: normalizeEmail(commit.authorEmail) },
    { name: normalizeName(commit.committerName), email: normalizeEmail(commit.committerEmail) },
  ];
  // 签名侧只 lowercase、不 trim（App 亦然）；commit 侧 trim 是安全的，git ident 本身
  // 不带前后空白。两边处理方式刻意不同，正是为了让「Alice 」这种写法在本地也失败。
  const matches = (signOff) =>
    identities.some(
      (identity) =>
        identity.name === String(signOff.name).toLowerCase() &&
        identity.email === String(signOff.email).toLowerCase()
    );
  if (signOffs.some(matches)) return [];

  const got = signOffs.map((signOff) => `"${signOff.name} <${signOff.email}>"`).join(', ');
  return [
    `Expected a sign-off from "${commit.authorName} <${commit.authorEmail}>" or ` +
      `"${commit.committerName} <${commit.committerEmail}>", got ${got}. ` +
      'The name and the address have to match one of them as a whole.',
  ];
}

export function validateCommits(commits) {
  const failures = [];
  const exempted = [];
  let checked = 0;

  for (const commit of commits) {
    const reason = exemptReason(commit);
    if (reason) {
      exempted.push({ commit, reason });
      continue;
    }
    checked += 1;
    const errors = validateCommit(commit);
    if (errors.length > 0) failures.push({ commit, errors });
  }

  return { failures, exempted, checked };
}

export function parseGitLog(stdout) {
  return String(stdout)
    .split(RECORD_SEP)
    .map((record) => record.replace(/^\r?\n/, ''))
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [sha, parents, authorName, authorEmail, committerName, committerEmail, message] =
        record.split(FIELD_SEP);
      return {
        sha: (sha ?? '').trim(),
        parents: (parents ?? '').trim() ? parents.trim().split(/\s+/) : [],
        authorName: authorName ?? '',
        authorEmail: authorEmail ?? '',
        committerName: committerName ?? '',
        committerEmail: committerEmail ?? '',
        message: message ?? '',
      };
    });
}

export function shortSha(sha) {
  return String(sha ?? '').slice(0, 8);
}

export function subjectOf(commit) {
  return String(commit.message ?? '').split(/\r?\n/, 1)[0].trim();
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

function revParse(ref) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** 解析待校验范围。返回的 start 是排除端点（start..head）。 */
function resolveRange() {
  const explicitBase = readArg('--base');
  const explicitHead = readArg('--head');
  const eventPath = process.env.GITHUB_EVENT_PATH;

  let base = explicitBase;
  let head = explicitHead ?? 'HEAD';

  if (!base && eventPath) {
    const event = JSON.parse(readFileSync(eventPath, 'utf8'));
    const pr = event.pull_request;
    if (!pr) throw new Error('Event payload has no pull_request; check the workflow trigger.');
    base = pr.base?.sha;
    head = explicitHead ?? pr.head?.sha ?? 'HEAD';
    if (!base) throw new Error('Event payload is missing pull_request.base.sha.');
  }

  if (!base) {
    base = DEFAULT_BASE_CANDIDATES.find((candidate) => revParse(candidate));
    if (!base) {
      throw new Error(
        `No default base ref found (${DEFAULT_BASE_CANDIDATES.join(' / ')}); pass --base <ref>.`
      );
    }
  }

  const baseSha = revParse(base);
  if (!baseSha) throw new Error(`Cannot resolve base ref: ${base} (fetch it first if missing).`);
  const headSha = revParse(head);
  if (!headSha) throw new Error(`Cannot resolve head ref: ${head}.`);

  // 用 merge-base 而不是 base 本身：base 分支在 PR 开着期间会前进，直接用
  // base.sha..head 会把 base 侧的他人提交也算进来，造成误报。
  let start = baseSha;
  try {
    start = git(['merge-base', baseSha, headSha]);
  } catch {
    // 没有共同祖先（例如孤立分支）时退回 base 本身。
  }

  return { start, head: headSha, baseRef: base };
}

function reportFailures({ failures, start }) {
  const plural = failures.length === 1 ? 'commit' : 'commits';
  console.error(`DCO check failed: ${failures.length} ${plural} without a valid Signed-off-by.\n`);
  for (const { commit, errors } of failures) {
    console.error(`- ${shortSha(commit.sha)} ${subjectOf(commit)}`);
    for (const error of errors) console.error(`  ${error}`);
    // 地址像 bot 时给一句解释，免得有人以为门禁在为难 dependabot：真 bot 由 App 按 GitHub
    // 账号类型豁免，而账号类型离线取不到，所以本地照常报。
    if (looksLikeBotAddress(commit.authorEmail)) {
      console.error('  This looks like a bot address. Bot commits are exempt on the pull request,');
      console.error('  where the DCO App can check the GitHub account type — this check cannot,');
      console.error('  so it reports them rather than trusting a forgeable address.');
    }
  }
  // 用完整 sha：短 sha 在大仓里可能歧义，让复制粘贴的命令直接失败。
  console.error('\nHow to fix, on your pull request branch:');
  console.error('  most recent commit only:  git commit --amend -s --no-edit');
  console.error(`  several commits:          git rebase --signoff ${start}`);
  console.error('  then update the PR:       git push --force-with-lease');
  console.error('\nTo stop forgetting, commit with `git commit -s`, or install the hook shipped');
  console.error('with this repository once: `pnpm dco:install-hook` (.githooks/prepare-commit-msg).');
  console.error('The DCO file at the repository root states what the sign-off certifies;');
  console.error('CONTRIBUTING.en.md explains the requirement in full.');
}

function main() {
  const { start, head, baseRef } = resolveRange();
  const stdout = execFileSync('git', ['log', `--format=${LOG_FORMAT}`, `${start}..${head}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const commits = parseGitLog(stdout);

  if (commits.length === 0) {
    console.log(`No new commits in ${shortSha(start)}..${shortSha(head)}; nothing to check.`);
    return;
  }

  const { failures, exempted, checked } = validateCommits(commits);
  if (failures.length > 0) {
    reportFailures({ failures, start });
    process.exit(1);
  }

  const exemptNote = exempted.length > 0 ? `, ${exempted.length} exempt (merge commits)` : '';
  console.log(
    `DCO check passed: ${checked} ${checked === 1 ? 'commit' : 'commits'} signed off${exemptNote} ` +
      `— range ${shortSha(start)}..${shortSha(head)} (base ${baseRef}).`
  );

  if (!process.env.GITHUB_EVENT_PATH && !isSignOffHookInstalled()) {
    console.log('Tip: `pnpm dco:install-hook` signs off local commits automatically.');
  }
}

// 仅作为入口执行时运行；被 import 时只导出纯函数，便于单测。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
}
