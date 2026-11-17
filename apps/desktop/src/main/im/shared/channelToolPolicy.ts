/**
 * channelToolPolicy.ts
 * ---------------------------------------------------------------------------
 * 渠道 per-turn 权限策略(个人微信 / Telegram 群 / 钉钉群)共用的
 * `forceConfirmToolCall` 判定。三个渠道此前各自内联了一份几乎相同的嵌套解包,
 * 且只认 Claude `call_tool`(input.name)与 Codex MCP elicitation
 * (input.toolParams.name)两种 wrapper —— 对 Pi 的桥接 MCP 与二级分派插件
 * (`ghost_call{tool}` / `call_tool{name}`)不覆盖,破坏性操作名藏在 input.tool /
 * input.args.name 里时会漏判(设计方案 §7.8)。
 *
 * 收敛到这里一处,保证任何声明 turnPermissionPolicy 的 agent(CC/Codex/Pi)在所有
 * 渠道用同一份工具词表判定,不会出现"为某渠道实现、别的渠道意外开闸"。
 */

import type { TurnPermissionPolicy } from '@cindy/maker-core';

import {
  checkDestructiveToolCall,
  type GuardResult,
} from '../../destructiveGuard';

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * 二级分派 / 包装工具里,内层动作名常带这些语义 —— 它们不含 delete/remove 词根,
 * 却同样会不可逆地改写内容,保守地强制确认。
 */
const DESTRUCTIVE_INNER_NAME_RE = /(?:^|_)(?:merge|system_write|overwrite)(?:_|$)/i;

// These scheduler actions can install a command, resume it, or trigger it now.
// A restored trusted MCP must still pass the channel's per-turn approval.
const SCHEDULER_EXECUTION_TOOL_NAMES = new Set([
  'schedule_create', 'schedule_update', 'schedule_set_pre_run_hook',
  'schedule_resume', 'schedule_run_now',
]);

function schedulerExecutionNeedsConfirmation(toolName: string): boolean {
  return SCHEDULER_EXECUTION_TOOL_NAMES.has(toolLeafName(toolName));
}

function isOpaqueWriteToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized === 'file_change' || normalized === 'permissions';
}

/** 一个待判定的内层调用:动作名 + 供 shell 命令检查的入参对象。 */
interface InnerCall {
  name: string;
  args: Record<string, unknown> | null;
}

function dispatcherKind(toolName: string): 'call-tool' | 'ghost-call' | null {
  const normalized = toolName.toLowerCase();
  if (normalized === 'call_tool' || normalized.endsWith('__call_tool')) return 'call-tool';
  if (normalized === 'ghost_call' || normalized.endsWith('__ghost_call')) return 'ghost-call';
  return null;
}

/**
 * 从一次工具调用的 input 里剥出所有可能的"内层真实动作"。覆盖:
 *  - Codex MCP elicitation:input.toolParams.name(+ toolParams.args)
 *  - Claude / Pi `call_tool`:input.name(+ input.args)
 *  - Pi `ghost_call`:input.tool(+ input.args)
 *  - 二级分派再嵌套(如 ghost_call{tool:'call_tool', args:{name}}):对 args 递归下探
 * depth 上限防御畸形/自引用输入。
 */
function* unwrapInnerCalls(
  outerToolName: string,
  input: unknown,
  depth = 0,
): Generator<InnerCall> {
  if (depth > 3) return;
  const rec = record(input);
  if (!rec) return;

  const toolParams = record(rec.toolParams);
  if (typeof toolParams?.name === 'string') {
    yield { name: toolParams.name, args: record(toolParams.args) ?? toolParams };
    if (dispatcherKind(toolParams.name)) {
      yield* unwrapInnerCalls(toolParams.name, toolParams.args, depth + 1);
    }
  }

  if (dispatcherKind(outerToolName) === 'call-tool' && typeof rec.name === 'string') {
    yield { name: rec.name, args: record(rec.args) ?? rec };
    if (dispatcherKind(rec.name)) {
      yield* unwrapInnerCalls(rec.name, rec.args, depth + 1);
    }
  }

  if (dispatcherKind(outerToolName) === 'ghost-call' && typeof rec.tool === 'string') {
    yield { name: rec.tool, args: record(rec.args) ?? rec };
    if (dispatcherKind(rec.tool)) {
      yield* unwrapInnerCalls(rec.tool, rec.args, depth + 1);
    }
  }
}

/**
 * Hard-deny check used immediately before a channel confirmation is shown.
 * The outer wrapper name itself is not destructive, so the ordinary guard must
 * also inspect the real action nested inside Pi/Claude/Codex dispatch wrappers.
 * This intentionally returns only destructiveGuard results; semantic wrapper
 * names such as `merge` remain confirmable rather than permanently denied.
 */
export function checkChannelDestructiveToolCall(
  toolName: string,
  input: unknown,
): GuardResult {
  const direct = checkDestructiveToolCall(toolName, record(input));
  if (direct.destructive) return direct;
  for (const inner of unwrapInnerCalls(toolName, input)) {
    const nested = checkDestructiveToolCall(inner.name, inner.args);
    if (nested.destructive) return nested;
  }
  return { destructive: false };
}

/** Pi management is confirmable, not a hard-denied destructive operation. */
function piManagementNeedsConfirmation(toolName: string, input: unknown): boolean {
  const name = toolLeafName(toolName);
  if (name !== 'cindy_pi_command' && name !== 'cindy_pi_extension') return false;
  const payload = record(input);
  // Legacy action/source calls are mutations. Unknown inputs remain confirmable;
  // the Host parser still owns command validity and rejects unsupported syntax.
  if (!Array.isArray(payload?.args) || payload.action !== undefined || payload.source !== undefined) return true;
  const args = payload.args;
  if (args.some(arg => typeof arg !== 'string')) return true;
  if (args.length === 1 && ['--version', '-v', '--help', '-h', 'list'].includes(args[0])) return false;
  if (args.length === 2 && args[0] === 'list' && ['--no-approve', '-na'].includes(args[1])) return false;
  if (args.length === 2 && ['install', 'update', 'remove', 'uninstall', 'list', 'config'].includes(args[0])
      && ['--help', '-h'].includes(args[1])) return false;
  return true;
}

/**
 * 渠道策略的强制确认判定:命中即要求用户逐次确认(无卡片渠道走文本确认)。
 * true = 必须确认;false = 交回该渠道 agent 的常规审批链。
 */
export function channelForceConfirmToolCall(toolName: string, input: unknown): boolean {
  // 1. 顶层工具名 / shell 命令(Bash/bash/PowerShell)直接命中破坏性规则。
  if (checkChannelDestructiveToolCall(toolName, input).destructive) return true;
  if (piManagementNeedsConfirmation(toolName, input)) return true;
  if (schedulerExecutionNeedsConfirmation(toolName)) return true;

  // 2. 包装 / 二级分派的内层动作。
  for (const inner of unwrapInnerCalls(toolName, input)) {
    if (piManagementNeedsConfirmation(inner.name, inner.args)
        || schedulerExecutionNeedsConfirmation(inner.name)
        || isOpaqueWriteToolName(inner.name) || DESTRUCTIVE_INNER_NAME_RE.test(inner.name)) {
      return true;
    }
  }

  // 3. Codex 不透明写:fileChangeApproval 不带 patch 正文,permissions 升权可授权
  //    不透明写入 —— 保守地强制确认,而不是自动放行一次可能的删除。
  return isOpaqueWriteToolName(toolName);
}

/**
 * 已知只读叶子名。群上下文把外人可控文本注入 owner 轮次时,只有这些
 * 可以不经确认自动跑;Write / Edit / Bash / 发文件 / 浏览器 / 插件调用一律要确认。
 * 词表按小写叶子比对,兼容 Claude `Read`、Pi `read`、MCP `mcp__x__list_tools`。
 */
const READ_ONLY_CHANNEL_TOOL_LEAVES = new Set([
  'read',
  'glob',
  'grep',
  'ls',
  'notebookread',
  'list_tools',
]);

function toolLeafName(toolName: string): string {
  const normalized = toolName.toLowerCase();
  const mcp = normalized.match(/^(?:mcp__)?(?:[\w.-]+(?:__|::))+([\w.-]+)$/);
  if (mcp) return mcp[1];
  const last = normalized.split(/[:/]/).pop();
  return last || normalized;
}

export function isReadOnlyChannelToolName(toolName: string): boolean {
  return READ_ONLY_CHANNEL_TOOL_LEAVES.has(toolLeafName(toolName));
}

/**
 * 飞书群轮次用的更严策略:破坏性 / 不透明写沿用 channelForceConfirmToolCall,
 * 此外凡不是只读叶子的工具(含包装内层)一律强制确认。
 * 读/搜目录自由通过;改文件、跑命令、发本地文件、开浏览器必须主人点卡。
 */
export function channelForceConfirmMutatingToolCall(toolName: string, input: unknown): boolean {
  if (channelForceConfirmToolCall(toolName, input)) return true;
  const inners = [...unwrapInnerCalls(toolName, input)];
  if (inners.length > 0) {
    return inners.some((inner) => !isReadOnlyChannelToolName(inner.name));
  }
  return !isReadOnlyChannelToolName(toolName);
}

// ── 访客轮次里的 Cindy 记忆 ──────────────────────────────────────────────────
//
// 渠道自有任务用的是 Cindy 记忆, 其中「关于你」那一份是主人账号级的、每个项目都生效。
// 群成员 / 外部用户触发的轮次里, 对这份记忆的读写必须进入审批链由主人确认
// (docs/product-rules/cindy-memory.md §7): cindy_memory 是可信 server, 不拦的话
// 访客一句话就能让 Agent 把主人的记忆读出来回到群里。

/** 记忆 server 里的动作名; 不同包装下外层名字各异, 内层动作名是稳定的。 */
const MEMORY_ACTION_NAME_RE = /^memory_[a-z_]+$/;

/**
 * 是不是对 cindy_memory 的一次调用 (只读的发现入口 list_tools 除外)。覆盖三种形态:
 * Claude / Pi 的 `mcp__cindy_memory__<tool>`、Codex 的 `mcp:cindy_memory` + toolParams、
 * 以及任何包装里内层动作名是 `memory_*` 的调用。认不准时按「是」处理 (多确认一次)。
 */
export function isCindyMemoryToolCall(toolName: string, input: unknown): boolean {
  const normalized = toolName.toLowerCase();
  if (normalized.startsWith('mcp__cindy_memory__')) {
    return normalized !== 'mcp__cindy_memory__list_tools';
  }
  if (normalized === 'mcp:cindy_memory') {
    const inner = record(record(input)?.toolParams)?.name;
    return !(typeof inner === 'string' && inner.toLowerCase() === 'list_tools');
  }
  if (MEMORY_ACTION_NAME_RE.test(toolLeafName(toolName))) return true;
  for (const inner of unwrapInnerCalls(toolName, input)) {
    if (MEMORY_ACTION_NAME_RE.test(inner.name.toLowerCase())) return true;
  }
  return false;
}

/**
 * 这一轮的发起人不是宿主核实过的主人: 访客, 或群里身份没能核实的人。
 * 私聊里身份未知 (个人微信恒为 unknown) 不算 —— 那里对话的另一端就是用它的人,
 * 逐次确认只会让主人自己每次用记忆都被打断。
 */
export function isGuestTurnAuthority(
  context: TurnPermissionPolicy['autoReviewContext'] | undefined,
): boolean {
  if (!context) return false;
  return context.requesterAuthority === 'guest'
    || (context.requesterAuthority === 'unknown' && context.source === 'group');
}

/** channelForceConfirmToolCall + 记忆调用; 访客轮次用。函数身份固定, 远程协议按它编码。 */
export function channelGuestForceConfirmToolCall(toolName: string, input: unknown): boolean {
  return channelForceConfirmToolCall(toolName, input) || isCindyMemoryToolCall(toolName, input);
}

/** channelForceConfirmMutatingToolCall + 记忆调用; 访客轮次用。 */
export function channelGuestForceConfirmMutatingToolCall(toolName: string, input: unknown): boolean {
  return channelForceConfirmMutatingToolCall(toolName, input) || isCindyMemoryToolCall(toolName, input);
}

/**
 * 访客轮次的策略加上「记忆调用要主人确认」。主人的轮次原样返回。
 * 只用于渠道自有任务: 伙伴任务用的是伙伴自己的记忆, 不经过这里。
 */
export function withGuestMemoryConfirmation(policy: TurnPermissionPolicy): TurnPermissionPolicy {
  if (!isGuestTurnAuthority(policy.autoReviewContext)) return policy;
  const current = policy.forceConfirmToolCall;
  if (current === channelGuestForceConfirmToolCall || current === channelGuestForceConfirmMutatingToolCall) {
    return policy;
  }
  const next: TurnPermissionPolicy['forceConfirmToolCall'] =
    current === channelForceConfirmToolCall
      ? channelGuestForceConfirmToolCall
      : current === channelForceConfirmMutatingToolCall
        ? channelGuestForceConfirmMutatingToolCall
        : (toolName, input) =>
            current.call(policy, toolName, input) || isCindyMemoryToolCall(toolName, input);
  return { ...policy, forceConfirmToolCall: next };
}
