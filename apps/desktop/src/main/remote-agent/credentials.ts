/**
 * 供应商分享的受邀者任务里「凭证类」的判定(控制端)。
 *
 * 受邀者任务的对话与 Agent 读到的文件内容会经过分享者的电脑。凭证类文件(密钥、.env、云与工具的
 * 登录凭证)不论权限档，都要受邀者在本机确认后才发出：启动时不随项目说明同步，任务中读取时弹确认卡，
 * 可明确允许当前任务后续的凭证操作；切换权限档或退出应用后恢复确认
 * (docs/product-rules/provider-sharing.md §9 第 7 条)。
 *
 * 规则沿用本机任务的凭证规则(isSensitiveCredentialPath)，以下几处不同，都只在这里生效，本机任务不变：
 *  - Claude Code / Codex 配置目录里的说明类内容(Skill、子代理、命令、规则、个人说明)不算凭证。本机规则
 *    把整个配置目录算作敏感，是为了保护里面的登录与设置，不是这些说明文字；不放开的话，个人 Skill 的
 *    每个参考文件都要确认；
 *  - 按惯例不含密钥的 .env 模板(.env.example / .env.sample / .env.template)与公钥(*.pub)不算凭证，
 *    所在目录本身是凭证目录(~/.ssh 等)时照旧算；
 *  - rg -g、grep --include 这类只选中源码与文档扩展名的搜索不算读取凭证；
 *  - git 查看内容又没有限定到具体文件的命令、会打出 git 配置的命令交给执行器在本机核实
 *    (executor/gitCredentials.ts)；
 *  - 再收紧：命令里直接写着密钥(带密码的地址、令牌、私钥)、用 `<提交>:<路径>` 写出凭证类文件、
 *    git credential fill 这类打出保存的凭证的命令也要确认。
 */
import {
  isSensitiveCredentialPath,
  shellCommandReadsCredentials,
  type CredentialCommandOptions,
  type GitRead,
} from '@cindy/maker-core';

/** 配置目录里的说明类子路径：`/.claude/skills/…`、`/.codex/AGENTS.md` 等(两种分隔符都认)。 */
const CONFIG_INSTRUCTION_SEGMENT =
  /([\\/])\.(claude|codex)(?=[\\/](?:(?:skills|agents|commands|rules|prompts)(?:[\\/]|$|[^\w.-])|(?:CLAUDE|AGENTS)(?:\.override)?\.md(?![\w.-])))/gi;

/** 路径或命令里的 `..` 段：可能借说明目录绕回配置目录本身(`~/.claude/skills/../settings.json`)。 */
const PARENT_SEGMENT = /(^|[\\/\s'"=])\.\.(?=[\\/\s'"]|$)/;

/** 本机规则只在特定目录下认的登录文件，放开配置目录后在说明目录里也要认。 */
const LOGIN_FILE = /(?:^|[\\/])(?:auth|\.credentials)\.json$/i;

/**
 * 按惯例不含密钥的文件名(整个文件名)：.env 模板与公钥。前面是开头、路径分隔符或 shell 分隔符，后面是
 * 结尾或 shell 分隔符；`.env.example.local`、`id_rsa.pub.bak` 这类不算。
 */
const NON_SECRET_FILE_NAME =
  /(^|[\\/\s'"=:<>|;&(])(?:\.env\.(?:example|sample|template)|[^\\/\s'"=:<>|;&()]*\.pub)(?=$|[\s'"|;&()<>])/gi;

type ShareCommandOptions = Pick<CredentialCommandOptions, 'cwd' | 'platform'> & {
  resolveFilePath?: (operand: string, cwd: string) => string;
};

function credentialCommandOptions(opts: ShareCommandOptions): CredentialCommandOptions {
  const { resolveFilePath, ...shellOptions } = opts;
  const commandOptions = { ...shellOptions, ripgrepConfigActive: process.env.RIPGREP_CONFIG_PATH !== undefined };
  if (!resolveFilePath) return { ...commandOptions, sourceFileSelectors: true };
  let checkedPaths = 0;
  return {
    ...commandOptions,
    sourceFileSelectors: true,
    credentialTextTransform: shareCredentialText,
    fileReadRequiresConsent: ({ operand, cwd, priorSegmentsMayMutate }) => {
      checkedPaths += 1;
      if (!cwd || priorSegmentsMayMutate || checkedPaths > 64 || PARENT_SEGMENT.test(operand)
        || operand.includes(String.fromCharCode(92)) || /^~[^/]/.test(operand)
        || /[$\x60*?{}\[\]]/.test(operand)) return true;
      if (isShareCredentialPath(operand)) return true;
      try {
        return isShareCredentialPath(resolveFilePath(operand, cwd));
      } catch {
        return true;
      }
    },
  };
}

/**
 * 换掉配置目录里说明类子路径的目录名，和按惯例不含密钥的文件名，让本机凭证规则不再因为它们命中；
 * 所在目录的名字不动(~/.ssh/id_rsa.pub 照旧因为 .ssh 命中)。
 */
function shareCredentialText(text: string): string {
  const withoutInstructionDirs = PARENT_SEGMENT.test(text) ? text : text.replace(CONFIG_INSTRUCTION_SEGMENT, '$1_$2');
  return withoutInstructionDirs.replace(NON_SECRET_FILE_NAME, '$1_');
}

/**
 * 命令里直接写着的密钥：带密码的地址(`https://用户:密码@`)、当用户名放进 http 地址的长令牌、Authorization
 * 头的取值、常见服务的令牌格式与私钥。用 `$变量` 写的已按令牌类环境变量算。
 */
const LITERAL_SECRET_PATTERNS: readonly RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"$]+:[^\s/@'"$]+@/i,
  /\bhttps?:\/\/[A-Za-z0-9_-]{20,}@/i,
  /\bauthorization:\s*(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{36}|AIza[0-9A-Za-z_-]{35}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/,
  /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/**
 * git 的 `<提交>:<路径>` 写法(含 scp 式地址 `host:路径`)：路径紧跟冒号，本机规则认不出 `HEAD:.aws/credentials`、
 * `HEAD:.npmrc` 这类以点开头的名字，单独取出路径再判。
 */
const COLON_PATH = /[\w.@{}~^/-]:([^\s'"|;&<>()]+)/g;

/** 文本里直接写着密钥(命令、git 配置项等)。 */
export function textSpellsOutSecret(text: string): boolean {
  return LITERAL_SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/** 命令文本里直接写着密钥，或用 `<提交>:<路径>` 写出了凭证类文件。 */
function commandSpellsOutSecret(command: string): boolean {
  if (textSpellsOutSecret(command)) return true;
  for (const match of command.matchAll(COLON_PATH)) {
    if (isShareCredentialPath(`/${match[1]}`)) return true;
  }
  return false;
}

/** 路径是否为凭证类文件(调用方对链接目标的真实路径也要各判一次)。 */
export function isShareCredentialPath(target: string): boolean {
  if (typeof target !== 'string' || !target) return false;
  return isSensitiveCredentialPath(shareCredentialText(target)) || LOGIN_FILE.test(target);
}

/** 打出保存的登录凭证(git credential fill 与 credential-* 助手)：一律要确认，不交给核实。 */
function printsStoredCredentials(read: GitRead): boolean {
  return read.sub === 'credential' || read.sub.startsWith('credential-');
}

/**
 * 命令是否读取、打出或直接写着凭证(可由执行器核实文件目标；脚本文件里读的、编码后再解开的认不出来)。会打出 git
 * 配置的命令(git remote -v、git config --list 等)也算，配置里没有密钥时由执行器核实后放行。
 */
export function isShareCredentialCommand(
  command: string,
  workspaceRoots: string[],
  opts: ShareCommandOptions = {},
): boolean {
  return commandSpellsOutSecret(command)
    || shellCommandReadsCredentials(opts.resolveFilePath ? command : shareCredentialText(command), workspaceRoots, {
      ...credentialCommandOptions(opts),
      gitContentRead: () => false,
      gitConfigRead: () => false,
    });
}

/**
 * 命令要按凭证确认、但只是因为 git 查看内容又没有限定到具体文件(git diff、git log -p 等)，或会打出 git
 * 配置(git remote -v、git config --list 等)时，返回这些 git 调用，由执行器在本机核实；还有别的原因
 * (包括 git credential fill 这类直接打出保存的凭证)、或本来就不用确认时返回 null。
 */
export function shareCredentialGitReads(
  command: string,
  workspaceRoots: string[],
  opts: ShareCommandOptions = {},
): GitRead[] | null {
  if (commandSpellsOutSecret(command)) return null;
  const reads: GitRead[] = [];
  const collect = (read: GitRead) => {
    reads.push(read);
    return true;
  };
  const needsConsent = shellCommandReadsCredentials(opts.resolveFilePath ? command : shareCredentialText(command), workspaceRoots, {
    ...credentialCommandOptions(opts),
    gitContentRead: collect,
    gitConfigRead: (read) => !printsStoredCredentials(read) && collect(read),
  });
  return needsConsent || reads.length === 0 ? null : reads;
}
