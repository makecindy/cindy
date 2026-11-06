/**
 * Claude 订阅会话的工作区设置守门。
 *
 * 订阅会话由 CLI 用本机登录直连 Anthropic,不设 CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST(设了
 * CLI 就不读本机凭证)。SDK(非交互)模式下 CLI 会直接应用工作区 `.claude/settings.json` /
 * `.claude/settings.local.json` 的 env:没有终端里的工作区信任确认,也不像 Claude Desktop
 * 那样剥掉项目级的上游 / 鉴权键(CLI 只对 desktop 入口或 host-managed 会话做这层过滤)。
 * 仓库里提交一份把 ANTHROPIC_BASE_URL 指向别处、或关掉 TLS 校验的 settings,就能让订阅
 * 请求带着用户的登录凭证发往第三方。
 *
 * 三道闸(都只对本机订阅会话):
 *   - 每次拉起 CLI 进程前(首次启动与会话中途重建)检查 CLI 会加载的项目级设置,命中就
 *     拒绝启动;
 *   - 会话运行中 CLI 热加载项目级设置前,经 ConfigChange hook 检查变更后的文件,命中就
 *     阻止这次变更生效;
 *   - 解析不了的设置文件按命中处理(CLI 的解析更宽松,读不懂不等于它不会应用)。
 * 只读文件、不改写。用户级 `~/.claude/settings.json` 与托管策略是用户 / 管理员自己的
 * 配置,不在此列。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 会改写订阅请求去向、鉴权来源或 TLS 信任的 env 键(大小写不敏感)。 */
const EXACT_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_API_BASE_URL',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_HOST_CREDS_FILE',
  'CLAUDE_CONFIG_DIR',
  'USE_LOCAL_OAUTH',
  'USE_STAGING_OAUTH',
  'CLAUDE_LOCAL_OAUTH_API_BASE',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  // 切换供应商(请求改发 Bedrock / Vertex / Foundry / 网关等)。
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
]);

function isSensitiveEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (EXACT_ENV_KEYS.has(upper)) return true;
  // 各家供应商的上游地址(ANTHROPIC_BEDROCK_BASE_URL 等)。
  return (upper.startsWith('ANTHROPIC_') || upper.startsWith('CLAUDE_')) && upper.endsWith('_BASE_URL');
}

/** 顶层设置里会替换鉴权来源的键:由仓库提供的命令给出 API key。 */
const SENSITIVE_TOP_LEVEL_KEYS = ['apiKeyHelper'] as const;

/** 解析失败时报告的键。 */
export const UNPARSEABLE_SETTINGS_KEY = '(unparseable settings file)';

export interface WorkspaceSettingsOverride {
  /** 设置文件的绝对路径。 */
  file: string;
  /** 命中的键(env 键、顶层键,或 UNPARSEABLE_SETTINGS_KEY)。 */
  key: string;
}

/** 去掉 JSONC 的注释与尾逗号(字符串里的内容原样保留)。 */
function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      out += ' ';
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

type ParsedSettings = { kind: 'missing' } | { kind: 'unparseable' } | { kind: 'ok'; value: unknown };

async function readSettings(file: string): Promise<ParsedSettings> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return { kind: 'missing' };
  }
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  if (!text.trim()) return { kind: 'ok', value: {} };
  try {
    return { kind: 'ok', value: JSON.parse(stripJsonc(text)) };
  } catch {
    return { kind: 'unparseable' };
  }
}

/** 检查一份设置文件;没有命中返回 null。 */
export async function findSettingsFileOverride(file: string): Promise<WorkspaceSettingsOverride | null> {
  const parsed = await readSettings(file);
  if (parsed.kind === 'missing') return null;
  if (parsed.kind === 'unparseable') return { file, key: UNPARSEABLE_SETTINGS_KEY };
  const settings = parsed.value;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
  const record = settings as Record<string, unknown>;
  for (const key of SENSITIVE_TOP_LEVEL_KEYS) {
    if (record[key] !== undefined) return { file, key };
  }
  const env = record.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  for (const key of Object.keys(env)) {
    if (isSensitiveEnvKey(key)) return { file, key };
  }
  return null;
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

/**
 * 工作目录所在的主仓库根目录:沿父目录找 `.git`;linked worktree 的 `.git` 是指向
 * `<主仓库>/.git/worktrees/<名字>` 的文件,CLI 的 localSettings 取主仓库根目录。
 */
async function findCanonicalGitRoot(start: string): Promise<string | null> {
  let dir = start;
  for (;;) {
    const marker = path.join(dir, '.git');
    try {
      const stat = await fs.lstat(marker);
      if (stat.isFile()) {
        const content = await fs.readFile(marker, 'utf8');
        const gitdir = /^gitdir:\s*(.+)$/m.exec(content)?.[1]?.trim();
        if (gitdir) {
          const resolved = path.resolve(dir, gitdir);
          const worktrees = path.dirname(resolved);
          if (path.basename(worktrees) === 'worktrees') return path.dirname(path.dirname(worktrees));
        }
      }
      return dir;
    } catch {
      /* 继续向上 */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** CLI 会加载的项目级设置文件(按路径去重)。 */
async function workspaceSettingsFiles(workingDir: string): Promise<string[]> {
  const cwd = path.resolve(workingDir);
  const real = await realpathOrSelf(cwd);
  const files: string[] = [];
  for (const dir of new Set([cwd, real])) {
    files.push(path.join(dir, '.claude', 'settings.json'), path.join(dir, '.claude', 'settings.local.json'));
  }
  for (const start of new Set([cwd, real])) {
    const gitRoot = await findCanonicalGitRoot(start);
    if (gitRoot) files.push(path.join(gitRoot, '.claude', 'settings.local.json'));
  }
  return [...new Set(files)];
}

/**
 * 找出工作区里会改写订阅会话上游 / 鉴权 / TLS 信任的项目级设置;没有返回 null。
 */
export async function findWorkspaceSettingsOverride(workingDir: string): Promise<WorkspaceSettingsOverride | null> {
  for (const file of await workspaceSettingsFiles(workingDir)) {
    const override = await findSettingsFileOverride(file);
    if (override) return override;
  }
  return null;
}

/** 拒绝启动时的错误信息;`[CLAUDE_SUBSCRIPTION_WORKSPACE_OVERRIDE]` 前缀供 host 映射错误码。 */
export function workspaceSettingsOverrideMessage(override: WorkspaceSettingsOverride): string {
  const what = override.key === UNPARSEABLE_SETTINGS_KEY ? 'cannot be parsed' : `sets ${override.key}`;
  return (
    `[CLAUDE_SUBSCRIPTION_WORKSPACE_OVERRIDE] ${override.file} ${what}, which could change where ` +
    'the Claude subscription sends requests or how it authenticates. Remove it from the workspace settings ' +
    '(or move it to ~/.claude/settings.json), or choose a gateway or API-key model for this task.'
  );
}

/** ConfigChange hook 的输入里与守门相关的部分。 */
export interface WorkspaceConfigChange {
  source?: string;
  file_path?: string;
}

/**
 * 会话运行中 CLI 热加载设置前的判定:命中就返回拒绝原因,否则 null。
 * 任何一次设置变更都会让 CLI 全量重读各层设置,所以除了变更的那份项目级文件,每次都
 * 整体复查工作区;托管策略的变更 CLI 不允许拦截,不在此列。
 */
export async function workspaceConfigChangeBlockReason(
  input: WorkspaceConfigChange,
  workingDir: string,
): Promise<string | null> {
  if (input.source === 'policy_settings') return null;
  const changedProjectFile =
    (input.source === 'project_settings' || input.source === 'local_settings') && input.file_path
      ? await findSettingsFileOverride(path.resolve(workingDir, input.file_path))
      : null;
  const override = changedProjectFile ?? (await findWorkspaceSettingsOverride(workingDir));
  return override ? workspaceSettingsOverrideMessage(override) : null;
}
