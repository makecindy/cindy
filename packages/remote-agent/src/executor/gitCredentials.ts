/**
 * 供应商分享的受邀者任务：git 查看内容的命令在本机核实读不到凭证类文件时不弹确认卡
 * (docs/product-rules/provider-sharing.md §9 第 7 条)。
 *
 * 只看命令文本时，git diff、git log -p、git show、git grep 这类命令按可能读到提交进仓库的凭证处理
 * (credentials.ts)。这里在本机扫一遍仓库：所有分支、标签、stash 与 reflog 可达的提交里出现过的路径，
 * 加上暂存区，记下其中的凭证类路径(扫描结果按仓库缓存，提交变化后只补扫新增的部分)：
 *  - 一个都没有：这个仓库里查看内容的命令读不到凭证；
 *  - 有：命令用 `--` 限定的路径都碰不到这些文件时算读不到；
 *  - 还不行时(git diff、git show、git log)，按原命令只列出会显示的文件，其中没有凭证类文件也算读不到。
 * 认不出 git 在哪个仓库里跑、仓库带子模块、比较仓库外的文件、超过等待时限，都按读得到处理，照旧弹卡。
 * 会打出 git 配置的命令(git remote -v、git config --list 等)按本机生效的配置核对其中没有密钥。
 * 与命令文本判定一样只防误发：不能解析为提交的对象、replacement refs 与前段可能改状态时不授予豁免。
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { GitRead } from '@cindy/maker-core';

import { isShareCredentialPath, textSpellsOutSecret } from '../credentials.js';
import { resolveExecutorShell } from './shell.js';

/** 核实一条命令最多等这么久，超过就先弹卡；仓库扫描在后台继续，结果留给后面的命令。 */
const GIT_CREDENTIAL_WAIT_MS = 8_000;
const SCAN_TIMEOUT_MS = 120_000;
const QUERY_TIMEOUT_MS = 15_000;
/** 记下的凭证类路径上限：超过时不再逐个比对限定路径，按读得到处理。 */
const MAX_CREDENTIAL_PATHS = 4_096;
const MAX_REPOS = 16;
const MAX_PATHSPEC_LENGTH = 256;
const MAX_PATHSPEC_WILDCARDS = 8;

/** 交给这里核实的查看内容的子命令；git cat-file 直接读对象，不在内。 */
const CONTENT_SUBCOMMANDS: ReadonlySet<string> = new Set(['diff', 'show', 'log', 'whatchanged', 'grep', 'status']);
/** 会打出 git 配置的子命令(git credential 一律要确认，不交给这里)。 */
const CONFIG_SUBCOMMANDS: ReadonlySet<string> = new Set(['remote', 'config', 'var']);
/** 密码、令牌、http 头这类配置项：有取值就按密钥处理。 */
const SECRET_CONFIG_KEY = /(?:^|\.)(?:password|passwd|pass|token|secret|smtppass|apikey|api-key|extraheader)$/i;
/**
 * 这些子命令只按提交与文件显示内容，输出受 `--` 后的路径限定。git diff / git show 可以直接写出文件对象
 * (不受路径限定)，交给按会显示的文件核对。
 */
const PATHSPEC_SUBCOMMANDS: ReadonlySet<string> = new Set(['log', 'whatchanged', 'grep']);
/** 扫描覆盖不到：不经仓库比较文件(--no-index)、子模块、别的仓库的对象、从输入读提交。 */
const UNCOVERED_OPTION = /^--(?:no-i|rec|sub|alt|std)/;
/** 不在分支、标签与 reflog 里的特殊引用。 */
const PSEUDO_REF = /(?:ORIG|FETCH|MERGE|CHERRY_PICK|REVERT|REBASE|BISECT)_HEAD|AUTO_MERGE/;
/** 命令里改 git 的仓库、暂存区或对象位置的环境变量。 */
const GIT_ENV_ASSIGNMENT = /\bGIT_[A-Z0-9_]*\s*=/i;
const GIT_CONFIG_ENV_ASSIGNMENT = /\b(?:HOME|XDG_CONFIG_HOME)\s*=/i;
/** 列出历史里每个路径(每个路径至少在某次提交里以新增出现)。 */
const HISTORY_PATHS = ['log', '--diff-merges=separate', '--root', '--no-renames', '--diff-filter=A', '--name-only', '--format=', '-z', '--no-show-signature', '--no-textconv', '--no-ext-diff'];
/**
 * 按原命令只列出会显示的文件(插在原有选项之后，后出现的输出格式生效，见 shownFilesArgs)。合并提交按
 * 每个父提交分别列、不认改名，只会多列。git grep 的选项不能放在搜索词之后，不在内。
 */
const SHOWN_FILES: Readonly<Record<string, { sub: string; args: readonly string[] }>> = {
  diff: { sub: 'diff', args: ['--name-only', '--no-renames', '--no-relative', '--no-color', '-z', '--no-textconv', '--no-ext-diff'] },
  show: { sub: 'show', args: ['--diff-merges=separate', '--name-only', '--format=', '--no-renames', '--no-relative', '--no-color', '-z', '--no-textconv', '--no-ext-diff', '--no-show-signature'] },
  log: { sub: 'log', args: ['--diff-merges=separate', '--name-only', '--format=', '--root', '--no-renames', '--no-relative', '--no-color', '-z', '--no-textconv', '--no-ext-diff', '--no-show-signature'] },
  whatchanged: { sub: 'log', args: ['--diff-merges=separate', '--name-only', '--format=', '--root', '--no-renames', '--no-relative', '--no-color', '-z', '--no-textconv', '--no-ext-diff', '--no-show-signature'] },
};
/** 会在文件名列表里夹进别的内容的输出选项：碰到就不这样核对。 */
const MIXED_OUTPUT_OPTION = /^--(?:graph|stat|numstat|shortstat|dirstat|summary|raw|name-|check|compact-summary|patch-with|line-prefix)/;
/**
 * 确定不会把后一个参数当作取值的选项。列文件的选项插在某个参数之后时，前一个参数必须是这类选项、
 * `--名称=值`、带数字的短选项或提交；否则插进去的选项可能被它当成取值(`git log -S <文件名>`)。
 */
const VALUELESS_OPTIONS: ReadonlySet<string> = new Set([
  '-p', '-u', '--patch', '-W', '--function-context', '--cached', '--staged', '--merge-base', '-R', '--check',
  '-a', '--text', '-w', '-b', '--ignore-all-space', '--ignore-space-change', '--ignore-blank-lines',
  '--minimal', '--patience', '--histogram', '--word-diff', '--color-words', '--color', '--no-color',
  '--no-ext-diff', '--no-textconv', '--no-prefix', '--full-index', '--binary', '-M', '-C', '-B', '--find-renames', '--no-renames',
  '-m', '-c', '--cc', '--root', '--follow', '--full-diff', '--all', '--branches', '--tags', '--remotes',
  '--no-merges', '--merges', '--first-parent', '--reverse', '--oneline', '--decorate', '--no-decorate',
  '--abbrev-commit', '--source', '--left-right', '--date-order', '--topo-order', '-g', '--walk-reflogs',
]);

function cannotTakeNextAsValue(token: string | undefined): boolean {
  return token === undefined
    || !token.startsWith('-')
    || /^--[\w-]+=/.test(token)
    || /^-(?:\d+|[nUMCBl]\d+)$/.test(token)
    || VALUELESS_OPTIONS.has(token);
}

interface RepoHistory {
  /** 扫描时的提交端点(分支、标签、stash 与 reflog)：变化后只扫新增的部分。 */
  tips: Set<string>;
  /** 历史里出现过的凭证类路径(相对仓库根，`/` 分隔)。 */
  credentials: Set<string>;
}

interface RepoEntry {
  history: RepoHistory | null;
  refreshing: Promise<RepoHistory | null> | null;
  /** 扫描失败或超时：本次运行里不再核实这个仓库。 */
  unavailable: boolean;
}

/**
 * 跑一条 git。onRecord 逐个收到以 NUL 分隔的输出(-z)，返回 true 表示已有结论：提前结束 git，照常返回。
 */
function git(
  args: readonly string[],
  cwd: string,
  opts: { stdin?: string; onRecord?: (record: string) => boolean | void; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-replace-objects', ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? QUERY_TIMEOUT_MS);
    let output = '';
    let pending = '';
    let stopped = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (!opts.onRecord) {
        output += chunk;
        return;
      }
      if (stopped) return;
      const records = (pending + chunk).split('\0');
      pending = records.pop() ?? '';
      for (const record of records) {
        if (opts.onRecord(record) !== true) continue;
        stopped = true;
        child.kill();
        return;
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (stopped) {
        resolve(output);
        return;
      }
      if (code !== 0) {
        reject(new Error(`git ${args[0]} exited with ${code ?? 'a signal'}`));
        return;
      }
      if (pending) opts.onRecord?.(pending);
      resolve(output);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.stdin ?? '');
  });
}

/** 收集凭证类路径；超过上限时返回 null。 */
function credentialCollector(top: string): { add(file: string): void; result(): Set<string> | null } {
  const credentials = new Set<string>();
  return {
    add(file) {
      if (file && credentials.size <= MAX_CREDENTIAL_PATHS && isShareCredentialPath(path.join(top, file))) credentials.add(file);
    },
    result: () => (credentials.size > MAX_CREDENTIAL_PATHS ? null : credentials),
  };
}

async function scanHistory(top: string, extraArgs: readonly string[], stdin?: string): Promise<Set<string> | null> {
  const collector = credentialCollector(top);
  await git([...HISTORY_PATHS, ...extraArgs], top, { stdin, timeoutMs: SCAN_TIMEOUT_MS, onRecord: collector.add });
  return collector.result();
}

/** 暂存区里的凭证类路径；带子模块或超过上限时返回 null。 */
async function indexCredentials(top: string, timeoutMs: number): Promise<Set<string> | null> {
  const collector = credentialCollector(top);
  let submodule = false;
  await git(['ls-files', '--stage', '-z'], top, {
    timeoutMs,
    onRecord: (record) => {
      const tab = record.indexOf('\t');
      if (tab < 0) return;
      if (record.startsWith('160000 ')) submodule = true;
      collector.add(record.slice(tab + 1));
    },
  });
  return submodule ? null : collector.result();
}

async function currentTips(top: string): Promise<Set<string>> {
  const output = await git(['rev-list', '--all', '--reflog', '--no-walk'], top);
  return new Set(output.split(/\r?\n/).filter(Boolean));
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

function isOutside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative.startsWith('..') || path.isAbsolute(relative);
}

async function exists(target: string): Promise<boolean> {
  return fsp.stat(target).then(() => true, () => false);
}

type PathspecToken =
  | { kind: 'star' }
  | { kind: 'any' }
  | { kind: 'literal'; value: string };

function pathspecIsTooComplex(spec: string): boolean {
  let wildcardCount = 0;
  for (const char of spec) {
    if (char === '*' || char === '?' || char === '[') wildcardCount += 1;
  }
  return spec.length > MAX_PATHSPEC_LENGTH || wildcardCount > MAX_PATHSPEC_WILDCARDS;
}

function pathspecIsTooComplexForRead(read: GitRead): boolean {
  if (!PATHSPEC_SUBCOMMANDS.has(read.sub)) return false;
  const separator = read.args.indexOf('--');
  if (separator < 0 || separator === read.args.length - 1) return false;
  return read.args.slice(separator + 1).some(pathspecIsTooComplex);
}

function compilePathspec(spec: string): PathspecToken[] {
  const tokens: PathspecToken[] = [];
  for (let index = 0; index < spec.length; index += 1) {
    const char = spec.charAt(index);
    if (char === '*') tokens.push({ kind: 'star' });
    else if (char === '?') tokens.push({ kind: 'any' });
    else if (char === '[') {
      tokens.push({ kind: 'any' });
      const close = spec.indexOf(']', index + 2);
      if (close > 0) index = close;
    } else tokens.push({ kind: 'literal', value: char });
  }
  return tokens;
}

function globMatches(tokens: readonly PathspecToken[], value: string): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let lastStarIndex = -1;
  let starValueIndex = 0;
  while (valueIndex < value.length) {
    const token = tokens[patternIndex];
    if (token?.kind === 'literal' && token.value === value.charAt(valueIndex)) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (token?.kind === 'any') {
      patternIndex += 1;
      valueIndex += 1;
    } else if (token?.kind === 'star') {
      lastStarIndex = patternIndex;
      starValueIndex = valueIndex;
      patternIndex += 1;
    } else if (lastStarIndex >= 0) {
      patternIndex = lastStarIndex + 1;
      starValueIndex += 1;
      valueIndex = starValueIndex;
    } else {
      return false;
    }
  }
  while (tokens[patternIndex]?.kind === 'star') patternIndex += 1;
  return patternIndex === tokens.length;
}

/**
 * git 路径限定是否可能选中 file(都已转小写，相对仓库根)：不含通配符时是这个路径本身或它下面的文件；
 * 含通配符时 `*` 可跨目录，方括号放宽为任意一个字符，上层目录被选中也算(只会多判、不会漏判)。
 */
function pathspecCouldSelect(spec: string): (file: string) => boolean {
  if (!/[*?[]/.test(spec)) return (file) => spec === '' || file === spec || file.startsWith(`${spec}/`);
  if (pathspecIsTooComplex(spec)) return () => false;
  const tokens = compilePathspec(spec);
  return (file) => {
    for (let end = file.length; end > 0; end = file.lastIndexOf('/', end - 1)) {
      if (globMatches(tokens, file.slice(0, end))) return true;
    }
    return false;
  };
}

/** 命令用 `--` 限定的路径都碰不到这些凭证类路径。 */
function pathspecsAvoid(read: GitRead, cwd: string, top: string, credentials: ReadonlySet<string>): boolean {
  if (!PATHSPEC_SUBCOMMANDS.has(read.sub)) return false;
  const separator = read.args.indexOf('--');
  if (separator < 0 || separator === read.args.length - 1) return false;
  if (pathspecIsTooComplexForRead(read)) return false;
  if (read.args.slice(0, separator).some((arg) => arg === '--full-diff' || arg.startsWith('--full-diff='))) return false;
  // `--` 前带 `:` 的是 <提交>:<路径> 这类直接指定的对象，不受后面的路径限定。
  if (read.args.slice(0, separator).some((arg) => !arg.startsWith('-') && arg.includes(':'))) return false;
  const files = [...credentials].map((file) => file.toLowerCase());
  return read.args.slice(separator + 1).every((spec) => {
    if (!spec || spec.startsWith(':') || spec.includes('\\')) return false;
    const target = path.resolve(cwd, spec);
    if (isOutside(top, target)) return false;
    const selects = pathspecCouldSelect(path.relative(top, target).split(path.sep).join('/').toLowerCase());
    return !files.some(selects);
  });
}

function revisionOperands(read: GitRead): string[] | null {
  if (!SHOWN_FILES[read.sub] && !PATHSPEC_SUBCOMMANDS.has(read.sub)) return [];
  const separator = read.args.indexOf('--');
  const args = read.args.slice(0, separator < 0 ? read.args.length : separator);
  if (read.sub === 'grep') {
    let patternProvided = false;
    const revisions: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-e' || arg === '--regexp') {
        if (args[index + 1] === undefined) return null;
        index += 1;
        patternProvided = true;
      } else if (/^(?:-e.+|--regexp=)/.test(arg)) {
        patternProvided = true;
      } else if (arg === '--cached' || arg === '--line-number' || /^-[nivwhHlLcoqEGFP]+$/.test(arg)) {
        continue;
      } else if (arg.startsWith('-')) {
        return null;
      } else if (!patternProvided) {
        patternProvided = true;
      } else {
        revisions.push(arg);
      }
    }
    return patternProvided ? revisions : null;
  }
  return args.flatMap((arg) => {
    if (arg.startsWith('-')) return [];
    return arg.split(/\.\.\.?/).filter(Boolean);
  });
}

async function revisionsAreCovered(
  read: GitRead,
  cwd: string,
  tips: ReadonlySet<string>,
  deadline: number,
): Promise<boolean> {
  const revisions = revisionOperands(read);
  if (!revisions) return false;
  if (read.sub === 'show' && revisions.length === 0) revisions.push('HEAD');
  for (const revision of revisions) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const commit = await git(['rev-parse', '--verify', '--quiet', revision + '^{commit}'], cwd, { timeoutMs: remaining })
      .then((output) => output.trim(), () => '');
    if (!commit) return false;
    if (tips.has(commit)) continue;
    let covered = false;
    for (const tip of tips) {
      const tipRemaining = deadline - Date.now();
      if (tipRemaining <= 0) return false;
      const isAncestor = await git(['merge-base', '--is-ancestor', commit, tip], cwd, { timeoutMs: tipRemaining })
        .then(() => true, () => false);
      if (isAncestor) {
        covered = true;
        break;
      }
    }
    if (!covered) return false;
  }
  return true;
}

/**
 * 按原命令只列出会显示的文件的完整参数；不能这样核对时返回 null。
 *  - git diff / git show 写出的对象都得是提交(或提交区间)：直接写出文件对象(<提交>:<路径>、指向文件的
 *    标签)时显示的是内容本身，列不出文件名；
 *  - 列文件的选项放在原有选项之后，后出现的输出格式生效：有 `--` 时放在它前面，没有时放在第一个路径前
 *    (git 不接受路径之后的选项)。
 */
async function shownFilesArgs(read: GitRead, cwd: string): Promise<string[] | null> {
  const listing = SHOWN_FILES[read.sub];
  const separator = read.args.indexOf('--');
  // --check prints source lines and conflicts with --name-only. Remove only
  // actual flags; preserve path operands and possible values of other options.
  const args = read.args.filter((arg, index) => !(arg === '--check'
    && (separator < 0 || index < separator) && cannotTakeNextAsValue(read.args[index - 1])));
  if (!listing || args.some((arg) => MIXED_OUTPUT_OPTION.test(arg))) return null;
  const objectsMustBeCommits = read.sub === 'diff' || read.sub === 'show';
  const resolves = (spec: string) => git(['rev-parse', '--verify', '--quiet', spec], cwd).then(() => true, () => false);
  const argsSeparator = args.indexOf('--');
  let insertAt = argsSeparator < 0 ? args.length : argsSeparator;
  let sawCommit = false;
  for (let index = 0; index < insertAt; index += 1) {
    const arg = args[index];
    if (arg.startsWith('-')) continue;
    const range = arg.split(/\.\.\.?/);
    if (range.length > 1) {
      for (const side of objectsMustBeCommits ? range : []) {
        if (!(await resolves((side || 'HEAD') + '^{commit}'))) return null;
      }
      sawCommit = objectsMustBeCommits;
      continue;
    }
    if (await resolves(`${arg}^{commit}`)) {
      sawCommit = true;
      continue;
    }
    if (await resolves(arg)) {
      if (objectsMustBeCommits) return null;
      continue;
    }
    // 既不是提交也不是别的对象、又是存在的路径：git 从这里起都按路径处理。
    if (await exists(path.resolve(cwd, arg))) insertAt = index;
  }
  if (read.sub === 'show' && !sawCommit && !(await resolves('HEAD^{commit}'))) return null;
  if (!cannotTakeNextAsValue(args[insertAt - 1])) return null;
  return [listing.sub, ...args.slice(0, insertAt), ...listing.args, ...args.slice(insertAt)];
}

/**
 * 输出的一行可能指向凭证类文件。正常是一个文件名；原命令的输出格式盖过了只列文件名时(比如选项值
 * 被认错)是补丁之类的整行，按空白拆开、去掉引号与 a/ b/ 前缀后每一段也比对，只会多判。
 */
function lineMentionsCredential(top: string, line: string): boolean {
  if (!line) return false;
  const parts = line.split(/\s+/).map((part) => part.replace(/^"|"$/g, '').replace(/^[ab]\//, ''));
  return [line, ...parts].some((candidate) => Boolean(candidate) && isShareCredentialPath(path.join(top, candidate)));
}

/** 按原命令列出会显示的文件，其中没有凭证类文件。 */
async function shownFilesAvoidCredentials(read: GitRead, cwd: string, top: string, timeoutMs: number): Promise<boolean> {
  const args = await shownFilesArgs(read, cwd);
  if (!args) return false;
  let credential = false;
  await git(args, cwd, {
    timeoutMs,
    onRecord: (record) => {
      credential = record.split('\n').some((line) => lineMentionsCredential(top, line));
      return credential;
    },
  });
  return !credential;
}

/** 读这一项要打出的 git config 键名(小写)；列出全部或认不准键名时为 undefined。 */
function requestedConfigKey(read: GitRead): string | undefined {
  if (read.sub !== 'config') return undefined;
  const args = read.args;
  const key = args.length === 1 ? args[0]
    : args.length === 2 && ['--get', '--get-all', 'get'].includes(args[0] ?? '') ? args[1]
      : undefined;
  return key && !key.startsWith('-') && key.includes('.') ? key.toLowerCase() : undefined;
}

/** 配置项里有密钥：键名或取值里直接写着(带令牌的地址、Authorization 头)，或是密码、令牌、http 头这类项。 */
function configEntryHoldsSecret(key: string, value: string): boolean {
  return textSpellsOutSecret(`${key}=${value}`) || (SECRET_CONFIG_KEY.test(key) && value.trim() !== '');
}

/**
 * 打出 git 配置的命令(git remote -v / get-url / show、读 git config、git var -l)：按这个目录生效的 git 配置
 * (系统、全局、仓库，含 include)核对它会打出的那些项里没有密钥。读别的配置文件(-f / --blob)的不核对。
 */
async function configReadProvesSafe(read: GitRead, deadline: number): Promise<boolean> {
  if (read.sub === 'remote') {
    const actionIndex = read.args.findIndex((arg) => !arg.startsWith('-'));
    if (read.args[actionIndex] === 'show' && read.args[actionIndex + 1] !== '-n') return false;
  }
  const configSources = ['--file', '--blob', '--global', '--system', '--local', '--worktree'];
  if (!read.cwd || read.args.some((arg) => {
    if (/[$`]/.test(arg) || /^-[^-]*f/.test(arg)) return true;
    const name = arg.split('=')[0].replace(/^--no-/, '--');
    return name.startsWith('--') && name.length > 2 && configSources.some((option) => option.startsWith(name));
  })) return false;
  const cwd = await fsp.realpath(read.cwd);
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  if (read.sub === 'var') {
    // git var includes logical values derived from the environment, not just
    // config. Inspect exactly the requested output locally without logging it.
    if (read.args.length !== 1 || (read.args[0] !== '-l' && !/^GIT_[A-Z0-9_]+$/.test(read.args[0]))) return false;
    const output = await git(['var', ...read.args], cwd, { timeoutMs: remaining });
    if (textSpellsOutSecret(output)) return false;
    if (read.args[0] !== '-l') return true;
    // -l also prints config values. Preserve NUL-delimited key/value checks
    // below so a multiline password/token value cannot lose its key.
  }
  const key = requestedConfigKey(read);
  const configRemaining = deadline - Date.now();
  if (configRemaining <= 0) return false;
  const entries = (await git(['config', '--list', '-z'], cwd, { timeoutMs: configRemaining })).split('\0').filter(Boolean);
  return !entries.some((entry) => {
    const newline = entry.indexOf('\n');
    const name = newline < 0 ? entry : entry.slice(0, newline);
    const lowered = name.toLowerCase();
    const shown = read.sub === 'remote'
      ? lowered.startsWith('remote.') || lowered.startsWith('url.')
      : key === undefined || lowered === key;
    return shown && configEntryHoldsSecret(name, newline < 0 ? '' : entry.slice(newline + 1));
  });
}

async function mailmapSourcesAllowProbe(
  read: GitRead, cwd: string, top: string, entries: readonly string[], deadline: number,
): Promise<boolean> {
  if (!/^(?:log|show|whatchanged|blame)$/.test(read.sub)) return true;
  const fileIsSafe = async (file: string): Promise<boolean> => {
    if (isShareCredentialPath(file)) return false;
    try {
      return !isShareCredentialPath(await fsp.realpath(file));
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  };
  // Git reads the worktree mailmap and configured sources even for metadata
  // formats. Inspect paths, not arbitrary source contents; normal maps stay free.
  if (!(await fileIsSafe(path.join(top, '.mailmap')))) return false;
  if (entries.some((entry) => /^mailmap\.file\n/i.test(entry))) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const file = (await git(['config', '--path', '-z', '--get', 'mailmap.file'], cwd, { timeoutMs: remaining })).replace(/\0$/, '');
    if (file && !(await fileIsSafe(path.resolve(top, file)))) return false;
  }
  for (const entry of entries) {
    if (!/^mailmap\.blob\n/i.test(entry)) continue;
    const value = entry.slice(entry.indexOf('\n') + 1);
    if (!value) continue;
    const objectPath = /^[A-Za-z0-9_./@{}~^+\-]+:(.+)$/.exec(value)?.[1];
    if (!objectPath || isShareCredentialPath(path.posix.resolve('/', objectPath))) return false;
  }
  return true;
}

async function diffHelpersAllowCredentialProbe(read: GitRead, cwd: string, top: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  if (!CONTENT_SUBCOMMANDS.has(read.sub) && !read.metadataOnly) return true;
  if (read.args.some((arg) => {
    const name = arg.split('=')[0];
    return arg.includes('%G') || (name.startsWith('--') && name.length > 2 && '--show-signature'.startsWith(name));
  })) return false;
  const disabled = new Set<string>();
  for (const arg of read.args) {
    if (arg !== '--no-textconv' && arg !== '--no-ext-diff') break;
    disabled.add(arg);
  }
  const textconvEnabled = !disabled.has('--no-textconv');
  const externalDiffEnabled = !disabled.has('--no-ext-diff');
  if (externalDiffEnabled && process.env.GIT_EXTERNAL_DIFF !== undefined) return false;
  const entries = (await git(['config', '--list', '-z'], cwd, { timeoutMs })).split('\0');
  if (!(await mailmapSourcesAllowProbe(read, cwd, top, entries, deadline))) return false;
  const defaultRemerge = entries.some((entry) => /^log\.diffmerges\n(?:r|remerge)\s*$/i.test(entry));
  const mayRemerge = /^(?:log|show|whatchanged)$/.test(read.sub) && read.args.some((arg, index, args) => {
    if (arg === '-m') return defaultRemerge;
    const name = arg.split('=')[0];
    if (!name.startsWith('--') || name.length <= 2) return false;
    if ('--remerge-diff'.startsWith(name)) return true;
    if (!'--diff-merges'.startsWith(name)) return false;
    const mode = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[index + 1];
    return mode === 'r' || mode === 'remerge' || (defaultRemerge && (mode === 'on' || mode === 'm'));
  });
  return !entries.some((entry) => {
    const newline = entry.indexOf('\n');
    const key = newline < 0 ? entry : entry.slice(0, newline);
    const lowered = key.toLowerCase();
    if (lowered === 'core.fsmonitor' || lowered === 'core.hookspath' || /^gpg(?:\..+)?\.program$/i.test(key)) return true;
    const value = newline < 0 ? '' : entry.slice(newline + 1).trim();
    if (lowered === 'log.showsignature') return !/^(?:false|no|off|0)$/i.test(value);
    if (newline < 0 || !value) return false;
    // Reconstructing a merge can run a configured merge driver even for ordinary
    // source paths. Check before any probe; unrelated Git reads stay exempt.
    if (mayRemerge && /^merge\..+\.driver$/i.test(key)) return true;
    if ((lowered === 'format.pretty' || lowered.startsWith('pretty.')) && value.includes('%G')) return true;
    // Trust the standard installed Git LFS commands, just as we trust Git itself.
    // This gate prevents accidental credential disclosure, not replaced binaries.
    // Match the complete key/value so custom drivers and shell suffixes still ask.
    const standardLfs = (key === 'filter.lfs.clean' && value === 'git-lfs clean -- %f')
      || (key === 'filter.lfs.process' && value === 'git-lfs filter-process');
    return (/^filter\..+\.(?:clean|process)$/i.test(key) && !standardLfs)
      || (textconvEnabled && /^diff\..+\.textconv$/i.test(key))
      || (externalDiffEnabled && (/^diff\..+\.command$/i.test(key) || key.toLowerCase() === 'diff.external'));
  });
}

async function shellStartupAllowsGitProbe(waitMs: number): Promise<boolean> {
  const shell = resolveExecutorShell();
  if (shell.dialect !== 'bash') return false;
  if (['/bin/bash', '/usr/bin/bash'].includes(shell.file)) return true;
  if (path.basename(shell.file) !== 'zsh') {
    if (process.platform !== 'win32' || process.env.CLAUDE_CODE_GIT_BASH_PATH !== undefined) return false;
    const normalized = (file: string) => path.win32.normalize(file).replace(/[\\/]$/, '').toLowerCase();
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((root): root is string => {
      if (!root || !/^[a-z]:\\/i.test(path.win32.normalize(root))) return false;
      const drive = path.win32.parse(root).root;
      return ['Program Files', 'Program Files (x86)'].some((directory) => normalized(root) === normalized(path.win32.join(drive, directory)));
    });
    const trusted = roots.flatMap((root) => [
      path.win32.join(root, 'Git', 'bin', 'bash.exe'),
      path.win32.join(root, 'Git', 'usr', 'bin', 'bash.exe'),
    ]).map(normalized);
    if (!trusted.includes(normalized(shell.file))) return false;
    const actual = await fsp.realpath(shell.file).catch(() => undefined);
    return actual !== undefined && normalized(actual) === normalized(shell.file);
  }
  if (!['/bin/zsh', '/usr/bin/zsh'].includes(shell.file)) return false;
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home)) return false;
  const startupFiles = ['/etc/zshenv', '/etc/zsh/zshenv', path.join(home, '.zshenv')]
    .flatMap((file) => [file, file + '.zwc']);
  const checks = Promise.all(startupFiles.map((file) => fsp.lstat(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => error.code !== 'ENOENT',
  ))).then((present) => !present.some(Boolean));
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      checks,
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, waitMs)); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class GitCredentialHistory {
  private readonly repos = new Map<string, RepoEntry>();

  constructor(private readonly opts: { waitMs?: number } = {}) {}

  /** 这些 git 调用(credentials.ts shareCredentialGitReads 的结果)在本机核实后都读不到、打不出凭证。 */
  async provesSafe(command: string, reads: readonly GitRead[], signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, this.opts.waitMs ?? GIT_CREDENTIAL_WAIT_MS);
    if (reads.length === 0 || GIT_ENV_ASSIGNMENT.test(command) || GIT_CONFIG_ENV_ASSIGNMENT.test(command)) return false;
    if (['BASH_ENV', 'ENV', 'ZDOTDIR'].some((key) => process.env[key] !== undefined)
      || Object.keys(process.env).some((key) => key.startsWith('BASH_FUNC_'))) return false;
    const searchPath = process.env.PATH;
    if (!searchPath || searchPath.split(path.delimiter).some((entry) => !path.isAbsolute(entry))) return false;
    if (reads.some((read) => read.usesInheritedGitRuntime !== true)) return false;
    // The history/index probe runs before the complete shell command. If an earlier
    // segment may change Git state, its result can become stale before the later read;
    // keep the credential confirmation in that case instead of granting an exemption.
    if (reads.some((read) => read.priorSegmentsMayMutate)) return false;
    if (signal?.aborted || deadline <= Date.now()) return false;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
      onAbort = () => resolve(false);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([this.readsProveSafe(reads, deadline, signal).catch(() => false), stopped]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  private async readsProveSafe(reads: readonly GitRead[], deadline: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted || deadline <= Date.now()
      || !(await shellStartupAllowsGitProbe(deadline - Date.now()).catch(() => false))) {
      return false;
    }
    for (const read of reads) {
      if (signal?.aborted || deadline <= Date.now()) return false;
      const check = CONFIG_SUBCOMMANDS.has(read.sub)
        ? configReadProvesSafe(read, deadline) : this.readProvesSafe(read, deadline, signal);
      const safe = await check.catch(() => false);
      if (signal?.aborted || deadline <= Date.now() || !safe) return false;
    }
    return true;
  }

  private async readProvesSafe(read: GitRead, deadline: number, signal?: AbortSignal): Promise<boolean> {
    if (!read.cwd || (!CONTENT_SUBCOMMANDS.has(read.sub) && !read.metadataOnly)) return false;
    if (read.args.some((arg) => /[$`]/.test(arg) || UNCOVERED_OPTION.test(arg) || PSEUDO_REF.test(arg))) return false;
    const cwd = await fsp.realpath(read.cwd);
    if (pathspecIsTooComplexForRead(read)) return false;
    const rootTimeout = deadline - Date.now();
    if (rootTimeout <= 0 || signal?.aborted) return false;
    const [topLine, commonLine] = (await git(['rev-parse', '--show-toplevel', '--git-common-dir'], cwd, {
      timeoutMs: rootTimeout,
    })).split(/\r?\n/);
    if (!topLine || !commonLine) return false;
    const top = path.resolve(topLine);
    const commonDir = path.resolve(cwd, commonLine);
    if (process.env.GIT_REPLACE_REF_BASE !== undefined) return false;
    const replacementTimeout = deadline - Date.now();
    if (replacementTimeout <= 0) return false;
    const replacements = await git(['for-each-ref', '--format=%(refname)', 'refs/replace'], top, {
      timeoutMs: replacementTimeout,
    });
    if (replacements.trim()) return false;
    const helperTimeout = deadline - Date.now();
    if (helperTimeout <= 0 || !(await diffHelpersAllowCredentialProbe(read, cwd, top, helperTimeout))) return false;
    const hook = path.join(commonDir, 'hooks', 'post-index-change');
    const hookPresent = await Promise.all([hook, hook + '.exe'].map((file) => fsp.lstat(file).then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code !== 'ENOENT',
    )));
    if (hookPresent.some(Boolean)) return false;
    const modulesPresent = await fsp.lstat(path.join(commonDir, 'modules')).then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code !== 'ENOENT',
    );
    if (modulesPresent) return false;
    // 指向仓库外的文件时 git diff 不经仓库、直接比较文件。
    if (read.sub === 'diff' && read.args.some((arg) => !arg.startsWith('-') && isOutside(top, path.resolve(cwd, arg)))) {
      return false;
    }
    const indexTimeout = deadline - Date.now();
    if (indexTimeout <= 0 || signal?.aborted) return false;
    const index = await indexCredentials(top, indexTimeout);
    if (!index) return false;
    if (read.metadataOnly) return true;
    const history = await this.waitForHistory(top, commonDir, deadline, signal);
    if (history) {
      const credentials = new Set([...history.credentials, ...index]);
      if (await revisionsAreCovered(read, cwd, history.tips, deadline)
        && (credentials.size === 0 || pathspecsAvoid(read, cwd, top, credentials))) return true;
    }
    // 仓库里有凭证类文件(或还没扫完)：按这条命令实际会显示的文件再核对一次，与等扫描共用同一个时限。
    const remaining = deadline - Date.now();
    if (signal?.aborted || remaining <= 0) return false;
    return shownFilesAvoidCredentials(read, cwd, top, remaining);
  }

  private async waitForHistory(
    top: string,
    commonDir: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<RepoHistory | null> {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
      onAbort = () => resolve(null);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([this.history(top, commonDir), timeout]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  private history(top: string, commonDir: string): Promise<RepoHistory | null> {
    let entry = this.repos.get(commonDir);
    if (!entry) {
      entry = { history: null, refreshing: null, unavailable: false };
      this.repos.set(commonDir, entry);
      if (this.repos.size > MAX_REPOS) this.repos.delete(this.repos.keys().next().value as string);
    }
    if (entry.unavailable) return Promise.resolve(null);
    const current = entry;
    current.refreshing ??= this.refresh(current, top).finally(() => {
      current.refreshing = null;
    });
    return current.refreshing;
  }

  private async refresh(entry: RepoEntry, top: string): Promise<RepoHistory | null> {
    try {
      const tips = await currentTips(top);
      const previous = entry.history;
      if (previous && sameSet(previous.tips, tips)) return previous;
      // undefined = 还没扫；null = 凭证类路径太多。
      let credentials: Set<string> | null | undefined;
      if (previous) {
        // 只扫上次之后新增的提交；上次的端点已被清理掉时 git 会报错，改为整个重扫。
        const stdin = [...previous.tips].map((tip) => `^${tip}\n`).join('');
        const added = await scanHistory(top, ['--stdin', '--all', '--reflog'], stdin).catch(() => undefined);
        if (added !== undefined) credentials = added && new Set([...previous.credentials, ...added]);
      }
      if (credentials === undefined) credentials = await scanHistory(top, ['--all', '--reflog']);
      if (!credentials || credentials.size > MAX_CREDENTIAL_PATHS) {
        entry.unavailable = true;
        return null;
      }
      entry.history = { tips, credentials };
      return entry.history;
    } catch {
      entry.unavailable = true;
      return null;
    }
  }
}
