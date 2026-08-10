/**
 * Auto-review 批准记忆 —— harness 无关的「同一件事不重复审」层。
 *
 * 归档会话分析显示，agent 的 bash 调用里有大量**逐字重复**。此前这些重复每次都要
 * 重新走一遍灰区审阅。灰区 AI 判决虽有会话内缓存,但缓存只活在当前 session;
 * 同一条 `rm -rf build` 在会话重开后还得再审一次。
 *
 * 本模块只记 **审阅器 allow**:AI 判 allow 后,相同工作区、harness、reviewer 路由、
 * 逐字命令和逐字 `userIntent` 才能复用。用户在权限卡点的「允许一次」绝不进入长期记忆;
 * 它没有表达跨轮次授权,不得被静默升级成跨会话 allowlist。`block` / `ask` 也不记。
 *
 * ## 安全边界(五条,均由本模块强制,调用方不得绕过)
 *
 * 1. **红线永不记忆**。`prompt-each-time` 档(确定性红线:`curl | sh`、`rm -rf` 越界、凭证
 *    读写、云 metadata 探测……)的动作签名一律返回 `null`,既不查也不存。这类必须逐次确认,
 *    与 Codex 的 "red-line decisions cannot be remembered" 同口径。
 * 2. **可变间接执行不记忆**。`pnpm test`、`bash ./check.sh` 等命令的外层文本不变时，
 *    `package.json` 或脚本内容仍可被替换；这类每次重新审核，不用不完整的单层文件 hash
 *    制造安全错觉。
 * 3. **签名是逐字命令 + 逐字意图**,不是前缀通配。`rm -rf build` 的批准不会顺带放行
 *    `rm -rf dist`。前缀规则(`Bash(rm -rf:*)` 那种)会让参数位置的提权
 *    变得不可见 —— 例如把 `curl <url>` 的批准扩到 `curl -X POST <url>` —— 属独立的产品
 *    决策,不在本层默默引入。
 * 4. **记忆按工作区分域**。同一条 `rm -rf build` 在 A 仓被批准,不影响 B 仓;工作区根参与
 *    签名哈希。跨会话持久化同样带工作区域,换项目不串。
 * 5. **记忆绑定 reviewer 路由**。模型或 provider 切换后重新送审,不能把 A 路由的自动判决
 *    当成 B 路由已批准。异步审阅按请求创建时的路由快照落签名,不读返回时的会话可变态。
 *
 * ## 持久化
 *
 * 本包不碰文件系统(共享 package 不得自己猜宿主目录,见 credentials-and-local-storage.md)。
 * 跨会话记忆由宿主注入 `ApprovalMemoryStore`:宿主负责落盘位置、体量上限与查看/清除
 * 接口；是否接入用户界面由宿主产品层决定。未注入时退化成纯会话内记忆。
 */

import { createHash } from 'node:crypto';

import type { Logger } from '../../interfaces/logger.js';
import type { AgentKind } from '../../types/common.js';

import {
  classifyLocalAutoReviewTier,
  type AutoReviewRouteIdentity,
} from './auto-review-decision.js';
import {
  commandExecutableInvocations,
  commandUsesExplicitExecutablePath,
  type ReviewableAction,
} from './auto-review.js';

/**
 * 记忆来源。`user` 仅为宿主读取旧版存储保留兼容；v2 只写 `reviewer`，旧签名不会命中。
 */
export type ApprovalMemoryOrigin = 'user' | 'reviewer';

/**
 * 宿主注入的跨会话存储。全部方法都是 best-effort:抛错 / 拒绝只降级成「本次没记住」,
 * 绝不能让权限判定本身失败(fail-open 只发生在**记忆写入**,不发生在**放行判定**上)。
 */
export interface ApprovalMemoryStore {
  /**
   * 载入该工作区已持久化的签名集合。会话启动时调用一次;失败按空集处理。
   * 返回的集合只被读取,不会被本模块改写。
   */
  load(workspaceKey: string): Promise<ReadonlySet<string>>;
  /** 追加一条签名。宿主负责去重、体量上限与落盘节流。 */
  add(workspaceKey: string, signature: string, origin: ApprovalMemoryOrigin): void;
  /**
   * 订阅宿主清除事件。成功清除指定工作区时传该 key；全量清除时不传。
   * 返回取消订阅函数。旧宿主未实现时，活动会话仍保持本地行为兼容。
   */
  subscribeClear?(listener: (workspaceKey?: string) => void): () => void;
}

export interface ApprovalMemoryOptions {
  /** 当前 harness。签名带上它，避免不同 harness 的权限语义意外串用。 */
  agentKind: AgentKind;
  /**
   * 工作区域键:参与记忆分域。用会话的可写根(`workspaceRoots[0]`),缺省用 `default`
   * —— 不带工作区的会话(纯对话)本就不该产生 exec 记忆,退化成单一域也不扩大范围。
   */
  workspaceKey: string;
  platform?: NodeJS.Platform;
  store?: ApprovalMemoryStore;
  logger?: Logger;
  /** 清除/关闭时让 harness 丢弃自己的异步 reviewer cache。 */
  onInvalidated?: () => void;
}

export interface ApprovalMemory {
  /** 该动作是否在完全相同的用户意图下被记住可放行。红线一律 false。 */
  isRemembered(
    action: ReviewableAction,
    userIntent: string,
    workspaceRoots: readonly string[],
    reviewerRoute: AutoReviewRouteIdentity,
  ): boolean;
  /** 轻量审阅器判定 allow。调用方必须传创建审阅请求时的意图与工作区根快照。 */
  rememberReviewerAllow(
    action: ReviewableAction,
    userIntent: string,
    workspaceRoots: readonly string[],
    reviewerRoute: AutoReviewRouteIdentity,
    generation?: number,
  ): void;
  /** 载入宿主持久化的签名(会话启动时调用一次;失败静默降级成纯会话内记忆)。 */
  hydrate(): Promise<void>;
  /** 当前清除代次；异步审阅请求必须把它带回结果快照。 */
  getGeneration(): number;
  /** 判断异步审阅结果是否仍属于当前批准记忆代次。 */
  isGenerationCurrent(generation: number): boolean;
  /** 会话关闭时取消宿主订阅并清理本地缓存。 */
  dispose(): void;
  /** 仅供测试/诊断:当前会话可见的签名数量。 */
  size(): number;
}

const MAX_SESSION_SIGNATURES = 500;

/**
 * 命令行凭证特征与凭证存储写操作 —— 命中即**不可记忆**。
 *
 * 两个理由,任一都足够:
 *  1. **最小授权**:凭证类动作不应该因为一次 allow 变成长期授权；摘要落盘并不改变这一点。
 *  2. **判定正确性**:凭证是会轮换的。逐字记住 `--token=abc` 只在这一把 token 有效期内
 *     有意义,换了 token 就是一条永远不会再命中的死记录 —— 记它没有收益,只有风险。
 *
 * 这不是安全分类(那是 classifyShellCommand 的职责),只是记忆层的准入门槛:命中的命令
 * 照常走原有判定链,只是每次都重新判 —— 与本模块引入前的行为一致。
 */
const SECRET_ENV_NAME_SOURCE = String.raw`[A-Z0-9_]*(?:TOKEN|SECRET|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY)[A-Z0-9_]*`;
const SECRET_CONFIG_KEY_SOURCE = String.raw`\S*(?:TOKEN|SECRET|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY)\S*`;

const CURL_EXPLICIT_CONFIG_PATTERN =
  /(?:^|[\s;&|('"`])(?:\S*[\\/])?curl(?:\.exe)?\b[^;&|\r\n]*(?:-K(?:\s*=?\s*)\S|--config(?:\s+|=)\S)/i;

const CURL_DIRECT_MUTABLE_FILE_OPTIONS: ReadonlySet<string> = new Set([
  '--alt-svc',
  '--ca-embed',
  '--cacert',
  '--capath',
  '--config',
  '--crlfile',
  '--egd-file',
  '--etag-compare',
  '--hsts',
  '--knownhosts',
  '--pinnedpubkey',
  '--proxy-cacert',
  '--proxy-capath',
  '--proxy-crlfile',
  '--proxy-pinnedpubkey',
  '--pubkey',
  '--random-file',
  '--ssl-sessions',
  '--time-cond',
  '--tls-earlydata',
  '--upload-file',
]);

const CURL_AT_FILE_OPTIONS: ReadonlySet<string> = new Set([
  '--data',
  '--data-ascii',
  '--data-binary',
  '--header',
  '--httpsig-key',
  '--json',
  '--proxy-header',
  '--url',
  '--write-out',
]);

const CURL_NAMED_AT_FILE_OPTIONS: ReadonlySet<string> = new Set([
  '--data-urlencode',
  '--url-query',
  '--variable',
]);

// 与 auto-review.ts 的 curl 短选项 arity 保持一致：遇到首个带值字母后，余下簇内容就是值。
const CURL_SHORT_VALUE_OPTIONS: ReadonlySet<string> = new Set(
  'odFHuAebcCDEKTUwxyYzmMQ',
);

function curlShortOptionWithValue(
  arg: string,
  nextArg: string | undefined,
): { letter: string; value: string | undefined } | null {
  if (!/^-[^-]/.test(arg)) return null;
  const cluster = arg.slice(1);
  for (let i = 0; i < cluster.length; i++) {
    const letter = cluster[i];
    if (!CURL_SHORT_VALUE_OPTIONS.has(letter)) continue;
    return { letter, value: cluster.slice(i + 1) || nextArg };
  }
  return null;
}

function curlFormValueReferencesFile(value: string): boolean {
  return /(?:^|[=;,])[@<]/.test(value);
}

function curlOptionValueReferencesFile(option: string, value: string | undefined): boolean {
  if (CURL_DIRECT_MUTABLE_FILE_OPTIONS.has(option)) return true;
  if (!value) return false;
  if (CURL_AT_FILE_OPTIONS.has(option)) return value.startsWith('@');
  if (CURL_NAMED_AT_FILE_OPTIONS.has(option)) {
    // `%name` 从环境变量取值；`name@file` / `%name@file` 从本地文件取值。
    return value.startsWith('%') || /^(?:%?[^=@]+)?@/.test(value);
  }
  return option === '--form' && curlFormValueReferencesFile(value);
}

function curlMayLoadMutableFileState(args: readonly string[]): boolean {
  // curl 只有**首参数**精确为小写 -q / --disable 时才禁用默认 curlrc。
  if (args[0] !== '-q' && args[0] !== '--disable') return true;
  const optionTerminator = args.indexOf('--');
  const options = optionTerminator === -1 ? args : args.slice(0, optionTerminator);
  for (let i = 0; i < options.length; i++) {
    const arg = options[i];
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const rawOption = equals === -1 ? arg : arg.slice(0, equals);
      const option = rawOption.startsWith('--expand-')
        ? `--${rawOption.slice('--expand-'.length)}`
        : rawOption;
      const value = equals === -1 ? options[i + 1] : arg.slice(equals + 1);
      // 显式 config 或其它文件输入会让相同 argv 对应不同请求、凭证或上传内容。
      if (/^--conf/.test(option) || curlOptionValueReferencesFile(option, value)) return true;
      continue;
    }
    const short = curlShortOptionWithValue(arg, options[i + 1]);
    if (!short) continue;
    if (short.letter === 'K' || short.letter === 'T' || short.letter === 'z') return true;
    if ((short.letter === 'd' || short.letter === 'H' || short.letter === 'w')
      && short.value?.startsWith('@')) return true;
    if (short.letter === 'F' && short.value && curlFormValueReferencesFile(short.value)) {
      return true;
    }
    // `-C -` 依据当前落地文件大小自动决定续传 offset，同一命令的真实请求并不稳定。
    if (short.letter === 'C' && short.value === '-') return true;
  }
  return false;
}

const WGET_EXPLICIT_CONFIG_PATTERN =
  /(?:^|[\s;&|('"`])(?:\S*[\\/])?wget(?:\.exe)?\b[^;&|\r\n]*--conf[\w-]*(?:\s+|=)\S/i;
const WGET_REQUIRED_USER_STATE_DISABLE_FLAGS = [
  '--no-config',
  '--no-netrc',
  '--no-hsts',
] as const;

const WGET_MUTABLE_FILE_OR_COMMAND_OPTION_PATTERNS: readonly RegExp[] = [
  // Wget accepts unique long-option abbreviations; match the shortest unambiguous stems we trust.
  /^--conf/,
  /^--exec/,
  /^--hsts-f/,
  /^--input-/,
  /^--load-c/,
  /^--save-c/,
  /^--post-f/,
  /^--body-f/,
  /^--(?:ask-p|use-a)/,
  /^--ca-/,
  /^--crl-f/,
  /^--pinnedp/,
  // -e/--execute and -i/--input-file may be attached or appear in a short-option cluster.
  /^-[^-]*[ei]/,
];

function wgetMayLoadMutableUserState(args: readonly string[]): boolean {
  const optionTerminator = args.indexOf('--');
  const options = optionTerminator === -1 ? args : args.slice(0, optionTerminator);
  // 启动文件、rc 命令、askpass，以及请求/凭证/TLS 的文件输入都能在 argv 不变时改变真实行为。
  if (options.some((arg) =>
    WGET_MUTABLE_FILE_OR_COMMAND_OPTION_PATTERNS.some((pattern) => pattern.test(arg)))) {
    return true;
  }
  // 只信任完整、大小写精确的禁用选项；缩写或 `--` 后的位置参数保持逐次审核。
  return WGET_REQUIRED_USER_STATE_DISABLE_FLAGS.some((flag) => !options.includes(flag));
}

const SQLITE_MUTABLE_DOT_COMMAND_PATTERN =
  /(?:^|[\r\n])\s*\.(?:archive|import|load|read|restore|shell|system)\b/i;

function sqliteMayLoadMutableFileState(args: readonly string[]): boolean {
  for (const arg of args) {
    // `-init FILE` 在打开数据库前执行可替换脚本；长选项和 `=` 形态也按 fail-closed 处理。
    if (/^--?init(?:=|$)/i.test(arg)) return true;
    // `-A ARGS` 等价于执行 `.archive ARGS`，归入同一个可变文件入口。
    if (/^-A(?:=|$)/.test(arg)) return true;

    // `.read` 等命令既可作为位置命令，也可由 `-cmd` 传入；两种形态最终都会消费
    // 可替换脚本、数据、扩展或 shell 程序。保留普通固定 SQL 与 `.open` 的精确摘要。
    const command = /^--?cmd=/i.test(arg) ? arg.slice(arg.indexOf('=') + 1) : arg;
    if (SQLITE_MUTABLE_DOT_COMMAND_PATTERN.test(command)) return true;
  }
  return false;
}

const PSQL_MUTABLE_FILE_META_COMMAND_PATTERN =
  /(?:^|[\r\n])\s*\\+(?:include_relative|include|ir|i)(?=\s|$)/;

function psqlArgumentMayLoadMutableFile(arg: string): boolean {
  let command = arg;
  if (arg.startsWith('--command=')) command = arg.slice('--command='.length);
  else if (arg.startsWith('-c') && arg.length > 2) command = arg.slice(2);
  // tokenize 会为 ANSI-C quote 保留 `$'` 标记；去掉标记后仍按同一元命令入口判定。
  if (command.startsWith("$'")) command = command.slice(2);
  return PSQL_MUTABLE_FILE_META_COMMAND_PATTERN.test(command);
}

function psqlMayLoadMutableUserState(args: readonly string[]): boolean {
  const optionTerminator = args.indexOf('--');
  const options = optionTerminator === -1 ? args : args.slice(0, optionTerminator);
  if (options.some((arg) =>
    arg === '-f'
    || (arg.startsWith('-f') && arg.length > 2)
    || arg === '--file'
    || arg.startsWith('--file='))) return true;
  // -c / --command 的独立值、紧凑值，以及位置命令都可能执行 \i / \ir 的文件输入。
  // 长别名 \include / \include_relative 走同一入口；文件内容变化后必须重新审核。
  if (args.some(psqlArgumentMayLoadMutableFile)) return true;
  // psql 默认读取系统级与用户级 psqlrc（含 PSQLRC 指定的位置）。只信任 `--` 前
  // 大小写精确的禁用选项；缩写、紧凑簇或终止符后的位置参数保持逐次审核。
  return !options.includes('-X') && !options.includes('--no-psqlrc');
}

function sqlcmdMayLoadMutableFileState(args: readonly string[]): boolean {
  const optionTerminator = args.indexOf('--');
  const options = optionTerminator === -1 ? args : args.slice(0, optionTerminator);
  // ODBC / Go 兼容入口都支持 -i FILE；sqlcmd 也接受无空格短选项和长选项等号/紧凑形态。
  return options.some((arg) =>
    arg.startsWith('--input-file')
    || /^-[^-]*i/.test(arg));
}

function mongoShellMayLoadMutableUserState(args: readonly string[]): boolean {
  const optionTerminator = args.indexOf('--');
  const options = optionTerminator === -1 ? args : args.slice(0, optionTerminator);
  // mongo / mongosh 默认执行用户目录中的启动脚本。只信任 `--` 前大小写精确的
  // --norc；缩写、近似拼写或位置参数中的同名文本都不能证明启动脚本已被禁用。
  if (!options.includes('--norc')) return true;
  // --file / -f 会直接执行可替换脚本；旧 mongo 与 mongosh 也都支持把 JavaScript
  // 文件作为位置参数传入。文件选项即使写在 `--` 后，也会由随后的位置脚本兜住。
  return args.some((arg) =>
    arg === '--file'
    || arg.startsWith('--file=')
    || arg === '-f'
    || (arg.startsWith('-f') && arg.length > 2)
    || /(?:^|[\\/])[^\\/]+\.(?:[cm]?js)$/i.test(arg));
}

const MYSQL_FAMILY_OPTION_FILE_CLIENTS: ReadonlySet<string> = new Set([
  'mysql', 'mysqladmin', 'mysqlcheck', 'mysqldump', 'mysqlimport', 'mysqlshow',
  'mysqlslap', 'mysqlpump', 'mysqlbinlog', 'mysql_upgrade', 'mysqltest',
  'mariadb', 'mariadb-admin', 'mariadb-check', 'mariadb-dump', 'mariadb-import',
  'mariadb-show', 'mariadb-slap', 'mariadb-binlog', 'mariadb-upgrade', 'mariadb-test',
]);

const MYSQL_MUTABLE_STARTUP_OPTION_PATTERN =
  /^--(?:defaults(?:(?:-extra)?-file|-group-suffix)|login-path|no-(?:defaults|login-paths))(?:=|$)/i;

function mysqlFamilyMayLoadMutableUserState(
  name: string,
  args: readonly string[],
): boolean {
  const optionTerminator = args.indexOf('--');
  const options = optionTerminator === -1 ? args : args.slice(0, optionTerminator);
  // MySQL 的 option-file 控制项必须先于普通参数。`.mylogin.cnf` 即使在 --no-defaults
  // 下仍会读取，因此 MySQL 名称只信任前两个参数按文档顺序精确关闭两类启动状态。
  // MariaDB 不支持 `.mylogin.cnf`，其原生命令只需首参数精确为 --no-defaults。
  const isMariaDbClient = name.startsWith('mariadb');
  if (options[0] !== '--no-defaults') return true;
  const disabledOptionCount = isMariaDbClient ? 1 : 2;
  if (!isMariaDbClient && options[1] !== '--no-login-paths') return true;

  // 显式 option file、group suffix 或 login path 会重新引入可变主机、凭证与其它行为。
  // 同时拒绝带值／紧凑的伪禁用形态，避免把 boolean 覆写误当成已隔离。
  return options.some((arg, index) => index >= disabledOptionCount
    && MYSQL_MUTABLE_STARTUP_OPTION_PATTERN.test(arg));
}

const SECRET_BEARING_PATTERNS: readonly RegExp[] = [
  // HTTP 鉴权头：curl/wget 的 -H、--header、--proxy-header，含空格/等号/紧凑短选项。
  /(?:^|\s)(?:-H\s*=?\s*|--(?:proxy-)?header(?:\s+|=))['"]?\s*(?:authorization|proxy-authorization|cookie|x-api-key|x-auth)/i,
  // curl 的 @file header/config 内容可在命令不变时换成新凭证，不能让旧摘要静默复用。
  /(?:^|[\s;&|('"`])(?:\S*[\\/])?curl(?:\.exe)?\b[^;&|\r\n]*(?:-H\s*=?\s*|--(?:proxy-)?header(?:\s+|=))['"]?@\S/i,
  CURL_EXPLICIT_CONFIG_PATTERN,
  // Wget 启动文件可注入鉴权头、代理凭证、URL 与落盘选项；显式文件同样不可长期记忆。
  WGET_EXPLICIT_CONFIG_PATTERN,
  // Wget 的协议专用密码、交互 askpass 与 cookie jar 都属于凭证消费/存储动作。
  /(?:^|[\s;&|('"`])(?:\S*[\\/])?wget(?:\.exe)?\b[^;&|\r\n]*(?:--(?:http|ftp|proxy)-pass[\w-]*(?:\s+|=)\S|--(?:ask-p|use-a)[\w-]*(?=\s|=|$)|--(?:load|save)-c[\w-]*(?:\s+|=)\S)/i,
  /\bbearer\s+[\w.\-~+/]{8,}/i,
  // 显式凭证 flag（含 = 与空格两种写法）。要求后面真有值，避免把 --auth-mode 误判。
  /(?:^|\s)--(?:token|password|passwd|api[-_]?key|secret|client[-_]?secret|access[-_]?token|session[-_]?token|oauth2[-_]?bearer|authorization|auth|credential|credentials|private[-_]?key|secret[-_]?access[-_]?key|access[-_]?key(?:[-_]?id)?)(?:\s+|=)\S/i,
  // 凭证值来自 stdin / file 时命令行没有秘密明文，但该动作仍在消费凭证，不能长期记忆。
  /(?:^|\s)--(?:token|password|passwd|api[-_]?key|secret|client[-_]?secret|access[-_]?token|session[-_]?token|credential|credentials|private[-_]?key)(?:[-_](?:stdin|file|path))(?:\s|=|$)/i,
  // curl/wget 的 user:password、proxy user，以及 cookie/session 参数。
  /(?:^|\s)(?:-u\s*=?\s*|--(?:proxy-)?user(?:\s+|=))\S+:\S/i,
  /(?:^|\s)(?:-b\s*=?\s*|--cookie(?:\s+|=))\S/i,
  // 客户端证书 / 私钥 / identity file 同样是凭证消费。短选项与 `--key` 必须限定工具，
  // 避免误伤 sort --key、通用 -i 输入等无关参数；CA / 公钥证书也不在这里泛化拦截。
  /(?:^|[\s;&|('"`])(?:\S*[\\/])?curl(?:\.exe)?\b[^;&|\r\n]*(?:--(?:expand-)?(?:cert|key|httpsig-key|proxy-cert|proxy-key|pass|proxy-pass|netrc-file)(?:\s+|=)\S|-E(?:\s*=?\s*)\S)/i,
  /(?:^|[\s;&|('"`])(?:\S*[\\/])?curl(?:\.exe)?\b[^;&|\r\n]*(?:--netrc(?:-optional)?|--ssl-auto-client-cert|-n)(?=\s|$)/i,
  /(?:^|[\s;&|('"`])(?:\S*[\\/])?(?:ssh|scp|sftp|ssh-copy-id|plink|pscp|psftp)(?:\.exe)?(?=\s|$)[^;&|\r\n]*(?:-i(?:\s*=?\s*)\S|-o\s*(?:IdentityFile|CertificateFile|PKCS11Provider|SecurityKeyProvider)\s*=\s*\S|-o\s*ForwardAgent\s*=\s*(?:yes|true|on)\b)/i,
  /(?:^|[\s;&|('"`])(?:\S*[\\/])?(?:ssh-add|sshpass)(?:\.exe)?(?=\s|$)/i,
  /(?:^|[\s;&|('"`])(?:\S*[\\/])?openssl(?:\.exe)?\s+s_client\b[^;&|\r\n]*\s-(?:cert|key|pass)(?:\s+|=)\S/i,
  /(?:^|[\s;&|('"`])(?:\S*[\\/])?wget(?:\.exe)?\b[^;&|\r\n]*\s--certificate(?:\s+|=)\S/i,
  /(?:^|[\s;&|('"`])(?:\S*[\\/])?kubectl(?:\.exe)?\b[^;&|\r\n]*\s--client-(?:certificate|key)(?:\s+|=)\S/i,
  /(?:^|[\s;&|('"`])(?:\S*[\\/])?grpcurl(?:\.exe)?\b[^;&|\r\n]*\s-(?:cert|key)(?:\s+|=)\S/i,
  /(?:^|[\s;&|('"`])(?:\S*[\\/])?(?:http|https|httpie)(?:\.exe)?\b[^;&|\r\n]*\s--(?:cert|cert-key)(?:\s+|=)\S/i,
  /(?:^|[\s;&|('"`])(?:\S*[\\/])?docker(?:\.exe)?\b[^;&|\r\n]*\s--tls(?:cert|key)(?:\s+|=)\S/i,
  /(?:^|[\s;&|('"`])(?:DOCKER_CERT_PATH|GIT_SSL_(?:CERT|KEY)|PGSSL(?:CERT|KEY))\s*=\s*\S/i,
  /(?:^|[\s;&|('"`])(?:\S*[\\/])?git(?:\.exe)?\b[^;&|\r\n]*(?:-c\s+http\.ssl(?:cert|key)\s*=|config\b[^;&|\r\n]*\shttp\.ssl(?:cert|key)(?:\s+|=))\S/i,
  // URL userinfo：https://user:password@example.com/…
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  // shell 赋值、URL query、表单、JSON 与嵌套 flag 值。大小写均不可记忆。
  new RegExp(
    String.raw`(?:^|[=\s?&;,:{|'\"])${SECRET_ENV_NAME_SOURCE}['"]?\s*(?:=|:)\s*['"]?\S`,
    'i',
  ),
  // PowerShell 与 cmd 的等价环境变量写法。
  new RegExp(String.raw`\$env:${SECRET_ENV_NAME_SOURCE}\s*=\s*\S`, 'i'),
  new RegExp(String.raw`(?:^|[\s;&|'"])setx?\s+${SECRET_ENV_NAME_SOURCE}\s+\S`, 'i'),
  // config/set 的凭证 key 与 value 是位置参数，不一定出现等号。
  new RegExp(
    String.raw`\b(?:npm|pnpm|yarn|gcloud)(?:\.cmd|\.exe)?\s+config\s+set\s+${SECRET_CONFIG_KEY_SOURCE}\s+\S`,
    'i',
  ),
  new RegExp(
    String.raw`\baws(?:\.exe)?\s+configure\s+set\s+${SECRET_CONFIG_KEY_SOURCE}\s+\S`,
    'i',
  ),
  // 凭证存储写入即使从 stdin/file 取值也不记忆；key 可以是任意业务名，不能只看 password。
  /\bkubectl(?:\.exe)?\s+(?:create|patch|replace)\s+secret\b/i,
  /\baws(?:\.exe)?\s+secretsmanager\s+(?:create-secret|put-secret-value|update-secret)\b/i,
  /\bgcloud(?:\.cmd|\.exe)?\s+secrets\s+(?:create|versions\s+add)\b/i,
  /\baz(?:\.cmd|\.exe)?\s+keyvault\s+secret\s+set\b/i,
  /\b(?:gh|glab)(?:\.exe)?\s+secret\s+set\b/i,
  /\bkubectl(?:\.exe)?\s+config\s+set-credentials\b/i,
  /\bgit(?:\.exe)?\s+credential(?:-[\w.-]+)?\s+(?:fill|approve|reject|store|erase|get)\b/i,
  // 交互式 / stdin 登录本身就是凭证消费动作；即使看不到值也必须每次重新判定。
  /(?:^|[\s;&|])(?:\S*[\\/])?(?:docker|podman|buildah|nerdctl|skopeo|oras)(?:\.exe)?\s+(?:login|logout)\b/i,
  /(?:^|[\s;&|])(?:\S*[\\/])?helm(?:\.exe)?\s+registry\s+(?:login|logout)\b/i,
  /(?:^|[\s;&|])(?:\S*[\\/])?(?:gh|glab)(?:\.exe)?\s+auth\s+(?:login|logout|refresh|token)\b/i,
  /(?:^|[\s;&|])(?:\S*[\\/])?(?:npm|pnpm)(?:\.cmd|\.exe)?\s+(?:login|adduser)\b/i,
  /(?:^|[\s;&|])(?:\S*[\\/])?yarn(?:\.cmd|\.exe)?\s+npm\s+login\b/i,
  /(?:^|[\s;&|])(?:\S*[\\/])?gcloud(?:\.cmd|\.exe)?\s+auth\b/i,
  /(?:^|[\s;&|])(?:\S*[\\/])?az(?:\.cmd|\.exe)?\s+(?:login|logout|account\s+get-access-token)\b/i,
  /(?:^|[\s;&|])(?:\S*[\\/])?aws(?:\.exe)?\s+(?:sso\s+login|ecr(?:-public)?\s+get-login-password)\b/i,
  // 工具专用的短凭证选项。限定可执行文件/子命令，避免把 docker -p 端口等误判。
  /(?:^|[\s;&|])(?:\S*[\\/])?(?:mysql|mysqladmin|mariadb|mariadb-admin|mongo|mongosh|sqlcmd|sshpass)(?:\.exe)?\b[^;&|\r\n]*\s-p\s*=?\s*\S/i,
  // SQLite 加密构建的 CLI key 参数直接携带凭证；限定 sqlite3，避免误伤通用 `-key`。
  /(?:^|[\s;&|])(?:\S*[\\/])?sqlite3(?:\.exe)?\b[^;&|\r\n]*\s-(?:hexkey|key|textkey)(?:\s+|=)\S/i,
  // MySQL/MariaDB option files 与 login paths 可在命令不变时换入新凭证；只限定数据库
  // 客户端工具，避免误伤其它程序的通用 --defaults-file / --login-path 参数。
  /(?:^|[\s;&|])(?:\S*[\\/])?(?:mysql|mysqladmin|mysqlcheck|mysqldump|mysqlimport|mysqlshow|mysqlslap|mysqlpump|mariadb|mariadb-admin|mariadb-check|mariadb-dump|mariadb-import|mariadb-show|mariadb-slap)(?:\.exe)?\b[^;&|\r\n]*(?:--defaults-(?:(?:extra-)?file|group-suffix)|--login-path)(?:\s+|=)\S/i,
  /(?:^|[\s;&|])(?:\S*[\\/])?(?:mysql_config_editor|mariadb_config_editor)(?:\.exe)?\s+(?:set|remove|reset|print)\b/i,
  /(?:^|[\s;&|]|\$env:)(?:MYSQL|MARIADB)_PWD\s*=\s*\S/i,
  /(?:^|[\s;&|'"`])setx?\s+(?:MYSQL|MARIADB)_PWD(?:\s+|=)\S/i,
  /(?:^|[\s;&|])(?:\S*[\\/])?redis-cli(?:\.exe)?\b[^;&|\r\n]*\s-a\s*=?\s*\S/i,
  /(?:^|[\s;&|])(?:\S*[\\/])?(?:docker|podman)(?:\.exe)?\s+login\b[^;&|\r\n]*\s-p\s*=?\s*\S/i,
  // 常见密钥字面量前缀。形态与 Desktop log-upload/redact.ts 的独立凭证清单保持对齐；
  // 这里宁可多做一次 review，也不能让脱敏器已认定为凭证的字面量进入长期批准记忆。
  /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[abposr]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|LTAI[A-Za-z0-9]{12,}|AIza[0-9A-Za-z_-]{35})/,
];

export function isCredentialBearingCommand(command: string): boolean {
  return SECRET_BEARING_PATTERNS.some((re) => re.test(command));
}

/**
 * 行为会由工作区内可变文件间接定义的 executable。
 *
 * 不能只 hash `package.json` 或入口脚本：任务还可继续 source/import 其它文件，任何单层摘要
 * 都会留下同一条外层命令静默复用旧批准的缺口。这里宁可让这些命令每次重审，也不承诺一条
 * 无法完整绑定其执行内容的长期批准。
 */
const MUTABLE_INDIRECT_EXECUTABLES: ReadonlySet<string> = new Set([
  // package/runtime wrappers
  'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'corepack', 'bun', 'bunx', 'deno',
  // shells and language interpreters
  'sh', 'bash', 'dash', 'zsh', 'fish', 'ksh', 'csh', 'tcsh',
  'cmd', 'powershell', 'pwsh', 'node', 'tsx', 'ts-node', 'ts-node-esm',
  'nodejs', 'python', 'py', 'pyw', 'pypy', 'ruby', 'perl', 'php', 'lua',
  // program-file interpreters: unchanged argv can load a replaced script with new side effects
  'awk', 'gawk', 'mawk', 'nawk', 'sed', 'r', 'rscript', 'julia', 'tclsh', 'wish',
  'expect', 'osascript', 'cscript', 'wscript', 'groovy', 'scala', 'clojure', 'bb',
  'elixir', 'escript', 'guile', 'racket', 'sbcl', 'clisp', 'ocaml', 'runghc',
  'runhaskell', 'swift', 'dart', 'dotnet-script', 'fsi', 'csi',
  // shell builtins/operators that execute a following script, command, or string
  '.', 'source', 'eval', 'exec', 'command', 'builtin', 'call',
  'start', 'iex', 'invoke-expression', 'start-process', 'saps',
  'invoke-command', 'icm', 'start-job', 'sajb', 'start-threadjob',
  // launchers and remote clients whose unchanged argv can be redirected by user config/session state
  'xargs', 'parallel', 'find',
  'ssh', 'scp', 'sftp', 'ssh-copy-id', 'plink', 'pscp', 'psftp', 'rsync',
  'http', 'https', 'httpie',
  'docker', 'podman', 'nerdctl', 'kubectl',
  'chroot', 'nsenter', 'unshare', 'systemd-run', 'wsl', 'winrs',
  // archive readers/extractors: unchanged argv can apply replaced member paths and contents
  'tar', 'gtar', 'bsdtar', 'unzip', '7z', '7zz', '7za', 'unrar', 'unar',
  'cabextract', 'cpio',
  // file copy/install primitives: an unchanged source pathname can resolve to replaced bytes
  // (or a different symlink/reparse target) and therefore change the write performed by the call.
  'cp', 'install', 'mv', 'ln', 'dd',
  'copy', 'move', 'xcopy', 'robocopy',
  'copy-item', 'move-item',
  // aliases/extensions/config can redirect these stable-looking commands into project code
  'git', 'gh', 'glab',
  // project task/build/test runners
  'make', 'gmake', 'just', 'task', 'cargo', 'go', 'gradle', 'gradlew', 'mvn', 'mvnw',
  'ant', 'dotnet', 'java', 'cmake', 'ctest', 'ninja', 'meson', 'bazel', 'bazelisk',
  'buck', 'buck2', 'scons', 'pytest', 'vitest', 'jest', 'mocha', 'ava', 'playwright',
  'tox', 'nox', 'composer', 'bundle', 'rake', 'pip', 'pip3', 'uv', 'poetry', 'pdm',
  'pipenv', 'vite', 'webpack', 'rollup', 'gulp', 'grunt', 'parcel', 'rspack', 'rsbuild',
  'turbo', 'nx', 'lerna', 'xcodebuild', 'msbuild', 'xbuild', 'nmake',
  // infrastructure/configuration runners: stable argv can load entirely replaced local manifests
  'terraform', 'tofu', 'terragrunt', 'packer', 'pulumi', 'vagrant',
  'ansible', 'ansible-playbook', 'ansible-pull', 'ansible-console',
  'helm', 'kustomize', 'docker-compose', 'podman-compose',
  // cloud CLIs expose many file-driven deployment surfaces (templates, policies, payloads);
  // enumerating individual subcommands/flags would leave the next service alias as a bypass.
  'aws', 'gcloud', 'az',
  'serverless', 'sls', 'sam', 'cdk', 'cdktf', 'sst', 'nomad',
]);

const MUTABLE_EXECUTION_ENV_PATTERN =
  /(?:^|[\s;&|('"`])(?:\$env:)?(?:PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH)\s*=/i;

/**
 * 文本相同、运行时取值却可变化的 shell 展开。
 *
 * 这里有意不尝试按引号做 shell 方言解析：同一段文本可能先经过宿主 shell，再作为
 * PowerShell/cmd/SSH 等下层解释器的参数。误把某层看似被引号保护的 `$VAR` 当成字面量，
 * 会让后续环境变量、命令替换或参数文件改变真实 argv，却继续命中旧批准。宁可多审一次。
 */
const DYNAMIC_COMMAND_INPUT_PATTERNS: readonly RegExp[] = [
  // POSIX shell 与 PowerShell：变量、参数、命令/算术/子表达式展开。
  /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}\r\n]+\}|\(|[0-9@*#?$!_-])/,
  // POSIX 命令替换与进程替换。
  /`[^`\r\n]*`/,
  /[<>]\(/,
  // cmd.exe 的普通、位置与 delayed-expansion 变量。
  /%(?:[A-Za-z_][A-Za-z0-9_]*(?::[^%\r\n]*)?%|~[A-Za-z0-9$:*~-]*[0-9]|[0-9*])|![A-Za-z_][A-Za-z0-9_]*(?::[^!\r\n]*)?!/,
  /\bfor\s+%%?~?[A-Za-z]\b/i,
  // PowerShell splatting；也保守覆盖 @file、@./file、@../file、绝对路径及带引号
  // response/request-body 文件。`=` 覆盖 --flag=@path 形态。
  /(?:^|[\s,;('"=])@(?![({])(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s;&|,)]+)/,
  // shell/cmd 的 stdin、here-doc 与 here-string 重定向。操作符可紧贴前一个命令词
  // (`psql<input.sql`)，也可带显式文件描述符 (`3<input.sql`)；不能要求左侧边界。
  // fd 复制 (`<&3`) 同样依赖可变输入。进程替换 <(...) 已由上面的独立规则覆盖。
  /\d*<{1,3}\s*(?!\()(?:"[^"\r\n]+"|'[^'\r\n]+'|&(?:\d+|-)|[^\s;&|]+)/,
];

/** 引号与命令/进程替换感知地识别真正由管道接收 stdin 的目标 invocation。 */
function hasPipedInvocation(command: string, executableName: string): boolean {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  let substitutionDepth = 0;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && !singleQuoted) { escaped = true; continue; }
    if (char === "'" && !doubleQuoted) { singleQuoted = !singleQuoted; continue; }
    if (char === '"' && !singleQuoted) { doubleQuoted = !doubleQuoted; continue; }
    if (singleQuoted || doubleQuoted) continue;
    if (char === '#' && (i === 0 || /[\s;|&(]/.test(command[i - 1] ?? ''))) {
      const newline = command.indexOf('\n', i);
      if (newline === -1) break;
      i = newline - 1;
      continue;
    }
    if ((char === '$' || char === '<' || char === '>') && command[i + 1] === '(') {
      substitutionDepth += 1;
      i++;
      continue;
    }
    if (substitutionDepth > 0) {
      if (char === '(') substitutionDepth += 1;
      else if (char === ')') substitutionDepth -= 1;
      continue;
    }
    if (char === '|' && command[i - 1] !== '|' && command[i + 1] !== '|') {
      const separatorLength = command[i + 1] === '&' ? 2 : 1;
      const suffix = command.slice(i + separatorLength).replace(/^[\s({]+/, '');
      if (commandExecutableInvocations(suffix)[0]?.name === executableName) return true;
      i += separatorLength - 1;
    }
  }
  return false;
}

export function isMutableIndirectExecutionCommand(command: string): boolean {
  if (MUTABLE_EXECUTION_ENV_PATTERN.test(command)) return true;
  if (DYNAMIC_COMMAND_INPUT_PATTERNS.some((pattern) => pattern.test(command))) return true;
  const invocations = commandExecutableInvocations(command);
  if (invocations.some(({ name, args }) =>
    name === 'curl' && curlMayLoadMutableFileState(args))) return true;
  if (invocations.some(({ name, args }) =>
    name === 'wget' && wgetMayLoadMutableUserState(args))) return true;
  if (invocations.some(({ name, args }) =>
    // SQLite shell 会把 stdin 当 SQL / dot command 执行。只看 sqlite3 自身 argv 会漏掉
    // `cat deploy.sql | sqlite3 prod.db`：命令文本没变，上游文件内容却可替换。
    name === 'sqlite3' && (hasPipedInvocation(command, 'sqlite3')
      || sqliteMayLoadMutableFileState(args)))) {
    return true;
  }
  if (invocations.some(({ name, args }) =>
    // 默认 psqlrc、`psql -f FILE` 与管道 stdin 都会让同一 argv 执行可替换的外部 SQL。
    name === 'psql' && (hasPipedInvocation(command, 'psql')
      || psqlMayLoadMutableUserState(args)))) return true;
  if (invocations.some(({ name, args }) =>
    // sqlcmd 的 -i/--input-file 与 stdin 管道都会把可替换 SQL 送入数据库执行。
    name === 'sqlcmd' && (hasPipedInvocation(command, 'sqlcmd')
      || sqlcmdMayLoadMutableFileState(args)))) return true;
  if (invocations.some(({ name, args }) =>
    // mongo / mongosh 默认加载可替换的用户启动脚本；只有显式 --norc 才可稳定复用。
    (name === 'mongo' || name === 'mongosh')
    && mongoShellMayLoadMutableUserState(args))) return true;
  if (invocations.some(({ name, args }) =>
    MYSQL_FAMILY_OPTION_FILE_CLIENTS.has(name)
    && mysqlFamilyMayLoadMutableUserState(name, args))) return true;
  if (commandUsesExplicitExecutablePath(command)) return true;
  return invocations.some(({ name: rawName }) => {
    // 未建模的 wrapper option（例如 env -S/--split-string）代表真实 executable 仍不可见。
    if (rawName.startsWith('-')) return true;
    if (/\.(?:cmd|bat)$/i.test(rawName)) return true;
    const name = rawName.replace(/\.(?:exe|cmd|bat)$/i, '');
    return MUTABLE_INDIRECT_EXECUTABLES.has(name)
      || /^(?:node|nodejs|python|pypy|ruby|perl|php|lua)\d+(?:\.\d+)*$/.test(name);
  });
}

/**
 * 动作 → 记忆签名。返回 `null` = **不可记忆**,调用方必须逐次走原有判定。
 *
 * 只有 `exec`(bash 命令)进入记忆:它是重复率最高、也最容易逐字比对的动作。
 * `file-write` / `read` / `network` / `other` 不记 —— 路径类动作的「同一件事」判据
 * (同目录?同文件?同 glob?)本身就是产品决策,MCP/未知工具则连稳定的身份都没有,
 * 逐字记住一个 JSON 序列化串既没有复用价值,又容易被入参里的无关字段搅乱。
 */
export function approvalSignature(
  action: ReviewableAction,
  agentKind: AgentKind,
  workspaceKey: string,
  workspaceRoots: readonly string[],
  userIntent: string,
  reviewerRoute: AutoReviewRouteIdentity,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (action.kind !== 'exec') return null;
  const command = action.command ?? '';
  if (!command.trim()) return null;
  // 显式空白 cwd 与 cwdUnknown 都表示执行目录无法确定。命令逐字相同也可能落在不同项目，
  // 不能把一次 allow 复用到一个未知目录；未提供 cwd 则仍按 harness 的会话工作目录契约处理。
  if (action.cwdUnknown === true || (action.cwd !== undefined && !action.cwd.trim())) return null;
  // provider 缺失时，实际 reviewer 仍可能由宿主目录按 model 推断。未解析到最终 provider
  // 就不能查/存：同名 model 后续改由另一 provider 提供时，旧批准不得直接命中。
  const reviewerProviderId = reviewerRoute.providerId?.trim();
  const reviewerModel = reviewerRoute.model.trim();
  if (!reviewerProviderId || !reviewerModel) return null;
  // 凭证动作不进记忆:即使落盘只存摘要,凭证会轮换,这类授权也不适合长期复用。
  if (isCredentialBearingCommand(command)) return null;
  // 外层 argv 没变不代表执行内容没变：项目脚本、任务定义、解释器入口或显式路径文件都可能
  // 在两次调用之间被替换。无法可靠绑定完整执行闭包时，保持逐次审核。
  if (isMutableIndirectExecutionCommand(command)) return null;
  // 红线永不记忆:确定性高危动作必须逐次确认。这里用与 dispatcher 同一份 core 判定,
  // 而不是让调用方自己判 —— 调用方漏判就是一条静默的记忆型提权路径。
  const tier = classifyLocalAutoReviewTier({
    agentKind,
    model: '',
    userIntent: '',
    action,
    workspaceRoots: [...workspaceRoots],
    platform,
  });
  if (tier === 'prompt-each-time') return null;
  // 只持久化固定长度摘要,不把命令、路径、URL 或其它用户数据的明文复制进 userData。
  // SHA-256 不是保密存储：知道完整候选输入的人仍可做匹配；文件权限仍由宿主收紧。
  // 命令与 cwd 保持逐字精确:空白在引号和 heredoc 中可能改变语义,不得折叠。
  const payload = JSON.stringify({
    version: 3,
    agentKind,
    reviewerRoute: {
      providerId: reviewerProviderId,
      model: reviewerModel,
    },
    workspaceKey,
    workspaceRoots,
    platform,
    userIntent,
    command,
    cwd: action.cwd ?? null,
  });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

export function createApprovalMemory(opts: ApprovalMemoryOptions): ApprovalMemory {
  const {
    agentKind, workspaceKey, platform = process.platform, store, logger, onInvalidated,
  } = opts;
  const remembered = new Set<string>();
  let generation = 0;
  let disposed = false;
  const unsubscribeClear = store?.subscribeClear?.((clearedWorkspaceKey) => {
    if (clearedWorkspaceKey !== undefined && clearedWorkspaceKey !== workspaceKey) return;
    // Clear is a revocation boundary, not just a disk maintenance operation. Invalidate the
    // private session cache synchronously so an already-running harness cannot keep hitting an
    // approval the user just removed.
    remembered.clear();
    generation += 1;
    onInvalidated?.();
  });
  const currentTier = (
    action: ReviewableAction,
    userIntent: string,
    workspaceRoots: readonly string[],
  ) => classifyLocalAutoReviewTier({
    agentKind,
    model: '',
    userIntent,
    action,
    workspaceRoots: [...workspaceRoots],
    platform,
  });
  const signatureOf = (
    action: ReviewableAction,
    userIntent: string,
    workspaceRoots: readonly string[],
    reviewerRoute: AutoReviewRouteIdentity,
  ): string | null => approvalSignature(
    action,
    agentKind,
    workspaceKey,
    workspaceRoots,
    userIntent,
    reviewerRoute,
    platform,
  );

  const recordRaw = (
    signature: string,
    origin: ApprovalMemoryOrigin,
    expectedGeneration: number,
  ): void => {
    if (disposed || expectedGeneration !== generation) return;
    if (remembered.has(signature)) return;
    if (remembered.size >= MAX_SESSION_SIGNATURES) {
      const oldest = remembered.values().next().value as string | undefined;
      if (oldest) remembered.delete(oldest);
    }
    remembered.add(signature);
    // 持久化是 best-effort:宿主存储故障不影响本次会话已经生效的记忆。
    try {
      store?.add(workspaceKey, signature, origin);
    } catch (err) {
      logger?.debug('approval memory persist failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
  const record = (
    action: ReviewableAction,
    userIntent: string,
    workspaceRoots: readonly string[],
    reviewerRoute: AutoReviewRouteIdentity,
    origin: ApprovalMemoryOrigin,
    expectedGeneration: number,
  ): void => {
    const signature = signatureOf(action, userIntent, workspaceRoots, reviewerRoute);
    if (signature === null) return;
    recordRaw(signature, origin, expectedGeneration);
  };

  return {
    isRemembered(action, userIntent, workspaceRoots, reviewerRoute) {
      // 红线 / 带凭证的命令在这里就返回 null,两条路径都进不去。
      const signature = signatureOf(action, userIntent, workspaceRoots, reviewerRoute);
      if (signature === null) return false;
      return remembered.has(signature);
    },
    rememberReviewerAllow(
      action,
      userIntent,
      workspaceRoots,
      reviewerRoute,
      expectedGeneration = generation,
    ) {
      if (disposed || expectedGeneration !== generation) return;
      // 静态 auto-approve 不需要记忆；只有真的经过轻量审阅器的灰区 allow 才持久化。
      if (currentTier(action, userIntent, workspaceRoots) !== 'needs-review') return;
      record(
        action,
        userIntent,
        workspaceRoots,
        reviewerRoute,
        'reviewer',
        expectedGeneration,
      );
    },
    async hydrate() {
      if (!store || disposed) return;
      const hydrateGeneration = generation;
      try {
        const persisted = await store.load(workspaceKey);
        // A clear may arrive while the file is loading. Never merge a pre-clear snapshot back
        // into the session cache after the revocation boundary.
        if (disposed || hydrateGeneration !== generation) return;
        for (const signature of persisted) {
          if (remembered.size >= MAX_SESSION_SIGNATURES) break;
          remembered.add(signature);
        }
      } catch (err) {
        // 载入失败只意味着「这次没有跨会话记忆」,不改变任何放行判定。
        logger?.debug('approval memory hydrate failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    getGeneration() {
      return generation;
    },
    isGenerationCurrent(candidateGeneration: number) {
      return !disposed && candidateGeneration === generation;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeClear?.();
      remembered.clear();
      generation += 1;
      onInvalidated?.();
    },
    size() {
      return remembered.size;
    },
  };
}
