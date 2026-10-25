/**
 * destructiveGuard.ts
 * ---------------------------------------------------------------------------
 * 当 LiveSession.denyDestructive 为 true 时（飞书 bot session 默认开启），
 * agentManager 的 canUseTool 在弹卡片/auto-allow 之前先调本模块判定。
 *
 * 命中 → 返回 reason，canUseTool 直接 `behavior: 'deny'` 返还给 SDK，
 * 模型收到工具错误后自行决定下一步（通常会改用 AskUserQuestion 询问用户）。
 *
 * 命中规则：
 *  1. 工具名包含 delete / remove / unlink / rmdir / trash / erase（不分大小写）
 *  2. Bash / PowerShell 的 `command` 字段包含独立的删除指令：
 *       rm  rmdir  unlink  del  erase
 *       Remove-Item  Clear-Content  Clear-Item  Remove-ItemProperty
 *     或 find ... -delete / find ... -exec rm
 *     或 git clean -*f*
 *
 * 不拦截的（明确放行，避免把飞书 bot 变成只读终端）：
 *  - Write / Edit / NotebookEdit 这类"内容覆写"工具——属于编辑而非删除
 *  - mv / 重命名
 *  - shell 重定向 `> file` 截断
 * 这些场景需要更细的语义分析，不在本守卫范围内。
 */

const TOOL_NAME_DENY = /(delete|remove|unlink|rmdir|trash|erase)/i;

const SHELL_COMMAND_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\brm\b/, label: 'rm' },
  { pattern: /\brmdir\b/, label: 'rmdir' },
  { pattern: /\bunlink\b/, label: 'unlink' },
  { pattern: /\bdel\b/, label: 'del' },
  { pattern: /\berase\b/, label: 'erase' },
  { pattern: /\bRemove-Item\b/i, label: 'Remove-Item' },
  { pattern: /\bRemove-ItemProperty\b/i, label: 'Remove-ItemProperty' },
  { pattern: /\bRemove-Variable\b/i, label: 'Remove-Variable' },
  { pattern: /\bClear-Content\b/i, label: 'Clear-Content' },
  { pattern: /\bClear-Item\b/i, label: 'Clear-Item' },
  { pattern: /\bfind\b[^|;&]*\s-delete\b/, label: 'find -delete' },
  { pattern: /\bfind\b[^|;&]*\s-exec\s+rm\b/, label: 'find -exec rm' },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/, label: 'git clean -f' },
];

// 大小写不敏感:Claude 的 shell 工具名是 `Bash`,Pi 的内置工具全小写 `bash`
// (见 packages/maker-core/src/agents/pi/auto-review-policy.ts)。集合按小写存,
// 比较前把 toolName 归一化 —— 否则 `checkDestructiveToolCall('bash', {command:'rm -rf …'})`
// 不命中任何规则,微信/Telegram 远程渠道对 Pi 的删除类命令红线被直接击穿。
const SHELL_TOOL_NAMES = new Set(['bash', 'powershell']);

export interface GuardResult {
  destructive: boolean;
  /** 触发拦截的关键字/工具名，仅用于日志和 deny message */
  reason?: string;
}

/**
 * 判定一次工具调用是否属于"会从磁盘上删除内容"。
 * 命中返回 { destructive: true, reason }，否则 { destructive: false }。
 */
export function checkDestructiveToolCall(
  toolName: string,
  input: Record<string, unknown> | undefined | null,
): GuardResult {
  // 1. 工具名匹配——MCP 删除类工具大多名字里就带 delete/remove
  const toolNameMatch = TOOL_NAME_DENY.exec(toolName);
  if (toolNameMatch) {
    return { destructive: true, reason: `tool name contains "${toolNameMatch[0]}"` };
  }

  // 2. Bash / PowerShell 命令文本匹配(工具名大小写不敏感:Claude `Bash` / Pi `bash`)
  if (SHELL_TOOL_NAMES.has(toolName.toLowerCase()) && input && typeof input === 'object') {
    const cmd = (input as { command?: unknown }).command;
    if (typeof cmd === 'string' && cmd.length > 0) {
      for (const { pattern, label } of SHELL_COMMAND_PATTERNS) {
        if (pattern.test(cmd)) {
          return { destructive: true, reason: `shell command contains \`${label}\`` };
        }
      }
    }
  }

  return { destructive: false };
}

/**
 * 给模型看的 deny 解释——告诉它"为什么被拒"以及"下一步该怎么办"。
 */
export function buildDestructiveDenyMessage(toolName: string, reason: string): string {
  return [
    `Refused: \`${toolName}\` blocked because ${reason}.`,
    `This session (Feishu bot) is not allowed to delete anything from disk — ever.`,
    `If the user really needs the file removed, ask them via AskUserQuestion to confirm,`,
    `then have THEM delete it manually on their side. Do not try a workaround command.`,
  ].join(' ');
}
