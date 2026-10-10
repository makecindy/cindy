/**
 * 设备托管会话(StartSessionOptions.deviceHosted)的共用部分：Agent 在本机运行，任务、项目
 * 文件与命令在同账号另一台电脑上，工具经本机 loopback 隧道回到那台电脑执行。
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';

import type { DeviceHostedSession, PiExtraSpawnConfig } from '../base-agent.js';

/** 交给 Pi 内 cindy-bridge 的托管配置(隧道地址、令牌、Agent 主机上的工作目录)。 */
export const DEVICE_HOSTED_PI_ENV = 'CINDY_PI_HOSTED';

/**
 * 去掉结尾的斜杠。不用正则：`x+$` 这类模式在不可控输入上是多项式回溯(CodeQL
 * “Polynomial regular expression used on uncontrolled data”)。
 */
export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end -= 1;
  return url.slice(0, end);
}

export function deviceHostedPiEnvValue(hosted: DeviceHostedSession): string {
  return JSON.stringify({
    url: hosted.tunnelUrl,
    token: hosted.tunnelToken,
    cwd: hosted.workingDir,
    platform: hosted.platform,
    shell: hosted.shell,
    ...(hosted.mirrorRoot ? { mirrorRoot: hosted.mirrorRoot } : {}),
    // 受邀者会话：Pi 子代理据此同样不读本机的说明文件与技能。同账号的值保持原样。
    ...(hosted.guest ? { guest: true } : {}),
  });
}

/**
 * 受邀者会话自己的目录：虚拟工作区根的上一级(会话目录，里面是受邀者带来的项目与个人说明)；
 * 旧协议没有虚拟工作区时就是本机影子目录。这一级之上属于本机用户。
 */
export function deviceHostedGuestSessionRoot(hosted: DeviceHostedSession, localWorkingDir: string): string {
  return hosted.mirrorRoot ? path.dirname(path.resolve(hosted.mirrorRoot)) : path.resolve(localWorkingDir);
}

/**
 * target 是否在 root 之内(含 root 本身)。同时按原路径与真实路径比较(符号链接、macOS 的
 * /var → /private/var)；Windows 不区分大小写。
 */
export function isInsideDeviceHostedRoot(target: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const variants = (value: string): string[] => {
    const resolved = path.resolve(value);
    let real = resolved;
    try {
      real = realpathSync.native(resolved);
    } catch {
      /* 不存在的路径按原样比较 */
    }
    return [...new Set([resolved, real])].map((item) => (platform === 'win32' ? item.toLowerCase() : item));
  };
  const roots = variants(root);
  return variants(target).some((candidate) => roots.some((base) => {
    const relative = path.relative(base, candidate);
    return relative === ''
      || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }));
}

/**
 * 受邀者(另一个账号)的会话：Claude Code 会沿工作目录逐级向上加载 CLAUDE.md 与规则文件，
 * 会话目录(虚拟工作区根的上一级)之外的那几级属于本机用户，例如家目录里的 CLAUDE.md，
 * 一律排除。同时给出 `/` 分隔与本机分隔两种写法(Claude Code 用 picomatch 匹配绝对路径)。
 */
export function deviceHostedGuestClaudeMdExcludes(hosted: DeviceHostedSession): string[] {
  if (!hosted.guest || !hosted.mirrorRoot) return [];
  const sessionRoot = path.dirname(path.resolve(hosted.mirrorRoot));
  const slash = (value: string) => value.split(path.sep).join('/');
  const out = new Set<string>();
  for (let dir = path.dirname(sessionRoot); ; dir = path.dirname(dir)) {
    for (const file of [path.join(dir, 'CLAUDE.md'), path.join(dir, 'CLAUDE.local.md'), path.join(dir, '.claude', 'CLAUDE.md')]) {
      out.add(slash(file));
      out.add(file);
    }
    out.add(`${slash(path.join(dir, '.claude', 'rules'))}/**`);
    if (path.dirname(dir) === dir) break;
  }
  return [...out];
}

/** 隧道上某个 MCP 服务的地址。 */
export function deviceHostedMcpUrl(hosted: DeviceHostedSession, name: string): string {
  return `${stripTrailingSlashes(hosted.tunnelUrl)}/mcp/${encodeURIComponent(name)}`;
}

/** Pi 的 MCP 桥配置：全部指向隧道，令牌是本任务的隧道令牌。 */
export function deviceHostedPiMcpBridge(hosted: DeviceHostedSession): NonNullable<PiExtraSpawnConfig['mcpBridge']> {
  return {
    token: hosted.tunnelToken,
    servers: hosted.mcpServers.map((name) => ({ name, url: deviceHostedMcpUrl(hosted, name) })),
  };
}

/** 设备托管时顶替 Claude Code 自带文件与命令工具的 Cindy MCP 服务名。 */
export const DEVICE_HOSTED_EXEC_MCP_SERVER = 'cindy_exec';
/** 顶替的工具名(与自带工具同名)。 */
export const DEVICE_HOSTED_EXEC_TOOL_NAMES = ['Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'NotebookEdit'] as const;
/** 设备托管时关掉的 Claude Code 自带工具：它们只能操作本机，项目不在这里。 */
export const DEVICE_HOSTED_DISALLOWED_CLAUDE_TOOLS = [
  'Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Glob', 'Grep', 'LS', 'PowerShell', 'EnterWorktree', 'ExitWorktree',
] as const;

/**
 * 受邀者(供应商分享的另一个账号)会话可用的 Claude Code 自带工具，经 SDK `tools` 交给
 * Claude Code：名单之外的自带工具在会话里根本不存在，Claude Code 升级新增的工具也不会自动
 * 开放给受邀者。Agent 程序以本机用户的身份在本机运行，其余自带工具都直接作用于本机或本机
 * 用户：其他会话(ListAgents / SendMessage)、本机用户的 claude.ai 账号(Artifact、
 * RemoteTrigger、DesignSync 等)、本机文件与命令(Monitor、SendUserFile 等)、本机网络(WebFetch)。
 * 文件与命令由 cindy_exec 回到受邀者电脑执行(MCP 工具不受 `tools` 限制)。
 */
export const DEVICE_HOSTED_GUEST_CLAUDE_TOOLS = [
  // 子代理。隔离选项另由 deviceHostedGuestAgentDenial 拦下。
  'Agent',
  // 只作用于会话自身：提问、计划模式、待办与后台任务、延迟加载的工具、技能、结果卡片、定时唤醒。
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
  'TodoWrite', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop', 'TaskOutput',
  'ToolSearch', 'Skill', 'ReportFindings', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList',
  // 只连本会话配置的 MCP 服务，设备托管时都经隧道回到受邀者电脑。
  'ListMcpResourcesTool', 'ReadMcpResourceTool',
  // 由模型服务方执行，不经本机网络。
  'WebSearch',
] as const;

/**
 * 受邀者会话里子代理的隔离选项：worktree 在本机建 git worktree，remote 用本机用户的 claude.ai
 * 账号开云端任务，都不允许。返回拒绝原因；其他调用返回 null。
 */
export function deviceHostedGuestAgentDenial(toolName: string, input: unknown): string | null {
  if (toolName !== 'Agent' && toolName !== 'Task') return null;
  const isolation = input && typeof input === 'object' ? (input as { isolation?: unknown }).isolation : undefined;
  if (isolation === undefined || isolation === null) return null;
  return 'Subagent isolation is not available in this task. Start the subagent without the isolation option.';
}

const EXEC_PREFIX = `mcp__${DEVICE_HOSTED_EXEC_MCP_SERVER}__`;

/** `mcp__cindy_exec__Bash` → `Bash`；不是顶替工具时返回 null。 */
export function deviceHostedBuiltinToolName(toolName: string): string | null {
  if (!toolName.startsWith(EXEC_PREFIX)) return null;
  const name = toolName.slice(EXEC_PREFIX.length);
  return (DEVICE_HOSTED_EXEC_TOOL_NAMES as readonly string[]).includes(name) ? name : null;
}

/** `Bash` → `mcp__cindy_exec__Bash`。 */
export function deviceHostedExecToolName(builtin: string): string {
  return `${EXEC_PREFIX}${builtin}`;
}

/**
 * 给模型的环境说明：模型只看到 Agent 主机上的虚拟工作区路径；执行端平台与 shell 保留真实值。
 */
export function deviceHostedEnvironmentNote(hosted: DeviceHostedSession, _localWorkingDir: string): string {
  const lines = [
    '# Workspace',
    `The current workspace is \`${hosted.workingDir}\` (${hosted.platform}, shell: ${hosted.shell}${hosted.osVersion ? `, ${hosted.osVersion}` : ''}).`,
    `File and shell tools operate in this workspace. Use paths under \`${hosted.workingDir}\`; relative paths resolve against it.`,
  ];
  if (hosted.extraDirs.length || hosted.writableDirs.length) {
    lines.push(`Additional workspace directories: ${[...new Set([...hosted.extraDirs, ...hosted.writableDirs])].map((dir) => `\`${dir}\``).join(', ')}.`);
  }
  lines.push(`Is a git repository: ${hosted.isGitRepo ? 'yes' : 'no'}.`);
  if (hosted.personalInstructions?.trim()) {
    lines.push('', "# The user's personal instructions", hosted.personalInstructions.trim());
  }
  return lines.join('\n');
}

/** Claude Code 版：说明文件与命令工具由 Cindy 工具顶替。 */
export function deviceHostedClaudeNote(hosted: DeviceHostedSession, localWorkingDir: string): string {
  const tools = DEVICE_HOSTED_EXEC_TOOL_NAMES.map((name) => deviceHostedExecToolName(name)).join(', ');
  return [
    deviceHostedEnvironmentNote(hosted, localWorkingDir),
    `File and shell tools are provided as ${tools}. Use them wherever these instructions mention Bash, Read, Write, Edit or NotebookEdit; search files with Bash (rg, find).`,
  ].join('\n');
}

/**
 * 子代理的工具限制(设备托管)。本机任务里 Claude Code 按子代理定义收窄自带工具；顶替成 Cindy
 * 工具后 SDK 不再按名字收窄(MCP 工具一律放行)，这里按同样的定义判一次：
 *  - 自带的只读子代理(Explore / Plan)不能写文件；
 *  - 自定义子代理写了 tools 时只能用列出的工具，写了 disallowedTools 时不能用列出的工具；
 *  - 参数化条目(如 `Bash(git diff:*)`)只覆盖范围内的调用：必须按本次 `input.command` 判定，
 *    不能当成整个工具的放行 —— 否则被 MCP 顶替后子代理可执行任意命令，与本机不一致。
 * 不认识的子代理不额外限制(与本机一致：没有定义就继承全部工具)。
 */
export interface DeviceHostedAgentToolRule {
  tools?: string[];
  disallowedTools?: string[];
}

/** 本次顶替工具调用的参数(参数化工具规则按它收窄范围)。 */
export interface DeviceHostedToolCall {
  /** Bash 本次执行的命令；没有命令(BashOutput / KillShell 或拿不到参数)时缺省。 */
  command?: string;
}

const READ_ONLY_BUILTIN_AGENTS: Record<string, DeviceHostedAgentToolRule> = {
  Explore: { disallowedTools: ['Write', 'Edit', 'NotebookEdit'] },
  Plan: { disallowedTools: ['Write', 'Edit', 'NotebookEdit'] },
};

/** 子代理定义文件(Markdown + frontmatter)里的名字与工具规则；没有 frontmatter 时返回 null。 */
export function parseClaudeAgentToolRule(markdown: string): { name: string; rule: DeviceHostedAgentToolRule } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (field) fields.set(field[1], field[2].trim());
  }
  const name = fields.get('name')?.replace(/^["']|["']$/g, '');
  if (!name) return null;
  const list = (value: string | undefined) => value
    ?.replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  const tools = list(fields.get('tools'));
  const disallowedTools = list(fields.get('disallowedTools') ?? fields.get('disallowed-tools'));
  return {
    name,
    rule: {
      ...(tools && tools.length ? { tools } : {}),
      ...(disallowedTools && disallowedTools.length ? { disallowedTools } : {}),
    },
  };
}

/** 子代理能否用某个顶替工具(自带工具名)。BashOutput / KillShell 跟随 Bash 的非参数化条目。 */
export function deviceHostedSubagentAllows(
  agentType: string,
  builtin: string,
  customRules: ReadonlyMap<string, DeviceHostedAgentToolRule>,
  call?: DeviceHostedToolCall,
): boolean {
  const rule = customRules.get(agentType) ?? READ_ONLY_BUILTIN_AGENTS[agentType];
  if (!rule) return true;
  const name = builtin === 'BashOutput' || builtin === 'KillShell' ? 'Bash' : builtin;
  const coversTool = (tool: string) => tool === name || tool === builtin || tool === deviceHostedExecToolName(builtin);
  /** 参数化条目只约束 Bash 命令本身；BashOutput / KillShell 不执行命令，不被它覆盖。 */
  const entryCovers = (entry: string, side: 'allow' | 'deny'): boolean => {
    const split = splitToolEntry(entry);
    if (!coversTool(split.tool)) return false;
    if (split.scope === null) return true;
    if (builtin !== 'Bash') return false;
    const verdict = toolScopeVerdict(split.scope, call);
    // allow 侧只有证明确在范围内才放行；deny 侧拿不准就拦(fail-closed)。
    return side === 'allow' ? verdict === 'match' : verdict !== 'no-match';
  };
  if (rule.disallowedTools?.some((entry) => entryCovers(entry, 'deny'))) return false;
  if (rule.tools && !rule.tools.some((entry) => entry === '*' || entryCovers(entry, 'allow'))) return false;
  return true;
}

/** `Bash(git diff:*)` → 工具名 `Bash` + 参数范围 `git diff:*`；不是参数化条目时 scope 为 null。 */
function splitToolEntry(entry: string): { tool: string; scope: string | null } {
  const open = entry.indexOf('(');
  if (open <= 0 || !entry.endsWith(')')) return { tool: entry, scope: null };
  return { tool: entry.slice(0, open), scope: entry.slice(open + 1, -1) };
}

type ScopeVerdict = 'match' | 'no-match' | 'unknown';

/**
 * 参数化条目的范围与本次命令的匹配：`:*` 结尾按前缀匹配(与 Claude Code 同语义的保守
 * 实现)，其余整串精确匹配。范围为空、含不移植的通配符或拿不到本次命令时返回 unknown，
 * 由调用方按 allow / deny 侧各自的安全方向解释。
 */
function toolScopeVerdict(scope: string, call: DeviceHostedToolCall | undefined): ScopeVerdict {
  const spec = scope.trim();
  const command = call?.command?.trim();
  if (!spec || !command) return 'unknown';
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2).trim();
    if (!prefix) return 'unknown';
    return command === prefix || command.startsWith(prefix) ? 'match' : 'no-match';
  }
  if (/[?*[\]{}]/.test(spec)) return 'unknown';
  return command === spec ? 'match' : 'no-match';
}
