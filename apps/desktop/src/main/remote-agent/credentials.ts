/**
 * 供应商分享的受邀者任务里「凭证类」的判定(控制端)。
 *
 * 受邀者任务的对话与 Agent 读到的文件内容会经过分享者的电脑。凭证类文件(密钥、.env、云与工具的
 * 登录凭证)不论权限档，都要受邀者在本机确认后才发出：启动时不随项目说明同步，任务中读取时弹确认卡
 * (docs/product-rules/provider-sharing.md §9 第 7 条)。
 *
 * 规则沿用本机任务的凭证规则(isSensitiveCredentialPath)，只有一处不同：Claude Code / Codex 配置目录里
 * 的说明类内容(Skill、子代理、命令、规则、个人说明)不算凭证。本机规则把整个配置目录算作敏感，是为了
 * 保护里面的登录与设置，不是这些说明文字；不放开的话，个人 Skill 的每个参考文件都要确认。
 */
import { isSensitiveCredentialPath, shellCommandReadsCredentials } from '@cindy/maker-core';

/** 配置目录里的说明类子路径：`/.claude/skills/…`、`/.codex/AGENTS.md` 等(两种分隔符都认)。 */
const CONFIG_INSTRUCTION_SEGMENT =
  /([\\/])\.(claude|codex)(?=[\\/](?:(?:skills|agents|commands|rules|prompts)(?:[\\/]|$|[^\w.-])|(?:CLAUDE|AGENTS)(?:\.override)?\.md(?![\w.-])))/gi;

/** 路径或命令里的 `..` 段：可能借说明目录绕回配置目录本身(`~/.claude/skills/../settings.json`)。 */
const PARENT_SEGMENT = /(^|[\\/\s'"=])\.\.(?=[\\/\s'"]|$)/;

/** 本机规则只在特定目录下认的登录文件，放开配置目录后在说明目录里也要认。 */
const LOGIN_FILE = /(?:^|[\\/])(?:auth|\.credentials)\.json$/i;

/** 把配置目录里说明类子路径的目录名换掉，让本机凭证规则不再因为「在配置目录里」命中。 */
function withoutConfigInstructionDirs(text: string): string {
  if (PARENT_SEGMENT.test(text)) return text;
  return text.replace(CONFIG_INSTRUCTION_SEGMENT, '$1_$2');
}

/** 路径是否为凭证类文件(调用方对链接目标的真实路径也要各判一次)。 */
export function isShareCredentialPath(target: string): boolean {
  if (typeof target !== 'string' || !target) return false;
  return isSensitiveCredentialPath(withoutConfigInstructionDirs(target)) || LOGIN_FILE.test(target);
}

/** 命令是否读取或打出凭证(只看命令文本：脚本文件里读的、编码后再解开的认不出来)。 */
export function isShareCredentialCommand(
  command: string,
  workspaceRoots: string[],
  opts: { cwd?: string; platform?: NodeJS.Platform } = {},
): boolean {
  return shellCommandReadsCredentials(withoutConfigInstructionDirs(command), workspaceRoots, opts);
}
