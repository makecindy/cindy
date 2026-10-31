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
 *   3. cindy-art ghost_call —— 第一方作图/视频内层工具静默；其它插件继续走会话审批
 *   4. 敏感聚合调用（含 browser recipe）—— 每次进入现有会话审批
 *   5. TRUSTED_MCP_SERVERS —— 已 review 的第一方 server，其余调用静默
 *   6. 其余                —— 进入会话审批（第三方 server、cindy_ssh、其它 ghost_call…）
 * 风险分类不覆盖会话档位：Full Access 免操作审批，Auto 走统一审阅，Ask 才交用户确认。
 */

import type {
  McpToolApprovalContext,
  McpToolApprovalPolicy,
} from '@cindy/maker-core';
import { canAutoApproveContactsMcpTool } from '@cindy/mcps';
import { ORCA_TASK_ACTION_TOOLS, TASK_ACTION_TOOLS } from '../maker-ipc/taskActionAuthorization.js';


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
  'cindy::ghost_manual',
  // Query stays local; market discovery fetches catalog metadata without reconciliation.
  'cindy::ghost_market_search',
  'cindy::ghost_forge_guide',
  'cindy_browser::list_tools',
  'cindy_android::list_tools',
  'cindy_computer::list_tools',
  'cindy_feishu_bot::list_tools',
  'cindy_scheduler::list_tools',
  'cindy_ssh::list_tools',
  'cindy_helper::list_tools',
  // cindy_docs 六个工具顶层暴露(2026-08-21)。两个只读工具免审批:路径由
  // cindy-docs/_paths.ts 钳制在会话 workingDir 内,不写盘、不出境。inspect_pdf
  // 尤其要免审批 —— 它是「出完 PDF 回读自检」闭环的一步,卡审批模型就会跳过自检
  // 直接交付。四个落盘工具(make_docx/make_pptx/make_xlsx/render_pdf)不在此表。
  'cindy_docs::read_sheet',
  'cindy_docs::inspect_pdf',
  'cindy_memory::list_tools',
  'cindy_contacts::list_tools',
  'cindy_slack::slack_status',
  // 只读当前 Telegram 对话的信息(chat 由逐轮作用域钉死, 无自由文本参数, 不出境)。
  'cindy_telegram_bot::get_chat',
  // 只读当前飞书对话的信息 / 某条消息(chat 由逐轮作用域钉死, message_id 需在本 chat 内)。
  'cindy_feishu_bot::get_chat',
  'cindy_feishu_bot::get_message',
]);

/**
 * 整体静默执行的第一方 server。
 *
 * 这里不能按 `cindy_` 前缀放行：namespace 只表示品牌归属，不代表新 provider
 * 已完成权限 review。SSH（在已配置主机上跑任意命令）、插件宿主 `cindy`
 * （`ghost_call` 转发到第三方插件沙箱）与第三方 server 都不在表内，继续走会话审批；
 * Contacts 走 inner-tool 细粒度策略。
 */
const TRUSTED_MCP_SERVERS: ReadonlySet<string> = new Set([
  'cindy_android',
  'cindy_browser',
  'cindy_computer',
  // 飞书轮次里往当前对话发消息 / 文件、表情、置顶与 send_*_to_user: 与 bot 自己回复同一出口,
  // 目标由逐轮作用域钉死。call_api / recall_message 单独在下方按次审批。
  'cindy_feishu_bot',
  // Telegram 轮次里往当前对话发消息 / 媒体 / 投票、表情、下载对方文件: 与 bot 自己
  // 回复同一出口, 目标 chat 由逐轮作用域钉死。call_api / delete_message 单独在下方按次审批。
  'cindy_telegram_bot',
  'cindy_slack',
  'cindy_scheduler',
  'cindy_memory',
  'cindy_helper',
  'cindy_orca',
  // worker → lead 回报通道。执行边界在工具内部 fail-closed
  // (resolveWorkerLink 按 session ctx 校验 worker link 归属), 逐次弹窗只会
  // 让远端 daemon 等审批超时、worker 回报断链。
  'orca_worker_bridge',
  // 个人版制作任务的完成回报通道。只落一条完成记录,不碰文件;执行边界在工具内部
  // fail-closed(按 session ctx 的 cindy-make 标记),普通任务调不到。
  'cindy_make',
  'cindy_lsp',
]);

/**
 * 按「Host 最终会拿到的那个值」读取 payload。
 *
 * `call_tool` 的 `args` 走 `jsonObjectArg`（见 lizi-mcps/json-object-arg.ts）：Claude Code
 * 的 in-process bridge 会把嵌套 payload 先 `JSON.stringify`（issue #350），入参校验前
 * 会再 parse 回对象。审批若只看原始字符串，判定的就不是 Host 实际执行的那个值。
 */
function readJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 第一方 Cindy Art 的媒体生成工具。风险是额度而非越权，用户点名作图即授权。 */
const CINDY_ART_MEDIA_TOOLS: ReadonlySet<string> = new Set([
  'gen_image',
  'edit_image',
  'gen_video',
  'edit_video',
]);

/**
 * ghost_call 是聚合入口，默认逐次确认。Cindy Art 的作图/改图/视频是第一方媒体
 * 能力，用户发「画一张」即构成授权；Auto-review 下再弹卡会把常规作图变成手动授权。
 * 读不出 ghost_id / tool 时 fail closed，其它插件不受影响。
 */
function canAutoApproveCindyArtGhostCall(context: McpToolApprovalContext): boolean {
  if (context.serverName !== 'cindy') return false;
  if (context.toolName !== 'ghost_call' && context.toolName !== undefined) return false;
  const params = readJsonObject(context.toolParams);
  if (!params) return false;
  const ghostId = typeof params.ghost_id === 'string' ? params.ghost_id.trim() : '';
  const tool = typeof params.tool === 'string' ? params.tool.trim() : '';
  return ghostId === 'cindy-art' && CINDY_ART_MEDIA_TOOLS.has(tool);
}

/** cindy_scheduler 里接受 `device` 的写工具（与 packages/lizi-mcps/src/scheduler 的 writeDeviceShape 一致）。 */
const SCHEDULER_CROSS_DEVICE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'schedule_update',
  'schedule_pause',
  'schedule_resume',
  'schedule_delete',
  'schedule_run_now',
]);

/** `device` 指向本机以外的电脑。缺省与 "local" 是本机；其余值（含形状异常）一律按非本机处理。 */
function targetsAnotherComputer(device: unknown): boolean {
  return device !== undefined && device !== null && device !== 'local';
}

/** `deviceId::sessionId` 的设备段；本机 id（无前缀或前缀残缺）返回 undefined。 */
function sessionIdDevice(sessionId: unknown): string | undefined {
  if (typeof sessionId !== 'string') return undefined;
  const split = sessionId.indexOf('::');
  return split > 0 && split < sessionId.length - 2 ? sessionId.slice(0, split) : undefined;
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
  // Codex 的 elicitation 不总是带 toolName（0.142.5 / 0.144.1 会省略）。
  // 精确只读规则此时不命中；helper 等敏感 server 在下方按 payload 单独判定。
  if (toolName && READ_ONLY_MCP_TOOLS.has(`${serverName}::${toolName}`)) {
    return 'auto-approve';
  }
  // Recipes can write through an authenticated profile or be overridden by L2.
  // Route the exact invocation through the existing session flow, never trust
  // caller-supplied access metadata or reuse a server grant. Full Access/Auto/Ask
  // retain their existing semantics; discovery and ordinary browser actions stay trusted.
  if (serverName === 'cindy_browser') {
    const params = readJsonObject(toolParams);
    // Without an outer name, only an exact progressive envelope is unambiguous.
    // A direct browser call can itself carry name/args plus action=recipe.
    if (!toolName && (!params || Object.keys(params).some(key => key !== 'name' && key !== 'args'))) {
      return 'prompt-each-time';
    }
    const progressive = toolName === 'call_tool' || !toolName;
    const name = progressive ? (typeof params?.name === 'string' ? params.name.trim() : '') : toolName;
    const args = progressive ? readJsonObject(params?.args) : params;
    if ((name === 'browser' && args?.action === 'recipe')
      || (progressive && (!name || !args))) return 'prompt-each-time';
    // Switching to the user's own browser hands the agent their signed-in Chrome/Edge tabs; a page could
    // ask the agent to do it. The switch goes through the session's approval like a recipe; the user
    // choosing My browser in Settings needs no tool call and so no approval.
    if (name === 'browser' && args?.action === 'setBackend' && args.backend === 'user-browser')
      return 'prompt-each-time';
    // Uploading hands a local file to a website. Files are not filtered by name (2026-10-30), so each
    // upload goes through the task's approval: Ask confirms, Auto reviews, Full Access proceeds.
    if (name === 'browser' && args?.action === 'upload') return 'prompt-each-time';
  }
  if (serverName === 'cindy' && toolName === 'ghost_market_install') return 'prompt-each-time';
  // This bridge multiplexes independent imported connections and commands with
  // their credentials. A server-wide grant for one tool must not authorize other
  // tools/connections. Use the existing per-call policy, including when Codex
  // omits toolName; Auto and Full Access retain their normal mode semantics.
  if (serverName === 'companion_connections') return 'prompt-each-time';
  // sources/preview/start share one native tool identity. Never persist a grant
  // from discovery that could bypass the policy callback for a later import.
  if (serverName === 'companion_import') return 'prompt-each-time';
  if (serverName === 'cindy_contacts') {
    return canAutoApproveContactsMcpTool({ toolName, toolParams })
      ? 'auto-approve'
      : 'prompt-each-time';
  }
  if (canAutoApproveCindyArtGhostCall(context)) {
    return 'auto-approve';
  }
  // Rebinding a task's workspace delegates its execution root; publishing a Skill
  // uploads local files under the signed-in account. Review each action instead
  // of reusing the trusted helper server shortcut/grant. Session modes still apply.
  if (serverName === 'cindy_helper') {
    const params = readJsonObject(toolParams);
    const progressive = toolName === 'call_tool' || !toolName;
    const innerName = typeof params?.name === 'string' ? params.name.trim() : '';
    const args = progressive ? readJsonObject(params?.args) : params;
    // Codex can omit tool_name when same-server calls overlap. A direct tool's
    // input may also have a `name` field (routine_save does), so only treat an
    // exact name/args envelope as a progressive call without the outer name.
    if (!toolName && (!params || !innerName || !args ||
      Object.keys(params).some((key) => key !== 'name' && key !== 'args'))) {
      return 'prompt-each-time';
    }
    const action = progressive ? innerName : toolName;
    // Use the normal runtime permission flow once: Full Access bypasses approval,
    // Auto reviews the call, and Ask requests confirmation. Host guards retain scope checks.
    if (action && TASK_ACTION_TOOLS.has(action)) return 'prompt-each-time';
    if (toolName === 'call_tool' && (!innerName || !args)) return 'prompt-each-time';
    // Installing or saving a host command uses the session's existing approval flow.
    if (action === 'schedule_set_pre_run_hook' || (action === 'routine_save' && args?.preRunHook != null)) {
      return 'prompt-each-time';
    }
    // 后台命令是任意 shell 执行面(借宿主进程绕开 bash 的同步超时):每次调用都
    // 交会话权限档判定,不享受可信 helper server 的静默放行。
    if (action === 'run_command_background') return 'prompt-each-time';
    if (action === 'move_session' || action === 'publish_skill') return 'prompt-each-time';
    // Moving a teammate hands its running to another computer: the task's permission mode decides.
    if (action === 'move_teammate_home') return 'prompt-each-time';
    // 发给另一台电脑上的任务：作用范围越出本机，交给当前任务的权限档，不走可信 server 的静默放行。
    if (action === 'send_to_session' && targetsAnotherComputer(sessionIdDevice(args?.target_session_id))) {
      return 'prompt-each-time';
    }
    // 伙伴跟进另一台电脑上的任务(只有总调度伙伴可以)同样是跨电脑写入,口径与 send_to_session 一致。
    if (action === 'continue_workbench_task' && targetsAnotherComputer(sessionIdDevice(args?.task_id))) {
      return 'prompt-each-time';
    }
    if ((action === 'archive_sessions' || action === 'unarchive_sessions') &&
      (!Array.isArray(args?.session_ids) || args.session_ids.some((id) =>
        typeof id !== 'string' || targetsAnotherComputer(sessionIdDevice(id))))) {
      return 'prompt-each-time';
    }
  }
  // 改动另一台电脑上的定时任务（可改写并触发那台电脑上的命令）同样交给权限档：Full Access
  // 免审批，Auto 走统一审阅，Ask 由用户确认。本机操作与跨电脑读取保持原样。
  if (serverName === 'cindy_scheduler' && (toolName === 'call_tool' || !toolName)) {
    const params = readJsonObject(toolParams);
    const innerName = typeof params?.name === 'string' ? params.name.trim() : '';
    const args = readJsonObject(params?.args);
    if (SCHEDULER_CROSS_DEVICE_WRITE_TOOLS.has(innerName) && targetsAnotherComputer(args?.device)) {
      return 'prompt-each-time';
    }
  }
  // Telegram 的任意方法直通(call_api)与删消息: 方法名 / 目标由参数决定, 一次放行不能
  // 变成对后续任意方法的授权, 交给会话权限档按次判定(Full Access 免审批, Auto 审阅,
  // Ask 确认)。Codex 省略 toolName 时同样按次, 不借 trusted-server 捷径。
  if (serverName === 'cindy_telegram_bot' && (!toolName || toolName === 'call_api' || toolName === 'delete_message')) {
    return 'prompt-each-time';
  }
  // 飞书同口径: 任意 Open API 与撤回按次审批; 省略 toolName 时无法分辨是不是这两个, fail closed。
  if (serverName === 'cindy_feishu_bot' && (!toolName || toolName === 'call_api' || toolName === 'recall_message')) {
    return 'prompt-each-time';
  }
  // Orca mutations use the same per-call runtime flow as helper task writes.
  // Reuse the Host's action set so no mutation slips through the trusted-server
  // shortcut. Full Access still bypasses; read-only Orca operations stay trusted.
  if (serverName === 'cindy_orca') {
    if (!toolName || ORCA_TASK_ACTION_TOOLS.has(toolName)) return 'prompt-each-time';
  }
  if (TRUSTED_MCP_SERVERS.has(serverName)) {
    return 'auto-approve';
  }
  return 'prompt';
}
