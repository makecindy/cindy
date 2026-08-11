/**
 * Desktop 端 MCP 工具审批策略 —— Claude Code 与 Codex 共用的唯一真源。
 *
 * 一个第一方 MCP 在两个 agent 下必须给出同一个答案。历史上这里只有 Codex 用的
 * server allowlist，Claude 侧另有一份静态 `allowedTools` 白名单且不查策略，结果
 * `cindy_browser` 这种高频 server 的 `call_tool` 在 Codex 侧静默执行、在 Claude 侧
 * 每调用一次弹一次窗——一次浏览器调研就能攒出上百个权限请求。
 *
 * 现在两端都查 `getDesktopMcpToolApprovalPolicy`：
 *   - Codex：`mcpServerElicitation` handler（maker-core codex/index.ts）
 *   - Claude：`canUseTool` 对 `mcp__<server>__<tool>` 形态的工具（maker-core claude-code/index.ts）
 *
 * 判定顺序（从最窄到最宽）：
 *   1. READ_ONLY_MCP_TOOLS —— 精确到工具的只读发现入口，server 未整体可信也放行
 *   2. cindy_contacts     —— 按内层 action 细粒度判定（见 contacts/approval.ts）
 *   3. cindy::ghost_call  —— 按用户在插件详情页为**该插件的该工具**选的授权档位判定
 *   4. TRUSTED_MCP_SERVERS —— 已 review 的第一方 server，整体静默
 *   5. 其余                —— 逐次弹窗（第三方 server、cindy_ssh…）
 */

import type {
  McpToolApprovalContext,
  McpToolApprovalPolicy,
  McpToolApprovalPresentation,
} from '@cindy/maker-core';
import { canAutoApproveContactsMcpTool } from '@cindy/mcps';

import { resolveToolApprovalMode } from '../cindy-brain/ghostToolPermissionsStore.js';
import { t } from '../i18n.js';

/**
 * 精确到工具的只读放行表，键为 `<server>::<tool>`。
 *
 * 只收录工具整体都无写副作用、且不把调用方提供的自由文本 / URL / 文件内容外发的
 * 发现与状态入口，禁止 wildcard / 前缀匹配：progressive `call_tool`、`ghost_call` 等
 * 聚合入口的风险取决于内层 action，不能因 server 属于第一方就粗粒度放行。
 *
 * 判据是「有没有携带内容出境」，不是「有没有网络往返」：`cindy_slack::slack_status`
 * 会经 bridge 向 slack-hook-server 查一次绑定状态，参数为空、返回的是本机已有的授权
 * 信息，因此仍算只读；`WebSearch` / `WebFetch` 则把搜索词 / URL 送到外部服务
 * （exfiltration 面），与 maker-core `READ_ONLY_CLAUDE_TOOLS` 的既有边界一致，不列入
 * 免审批。新增工具默认继续走原权限链，必须 review 后显式加入。
 *
 * 这张表同时是 Claude `options.allowedTools` 的真源（见
 * getDesktopClaudeReadOnlyAllowedTools）：allowedTools 在 CLI 层就免询问，比
 * canUseTool 更早短路，能让 auto 模式省掉一次远程安全分类器调用。两个出口共用一份
 * 声明，避免"静态白名单放行、动态策略却要弹窗"这类自相矛盾。
 */
const READ_ONLY_MCP_TOOLS: ReadonlySet<string> = new Set([
  'cindy::ghost_list',
  // 免审查询会以 ASLEEP / DISABLED 区分已安装插件的不可见原因；这是有意
  // 接受的存在性披露，只读元数据不因此回退为逐次审批或统一成 NOT_FOUND。
  'cindy::ghost_info',
  'cindy::ghost_forge_guide',
  'cindy_browser::list_tools',
  'cindy_android::list_tools',
  'cindy_ios_simulator::list_tools',
  'cindy_computer::list_tools',
  'cindy_feishu_bot::list_tools',
  'cindy_scheduler::list_tools',
  'cindy_ssh::list_tools',
  'cindy_helper::list_tools',
  'cindy_memory::list_tools',
  'cindy_contacts::list_tools',
  'cindy_slack::slack_status',
]);

/**
 * 整体静默执行的第一方 server。
 *
 * 这里不能按 `cindy_` 前缀放行：namespace 只表示品牌归属，不代表新 provider
 * 已完成权限 review。SSH（在已配置主机上跑任意命令）、插件宿主 `cindy`
 * （`ghost_call` 转发到第三方插件沙箱）与第三方 server 都不在表内，继续逐次确认；
 * Contacts 走 inner-tool 细粒度策略。
 */
const TRUSTED_MCP_SERVERS: ReadonlySet<string> = new Set([
  'cindy_android',
  'cindy_browser',
  'cindy_computer',
  'cindy_feishu_bot',
  'cindy_slack',
  'cindy_scheduler',
  'cindy_memory',
  'cindy_helper',
  'cindy_orca',
  // worker → lead 回报通道。执行边界在工具内部 fail-closed
  // (resolveWorkerLink 按 session ctx 校验 worker link 归属), 逐次弹窗只会
  // 让远端 daemon 等审批超时、worker 回报断链。
  'orca_worker_bridge',
  'cindy_lsp',
]);

/**
 * `cindy::ghost_call` 的免审批判定 —— 唯一依据是用户在插件详情页亲手选的档位。
 *
 * 这是对本文件既有边界的一次**用户可控**放宽：`cindy` 仍然不进
 * TRUSTED_MCP_SERVERS（`ghost_call` 转发到第三方插件沙箱，server 级静默始终
 * 不可接受），但用户对具体某个插件的某个工具选了「总是允许」时，宿主必须照办，
 * 否则设置项就是空转的假承诺。
 *
 * 免掉的只有「要不要让 Agent 调用这个工具」这一张权限卡。工作目录外的文件/目录
 * 交接是**另一条独立闸门**（mcp-integrations/ghost.ts 的 requestGrantConfirm），
 * 不受本档位影响——该边界曾被误接进 always-allow，已在 2026-08 撤销，不要再接。
 *
 * 三条 fail-closed：
 *   - 拿不到 ghost_id / tool 坐标（Codex 的 elicitation 会省略参数，见下方
 *     getDesktopMcpToolApprovalPolicy 注释）→ 不放行；
 *   - grant_only 调用做的是真实过户与 ledger 落账，不吃 always-allow；
 *   - 读配置抛错 → 不放行。
 *
 * `blocked` 在这里只当作「不免审批」。审批策略枚举没有 deny 档，返回
 * prompt-each-time 等于允许用户点同意、把禁用变成可绕过——硬拦截由派发层
 * (cindy-brain/pipeDispatcher.ts 的资格审) 独占，那里是所有调用方的唯一收口。
 */
function ghostCallApprovalPolicy(toolParams: unknown): McpToolApprovalPolicy {
  const params =
    toolParams && typeof toolParams === 'object' && !Array.isArray(toolParams)
      ? (toolParams as Record<string, unknown>)
      : null;
  if (!params) return 'prompt';
  if (params.grant_only === true) return 'prompt';
  const ghostId = typeof params.ghost_id === 'string' ? params.ghost_id.trim() : '';
  const innerTool = typeof params.tool === 'string' ? params.tool.trim() : '';
  if (!ghostId || !innerTool) return 'prompt';
  try {
    return resolveToolApprovalMode(ghostId, innerTool) === 'always-allow'
      ? 'auto-approve'
      : 'prompt';
  } catch {
    return 'prompt';
  }
}

/** Claude SDK 工具名格式固定为 `mcp__<server>__<tool>`。 */
function toClaudeToolName(key: string): string {
  const [serverName, toolName] = key.split('::');
  return `mcp__${serverName}__${toolName}`;
}

/**
 * Claude `options.allowedTools`：由只读表派生，返回新数组避免调用方原地改写真源。
 */
export function getDesktopClaudeReadOnlyAllowedTools(): string[] {
  return [...READ_ONLY_MCP_TOOLS].map(toClaudeToolName);
}

/**
 * 保持可信内置 MCP 安静执行，同时让 destructive / external contacts action 每次确认。
 */
export function getDesktopMcpToolApprovalPolicy(
  context: McpToolApprovalContext,
): McpToolApprovalPolicy {
  const { serverName, toolName, toolParams } = context;
  // Codex 的 elicitation 不总是带 toolName（0.142.5 / 0.144.1 会省略），拿不到工具名
  // 时这条精确规则自然不命中，回落到下面的 server 级判定，与改动前行为一致。
  if (toolName && READ_ONLY_MCP_TOOLS.has(`${serverName}::${toolName}`)) {
    return 'auto-approve';
  }
  if (serverName === 'cindy_contacts') {
    return canAutoApproveContactsMcpTool({ toolName, toolParams })
      ? 'auto-approve'
      : 'prompt-each-time';
  }
  // 插件工具的用户自定档位。toolName 缺省（Codex 省略）时不进这条分支，自然
  // 回落到下面的 server 级判定：`cindy` 不在 TRUSTED 表里 → prompt，fail closed。
  if (serverName === 'cindy' && toolName === 'ghost_call') {
    return ghostCallApprovalPolicy(toolParams);
  }
  if (serverName === 'cindy_ios_simulator') {
    // Some Codex app-server versions omit the outer tool name but retain the
    // validated progressive payload. Preserve the inner action's stricter
    // policy instead of falling back to a persistable generic server prompt.
    if (toolName === 'call_tool' || toolName === undefined) {
      const innerName =
        toolParams && typeof toolParams === 'object'
          ? (toolParams as { name?: unknown }).name
          : undefined;
      return innerName === 'build_app' ||
        innerName === 'open_url' ||
        innerName === 'create_instance' ||
        innerName === 'attach_device'
        ? 'prompt-each-time'
        : 'auto-approve';
    }
  }
  if (TRUSTED_MCP_SERVERS.has(serverName)) {
    return 'auto-approve';
  }
  return 'prompt';
}

/**
 * Host-owned security copy for progressive MCP actions whose outer
 * `call_tool` description cannot explain the inner action's real authority.
 */
export function getDesktopMcpToolApprovalPresentation(
  context: McpToolApprovalContext,
): McpToolApprovalPresentation | undefined {
  const innerName =
    context.serverName === 'cindy_ios_simulator' &&
    (context.toolName === 'call_tool' || context.toolName === undefined) &&
    context.toolParams &&
    typeof context.toolParams === 'object'
      ? (context.toolParams as { name?: unknown }).name
      : undefined;
  if (innerName === 'build_app') {
    return {
      title: t('rightSidebar.iosSimulator.buildApproval.title'),
      description: t('rightSidebar.iosSimulator.buildApproval.description'),
    };
  }
  if (innerName === 'attach_device' || innerName === 'create_instance') {
    return {
      title: t(
        innerName === 'attach_device'
          ? 'rightSidebar.iosSimulator.agentControlApproval.attachTitle'
          : 'rightSidebar.iosSimulator.agentControlApproval.createTitle',
      ),
      description: t('rightSidebar.iosSimulator.agentControlApproval.description'),
    };
  }
  return undefined;
}
