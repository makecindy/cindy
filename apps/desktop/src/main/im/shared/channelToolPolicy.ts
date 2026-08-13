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

/**
 * 渠道策略的强制确认判定:命中即要求用户逐次确认(无卡片渠道走文本确认)。
 * true = 必须确认;false = 交回该渠道 agent 的常规审批链。
 */
export function channelForceConfirmToolCall(toolName: string, input: unknown): boolean {
  // 1. 顶层工具名 / shell 命令(Bash/bash/PowerShell)直接命中破坏性规则。
  if (checkChannelDestructiveToolCall(toolName, input).destructive) return true;

  // 2. 包装 / 二级分派的内层动作。
  for (const inner of unwrapInnerCalls(toolName, input)) {
    if (isOpaqueWriteToolName(inner.name) || DESTRUCTIVE_INNER_NAME_RE.test(inner.name)) {
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
