/**
 * 原生 Agent 会话重建时的交接(handoff)构造与注入工具。当前用于跨引擎切换
 * 和消息删除后的同引擎上下文重建。
 *
 * 设计原则(规则 9:代码保证确定性):
 *  - 交接文本由代码从 DB 消息历史确定性拼接——最近 K 轮逐字(带截断)+ 更早轮次
 *    单行提要,不经 LLM 生成,零额外延迟、可单测、可复现。
 *  - 注入走"wire 前缀"通道:发给新引擎的 payload 前置交接段,落库/渲染仍是用户
 *    原文(display 与 sent 分离,复用 persistUserMessage 既有机制)。
 *  - 交接全文持久化在 agent_switch 边界或隐藏的 context_rebuild 行中，重启后
 *    pending 状态可从 DB 确定性重建(无额外状态列)。
 */

import { projectPersistedAgentFacingUserText } from '@cindy/maker-shared/agent-input-projection';

/** DB 层引擎标识(sessions.agent_kind / messages.agent_kind 的值域)。 */
export type DbAgentKind = 'cc' | 'codex' | 'pi';

/** 构造交接文本所需的最小消息投影(content 已 JSON.parse,即 camel Message.content)。 */
export interface HandoffSourceMessage {
  role: string;
  content: unknown;
  createdAt: number; // unix ms
  /** 生产 tool_result 的关联列；content 经常是纯字符串，不能靠信封里的 toolUseId。 */
  toolUseId?: string | null;
}

export interface BuildHandoffOptions {
  /** 展示给模型的旧引擎名(如 'Claude Code')。 */
  fromLabel: string;
  /** 展示给模型的新引擎名(如 'Codex')。 */
  toLabel: string;
  /**
   * business 层会话 id。提供时交接文本附带「早期原文检索」指引——新引擎可用
   * cindy_helper 的 get_chat_history / search_chat_history(带 session_ids
   * 定向过滤)按需检索本会话完整历史:摘要管大局、检索管细节,消除逐字窗口外
   * 的细节性失忆。两家引擎的会话都挂了该 MCP server。
   */
  sessionId?: string;
  /**
   * Phase 2(切回复用停泊原生会话):
   *  - 'full'(缺省)= 目标引擎全新原生会话,交接覆盖整场对话;
   *  - 'delta' = 目标引擎 resume 自己的停泊原生会话,已持有离场前的完整记忆,
   *    messages 只传"离场期间"的增量,framing 改为归位续接口径。
   */
  mode?: 'full' | 'delta';
  /**
   * 工作状态区(改动文件/命令清单)的提取源,缺省 = messages。delta 模式传
   * 全量历史:文件/命令清单是最耐久的交接载体,即使 resume 静默失效(原生
   * 会话过期等不可检测场景),增量交接也保有全局工作现场,不至于失明。
   */
  workStateMessages?: HandoffSourceMessage[];
  /**
   * 交接触发原因。message-deletion 表示同一引擎因本地消息被删除而重建原生
   * 上下文；context-overflow 表示同一引擎因窗口超限而换干净原生会话；
   * pi-prompt-timeout 表示原生会话对 prompt 无响应后用户重试换窗。
   */
  reason?: 'agent-switch' | 'message-deletion' | 'context-overflow' | 'pi-prompt-timeout';
}

/** 最近多少个用户轮次进入逐字区(其余进单行提要区)。 */
const RECENT_TURNS = 4;
/** 逐字区单条 user / assistant 文本上限(字符)。 */
const RECENT_TEXT_CAP = 2000;
/** 工具调用行的 input 摘要上限(字符)。 */
const TOOL_INPUT_CAP = 160;
/** 提要区总预算(字符),超出时从最旧行开始丢弃。 */
const DIGEST_BUDGET = 3000;
/** 提要区单行上限(字符)。 */
const DIGEST_LINE_CAP = 120;
/** 最终交接文本硬上限(字符)——最后一道保险,正常路径不应触达。 */
const HANDOFF_HARD_CAP = 16000;
/** 单轮详细行最多保留首尾各 20 条；防工具密集轮撑爆全部预算。 */
const DETAIL_LINES_EDGE_CAP = 20;
/** 工具密集/多 assistant block 单轮的详细区字符预算。 */
const DETAIL_LINES_CHAR_BUDGET = 9000;
const DETAIL_LINE_COMPACT_CAP = 240;

/** 合成指令行前缀(makerChatStore isSyntheticTrigger 同款标记),不进交接。 */
const SYNTHETIC_TRIGGER_PREFIX = '[UI_ACTION_TRIGGER]';

/** 工作状态区:改动文件清单上限。 */
const CHANGED_FILES_CAP = 20;
/** 工作状态区:命令清单上限(取最近 N 条)。 */
const COMMANDS_CAP = 10;
/** 工作状态区:单条命令摘要上限(字符)。 */
const COMMAND_LINE_CAP = 120;

/** 会写文件的工具名(Claude 系 + Codex 系),input 里带路径字段。 */
const FILE_EDIT_TOOL_NAMES = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
  'str_replace_editor',
]);
/** 执行命令的工具名(Claude Bash / Codex shell 系)。 */
const COMMAND_TOOL_NAMES = new Set(['Bash', 'shell', 'exec_command', 'local_shell']);

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}…(truncated)`;
}

/** 折叠换行成单行(提要区用)。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 从持久化 content 中容错抽取纯文本。支持三种历史形态(对齐 renderer
 * parseUserContent 的分支语义,但此处只取 text,不管附件):
 *  1. string —— 纯文本,或 JSON 序列化后的 {text,...} / SDK blocks;
 *  2. array —— SDK content blocks,拼接 text block;
 *  3. object —— {text, images, files}(stringifyUserContent 形态)或 {text} / {message}。
 */
export function extractPlainText(content: unknown): string {
  if (typeof content === 'string') {
    if (content.length === 0) return '';
    const first = content[0];
    if (first === '{' || first === '[') {
      try {
        return extractPlainText(JSON.parse(content));
      } catch {
        return content;
      }
    }
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
    return parts.join('\n');
  }
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.text === 'string') {
      return projectPersistedAgentFacingUserText(c) ?? c.text;
    }
    if (typeof c.message === 'string') return c.message;
  }
  return '';
}

function isStringifyUserContentEnvelope(
  value: unknown,
): value is { text: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.text === 'string'
    && Array.isArray(record.images)
    && Array.isArray(record.files);
}

/** 岛上预览正文:只解开 stringifyUserContent 信封,JSON 原文提示保持原样。 */
export function extractAgentIslandPromptText(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isStringifyUserContentEnvelope(parsed)) {
          const text = parsed.text.trim();
          return text || null;
        }
      } catch {
        // 用户原文就是 JSON 形字符串。
      }
    }
    return trimmed;
  }
  if (isStringifyUserContentEnvelope(content)) {
    const text = content.text.trim();
    return text || null;
  }
  const text = extractPlainText(content).trim();
  return text || null;
}

interface Turn {
  userText: string;
  /** 轮内按序的展示行(assistant 文本 / 工具行 / 错误行)。 */
  detailLines: string[];
  /** 轮内最后一段 assistant 文本(提要区用)。 */
  lastAssistantText: string;
}

/**
 * 工作状态(结构化,社区 handoff packet 公认最有价值的部分——比对话记录更耐久):
 * 从 tool_use 行确定性提取改动文件与执行过的命令。见 knightli 交接手册 /
 * claude-handoff 的字段收敛:Changed Files / Verification Run。
 */
interface WorkState {
  changedFiles: string[];
  commands: Array<{ command: string; outcome?: string }>;
  failedPaths: string[];
}

function commandTextOf(input: Record<string, unknown>): string {
  const raw = input.command;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string').join(' ');
  return '';
}

function toolUseIdOf(message: HandoffSourceMessage, content?: Record<string, unknown>): string {
  if (typeof message.toolUseId === 'string' && message.toolUseId) return message.toolUseId;
  if (!content) return '';
  return typeof content.toolUseId === 'string'
    ? content.toolUseId
    : typeof content.id === 'string'
      ? content.id
      : '';
}

function extractFailedPathHints(text: string): string[] {
  const hints: string[] = [];
  for (const line of text.split('\n')) {
    const match = line.match(/\bFAIL\s+(\S+)/) ?? line.match(/(\S+\.(?:test|spec)\.\w+)/);
    if (!match?.[1]) continue;
    hints.push(truncate(match[1], 80));
    if (hints.length >= 3) break;
  }
  return hints;
}

function extractCommandOutcome(content: Record<string, unknown>): string | undefined {
  if (content.isError === true) return 'failed';
  if (typeof content.exitCode === 'number' && Number.isFinite(content.exitCode)) {
    return `exit ${content.exitCode}`;
  }
  const text = extractPlainText(content.fullText ?? content.output ?? content.content ?? content);
  const exitMatch = text.match(/exit(?:ed)?(?:\s+code)?[:\s]+(-?\d+)/i);
  if (exitMatch) return `exit ${exitMatch[1]}`;
  if (/\b(tests? failed|failing tests|assertionerror)\b/i.test(text)) return 'tests failed';
  if (content.isError === false) return 'ok';
  return undefined;
}

function isFailedOutcome(outcome: string | undefined): boolean {
  if (!outcome) return false;
  if (outcome === 'ok' || outcome === 'exit 0') return false;
  return true;
}

function extractWorkState(messages: HandoffSourceMessage[]): WorkState {
  const files = new Set<string>();
  const commands: Array<{ command: string; outcome?: string }> = [];
  const commandByToolUseId = new Map<string, number>();
  const failedPaths: string[] = [];
  for (const msg of messages) {
    const objectContent =
      msg.content && typeof msg.content === 'object' && !Array.isArray(msg.content)
        ? (msg.content as Record<string, unknown>)
        : undefined;
    if (msg.role === 'tool_use') {
      if (!objectContent) continue;
      const name = typeof objectContent.toolName === 'string' ? objectContent.toolName : '';
      const input = (
        objectContent.input && typeof objectContent.input === 'object'
          ? objectContent.input
          : {}
      ) as Record<string, unknown>;
      if (FILE_EDIT_TOOL_NAMES.has(name)) {
        for (const key of ['file_path', 'path', 'notebook_path']) {
          const v = input[key];
          if (typeof v === 'string' && v) files.add(v);
        }
      } else if (COMMAND_TOOL_NAMES.has(name)) {
        const cmd = commandTextOf(input);
        if (!cmd) continue;
        const entry = { command: truncate(oneLine(cmd), COMMAND_LINE_CAP) };
        const index = commands.push(entry) - 1;
        const toolUseId = toolUseIdOf(msg, objectContent);
        if (toolUseId) commandByToolUseId.set(toolUseId, index);
      }
      continue;
    }
    if (msg.role !== 'tool_result') continue;
    const toolUseId = toolUseIdOf(msg, objectContent);
    const index = toolUseId ? commandByToolUseId.get(toolUseId) : undefined;
    if (index === undefined) continue;
    const outcomeSource =
      objectContent ??
      (typeof msg.content === 'string' ? { fullText: msg.content } : undefined);
    if (!outcomeSource) continue;
    const outcome = extractCommandOutcome(outcomeSource);
    if (!outcome) continue;
    commands[index] = { ...commands[index]!, outcome };
    if (isFailedOutcome(outcome)) {
      const rawText =
        typeof msg.content === 'string'
          ? msg.content
          : extractPlainText(outcomeSource.fullText ?? outcomeSource.output ?? outcomeSource);
      const hints = extractFailedPathHints(rawText);
      if (hints.length > 0) failedPaths.push(...hints);
      else failedPaths.push(`${commands[index]!.command} → ${outcome}`);
    }
  }
  return {
    changedFiles: [...files].slice(-CHANGED_FILES_CAP),
    commands: commands.slice(-COMMANDS_CAP),
    failedPaths: failedPaths.slice(-COMMANDS_CAP),
  };
}

/** 把消息流按 user 行切成轮次。首个 user 行之前的孤儿行并入首轮 detail。 */
function splitTurns(messages: HandoffSourceMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = extractPlainText(msg.content);
      if (text.startsWith(SYNTHETIC_TRIGGER_PREFIX)) continue;
      current = { userText: text, detailLines: [], lastAssistantText: '' };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { userText: '', detailLines: [], lastAssistantText: '' };
      turns.push(current);
    }
    switch (msg.role) {
      case 'assistant': {
        const text = extractPlainText(msg.content);
        if (text) {
          current.detailLines.push(`[Assistant]\n${truncate(text, RECENT_TEXT_CAP)}`);
          current.lastAssistantText = text;
        }
        break;
      }
      case 'tool_use': {
        const c = (msg.content ?? {}) as Record<string, unknown>;
        const name = typeof c.toolName === 'string' ? c.toolName : '(unknown)';
        let inputDigest = '';
        try {
          inputDigest = c.input === undefined ? '' : JSON.stringify(c.input);
        } catch {
          inputDigest = '';
        }
        current.detailLines.push(`[Tool] ${name}${inputDigest ? `: ${truncate(inputDigest, TOOL_INPUT_CAP)}` : ''}`);
        break;
      }
      case 'error': {
        const text = extractPlainText(msg.content);
        if (text) current.detailLines.push(`[Error] ${truncate(oneLine(text), 200)}`);
        break;
      }
      case 'ask_user': {
        current.detailLines.push('[Asked the user a question and got an answer]');
        break;
      }
      case 'plan_review': {
        current.detailLines.push('[Submitted a plan for the user to review]');
        break;
      }
      default:
        // thinking / agent_switch / tool_result 等不进交接正文
        break;
    }
  }
  return turns;
}

function collapseDetailLines(lines: string[]): string[] {
  const totalChars = lines.reduce((sum, line) => sum + line.length + 1, 0);
  const normalized = totalChars > DETAIL_LINES_CHAR_BUDGET
    ? lines.map((line) => truncate(line, DETAIL_LINE_COMPACT_CAP))
    : lines;
  const kept = DETAIL_LINES_EDGE_CAP * 2;
  if (normalized.length <= kept) return normalized;
  const omitted = normalized.length - kept;
  return [
    ...normalized.slice(0, DETAIL_LINES_EDGE_CAP),
    `(${omitted} tool calls omitted)`,
    ...normalized.slice(-DETAIL_LINES_EDGE_CAP),
  ];
}

/**
 * 确定性构造交接文本:framing(第一人称续接 + 不向用户提及)+ 更早轮次提要 +
 * 最近 RECENT_TURNS 轮逐字记录。总长受各区预算约束,最终有 HANDOFF_HARD_CAP 保险。
 */
export function buildHandoffText(
  messages: HandoffSourceMessage[],
  opts: BuildHandoffOptions,
): string {
  const turns = splitTurns(messages);
  // 超出硬上限时逐档收缩逐字区(4→3→2→1 轮)重组——绝不能从尾部硬切:
  // 检索指引与结束标记在尾部,是最不能丢的段。收缩到 1 轮仍超限才走最后的
  // 尾部截断保险。
  for (let recentCount = RECENT_TURNS; recentCount >= 1; recentCount--) {
    const text = assembleHandoffText(turns, messages, opts, recentCount);
    if (text.length <= HANDOFF_HARD_CAP || recentCount === 1) {
      return capPreservingTerminator(text, opts);
    }
  }
  /* istanbul ignore next -- 循环必然 return */
  return capPreservingTerminator(assembleHandoffText(turns, messages, opts, 1), opts);
}

const REBUILD_TERMINATOR = "== End of rebuild note; the user's new message follows ==";
const HANDOFF_TERMINATOR = "== End of handoff note; the user's new message follows ==";
const FORK_TERMINATOR = "== End of fork note; the user's new message follows ==";

/** 结束标记——交接正文与"用户的新消息"之间唯一的分隔,任何情况下都要留住。 */
function handoffTerminator(opts: BuildHandoffOptions): string {
  return opts.reason === 'message-deletion' ||
    opts.reason === 'context-overflow' ||
    opts.reason === 'pi-prompt-timeout'
    ? REBUILD_TERMINATOR
    : HANDOFF_TERMINATOR;
}

/**
 * 升级前已持久化在 agent_switch / context_rebuild 行里的中文结束标记。
 *
 * 这些行的 `content.handoff` 是**存量数据**,不会因为本次英文化而改写;老会话在升级后
 * 仍可能把它们取出来当 pending handoff 用。裁剪时若认不出这些标记,就会把它们连同
 * "以下是用户的新消息" 这个唯一边界一起截掉——所以识别列表必须包含旧格式。
 */
const LEGACY_HANDOFF_TERMINATOR = '== 交接说明结束,以下是用户的新消息 ==';
const LEGACY_REBUILD_TERMINATOR = '== 上下文重建说明结束,以下是用户的新消息 ==';

/**
 * 拆出已有文本尾部的结束标记,供二次裁剪时原样保留。
 *
 * 返回的 `tail` **从标记本身起算**,不含它前面的空行——分隔空行由
 * composeForkOriginHandoff 自己补,这样正文被从中部裁开后仍能保证标记前有空行。
 */
function splitTrailingTerminator(text: string): [body: string, tail: string] {
  const trimmed = text.trimEnd();
  for (const terminator of [
    HANDOFF_TERMINATOR,
    REBUILD_TERMINATOR,
    FORK_TERMINATOR,
    LEGACY_HANDOFF_TERMINATOR,
    LEGACY_REBUILD_TERMINATOR,
  ]) {
    if (!trimmed.endsWith(terminator)) continue;
    const tailStart = trimmed.length - terminator.length;
    return [text.slice(0, tailStart), text.slice(tailStart)];
  }
  return [text, ''];
}

/**
 * 兜底截断:宁可从正文中部切,也必须保住尾部的结束标记。
 *
 * 裸 `slice(0, CAP)` 会把结束标记连同检索指引的尾巴一起削掉,新用户消息就失去了与
 * 内部历史的显式分隔——工具密集的长历史(逐字区已收缩到 1 轮仍超限)真会走到这里,
 * 英文 framing 比原中文长,触达上限更容易。
 */
const RETRIEVAL_SECTION_HEADING = '== Retrieving earlier verbatim history';

function splitMandatoryHandoffTail(text: string, opts: BuildHandoffOptions): {
  body: string;
  tail: string;
} {
  const retrievalAt = text.lastIndexOf(RETRIEVAL_SECTION_HEADING);
  if (retrievalAt >= 0) {
    return {
      body: text.slice(0, retrievalAt).trimEnd(),
      tail: text.slice(retrievalAt),
    };
  }
  const [body, terminatorTail] = splitTrailingTerminator(text);
  return {
    body: body.trimEnd(),
    tail: terminatorTail || `${handoffTerminator(opts)}`,
  };
}

function capPreservingTerminator(text: string, opts: BuildHandoffOptions): string {
  if (text.length <= HANDOFF_HARD_CAP) return text;
  const { body, tail } = splitMandatoryHandoffTail(text, opts);
  const separator = '\n\n';
  const room = HANDOFF_HARD_CAP - tail.length - separator.length;
  if (room <= 0) return tail.slice(0, HANDOFF_HARD_CAP);
  return `${body.slice(0, room)}${separator}${tail}`;
}

function assembleHandoffText(
  turns: Turn[],
  messages: HandoffSourceMessage[],
  opts: BuildHandoffOptions,
  recentCount: number,
): string {
  const recent = turns.slice(-recentCount);
  const earlier = turns.slice(0, -recentCount);

  const sections: string[] = [];
  if (
    opts.reason === 'message-deletion' ||
    opts.reason === 'context-overflow' ||
    opts.reason === 'pi-prompt-timeout'
  ) {
    const rebuildCause =
      opts.reason === 'context-overflow'
        ? `The previous native agent session exceeded the model's context window, so Cindy started a fresh native session in the same task. ` +
          `Below is the valid conversation history before the overflowing turn; treat only these records as the prior conversation, ` +
          `and do not try to recover, cite, or infer messages that are not listed. `
        : opts.reason === 'pi-prompt-timeout'
          ? `The previous native agent session stopped responding to prompts, so Cindy started a fresh native session in the same task. ` +
            `Below is the valid conversation history before the unresponsive turn; treat only these records as the prior conversation, ` +
            `and do not try to recover, cite, or infer messages that are not listed. `
        : `The user edited this conversation's local record, which invalidated the current native session context. ` +
          `Below is the valid conversation history after that edit; treat only these records as the prior conversation, ` +
          `and do not try to recover, cite, or infer messages that are not listed. `;
    sections.push(
      `[Session context rebuild · internal context]\n` +
        rebuildCause +
        `Continue naturally in the first person, and do not mention this rebuild note to the user. ` +
        `Before making any change, check the actual workspace state (e.g. git status / git diff / reading the relevant files): ` +
        `when the record conflicts with the workspace, the workspace always wins; ` +
        `when you are unsure about an earlier detail, read the real files and code to confirm rather than guessing from the index or a guess.`,
    );
  } else if (opts.mode === 'delta') {
    // 归位续接:目标引擎 resume 了自己的停泊原生会话,已持有离场前的完整记忆。
    // 只补"离开期间"的进展;同时防御 resume 静默失效——指引它以工作区与检索为准,
    // 而不是断言"你一定记得"。
    sections.push(
      `[Session handoff · internal context]\n` +
        `You (${opts.toLabel}) worked on this conversation before; it was handed over to the ${opts.fromLabel} engine for a while, and now it is switching back to you. ` +
        `Your memory of the conversation from before you left should still be valid; below is a record of what happened while you were away. ` +
        `Merge it into your understanding and continue naturally in the first person. ` +
        `Do not mention this handoff note to the user, and do not mention the engine switch. ` +
        `Before making any change, check the actual workspace state (e.g. git status / git diff / reading the relevant files): ` +
        `when the record, your own memory, and the workspace disagree, the workspace always wins; ` +
        `when you are unsure about something from while you were away, read the real files and code to confirm rather than guessing from the summary.`,
    );
  } else {
    sections.push(
      `[Session handoff · internal context]\n` +
        `This conversation was previously driven by the ${opts.fromLabel} engine; from here on you (${opts.toLabel}) continue it. ` +
        `Below is the prior record of this conversation — it is the same conversation between you and the user, ` +
        `so continue naturally in the first person. ` +
        `Do not mention this handoff note to the user, and do not say things like "according to the handoff summary/record". ` +
        `Before making any change, check the actual workspace state (e.g. git status / git diff / reading the relevant files): ` +
        `when the record conflicts with the workspace, the workspace always wins; ` +
        `when you are unsure about an earlier detail, read the real files and code to confirm rather than guessing from the summary.`,
    );
  }

  // 工作状态区(结构化):比对话记录更耐久的交接载体——新引擎据此了解
  // 动过哪些文件、跑过哪些命令,避免重复劳动或誤判"还没做过"。
  // delta 模式按 workStateMessages(全量历史)提取,见 BuildHandoffOptions 注释。
  const work = extractWorkState(opts.workStateMessages ?? messages);
  if (work.changedFiles.length > 0 || work.commands.length > 0 || work.failedPaths.length > 0) {
    const lines: string[] = [];
    if (work.changedFiles.length > 0) {
      lines.push('Files changed:');
      for (const f of work.changedFiles) lines.push(`- ${f}`);
    }
    if (work.commands.length > 0) {
      lines.push('Commands (most recent):');
      for (const cmd of work.commands) {
        lines.push(cmd.outcome ? `- ${cmd.command} → ${cmd.outcome}` : `- ${cmd.command}`);
      }
    }
    if (work.failedPaths.length > 0) {
      lines.push('Failed attempts:');
      for (const path of work.failedPaths) lines.push(`- ${path}`);
    }
    sections.push(`== Work ledger (auto-extracted) ==\n${lines.join('\n')}`);
  }

  if (earlier.length > 0) {
    const lines: string[] = [];
    for (const t of earlier) {
      if (t.userText) lines.push(`- User: ${truncate(oneLine(t.userText), DIGEST_LINE_CAP)}`);
      if (t.lastAssistantText) {
        lines.push(`  Reply: ${truncate(oneLine(t.lastAssistantText), DIGEST_LINE_CAP)}`);
      }
    }
    // 预算内保留最新的提要行,最旧的先丢
    let digest = lines.join('\n');
    if (digest.length > DIGEST_BUDGET) {
      const kept: string[] = [];
      let used = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        const cost = lines[i].length + 1;
        if (used + cost > DIGEST_BUDGET) break;
        kept.unshift(lines[i]);
        used += cost;
      }
      digest = `(earlier content omitted)\n${kept.join('\n')}`;
    }
    sections.push(
      opts.mode === 'delta'
        ? `== Earlier progress while you were away ==\n${digest}`
        : `== Earlier conversation index (hints only, not a verified summary) ==\n${digest}`,
    );
  }

  if (recent.length > 0) {
    const blocks: string[] = [];
    for (const t of recent) {
      const parts: string[] = [];
      if (t.userText) parts.push(`[User]\n${truncate(t.userText, RECENT_TEXT_CAP)}`);
      parts.push(...collapseDetailLines(t.detailLines));
      if (parts.length > 0) blocks.push(parts.join('\n'));
    }
    sections.push(
      opts.mode === 'delta'
        ? `== Conversation while you were away ==\n${blocks.join('\n---\n')}`
        : `== Recent conversation ==\n${blocks.join('\n---\n')}`,
    );
  } else if (opts.mode === 'delta') {
    // 切走后一条消息都没发就切回:显式说明,避免引擎误以为漏了记录。
    sections.push('== No new messages while you were away ==');
  }

  if (opts.sessionId) {
    // 早期原文检索指引:逐字窗口外的内容只剩单行提要,用户追问细节时模型必须能
    // 翻到原文。工具名 / 参数是确定性事实(@cindy/mcps xdt-helper,session_ids 过滤,
    // 两个工具均支持),写死在指引里比让模型自己发现可靠(规则 9)。
    sections.push(
      `== Retrieving earlier verbatim history (use when needed) ==\n` +
        `Session id: ${opts.sessionId}\n` +
        `The index above is only a hint. Retrieve earlier verbatim text only when needed (tools live under cindy_helper's history category):\n` +
        `1. First: search_chat_history, args {"query":"<keywords>","session_ids":["${opts.sessionId}"],"limit":10}\n` +
        `2. Only if that is not enough: get_chat_history, args {"session_ids":["${opts.sessionId}"],"roles":["user","assistant"],"limit":20}\n` +
        `Page with nextCursor only when hasMore is true and the needed detail is still missing. Never request the default 200-row page and never dump the full history.\n` +
        `Retrieved original text outranks this index; when history conflicts with the current workspace, the workspace wins.`,
    );
  }

  sections.push(handoffTerminator(opts));
  // 不在组装阶段做任何截断——超限收缩由 buildHandoffText 的外层循环负责
  // (收缩逐字区保住首尾),尾部硬切只是外层最后的保险。
  return sections.join('\n\n');
}

/**
 * fork 出的子会话注入给模型的来源标记。
 *
 * 为什么只有一行:fork 的上下文是原会话前缀的**完整**拷贝,模型不缺记忆,只缺
 * "我是谁、我从哪来" 这一个元信息。agent-switch 那种逐字摘要 + 检索指引在这里
 * 是纯浪费——真需要翻原会话时,history 类工具本来就在工具列表里,不必手把手教。
 *
 * 措辞对两种 fork 都成立:消息级 fork 与 forkSessionStripEncrypted(后者
 * forkedAtMessageId 为 null,不存在"某条消息"),所以只陈述"从哪个会话分叉",
 * 不提分叉点。
 */
export function buildForkOriginHandoff(parentSessionId: string): string {
  return `${forkOriginFactLine(parentSessionId)}\n\n${FORK_TERMINATOR}`;
}

function forkOriginFactLine(parentSessionId: string): string {
  return (
    `[Session fork · internal context]\n` +
    `This conversation was forked by the user from another conversation (id: ${parentSessionId}). ` +
    `Do not mention this note or that id to the user.`
  );
}

/**
 * 把来源标记**并进**已有的 pending 交接,而不是替换它。
 *
 * 必须组合的原因:在引擎切换后的首条 user 消息上 fork 时,fork 事务会刻意把复制
 * 过去的 agent_switch 边界重置为 `consumed: false`(见 WorkerThreadTransport 的
 * sanitizeForkedMessageContent 与 fork.ts 的 resetHandoffBoundaryClientId),让子会话
 * 首次发送时仍拿得到完整的跨引擎交接。若来源标记直接顶掉它,子会话会在没有切换前
 * 上下文的情况下起跑——那正是交接机制本身要防的失忆。
 *
 * 顺序:来源标记在前(只是"我是谁"的元信息),交接正文在后,由交接自带的结束标记
 * 统一收尾,避免出现两个"以下是用户的新消息"。
 */
export function composeForkOriginHandoff(
  parentSessionId: string,
  pendingHandoff: string | null,
): string {
  if (!pendingHandoff) return buildForkOriginHandoff(parentSessionId);
  const fact = forkOriginFactLine(parentSessionId);
  const composed = `${fact}\n\n${pendingHandoff}`;
  if (composed.length <= HANDOFF_HARD_CAP) return composed;
  // 交接正文可能**已经**被 buildHandoffText 顶到上限(工具密集的长历史),再前置
  // fork 事实就会顶破它。从正文中部裁,两头都留住:前面的 fork 事实与它自带的结束
  // 标记——否则这条路径正好在最需要分隔的长历史上丢掉分隔。
  const [body, tail] = splitTrailingTerminator(pendingHandoff);
  const separator = '\n\n';
  // 两个 separator:fact 与正文之间、正文与结束标记之间。后者不能省——正文被从中部
  // 裁开后末尾多半停在半句上,结束标记直接贴上去就毁掉了"显式分隔"这个不变量本身。
  const room = HANDOFF_HARD_CAP - fact.length - separator.length * 2 - tail.length;
  // 极端情形(当前上限下不可达)也要守住优先级:交接关系到跨引擎的对话连续性,
  // 来源标记只是元信息——挤不下时丢后者,绝不能反过来把整段交接换成一行来源说明。
  if (room <= 0) return pendingHandoff;
  return `${fact}${separator}${body.slice(0, room).trimEnd()}${separator}${tail}`;
}

/** send 路径的 wire 消息形态(与 makerSendTransaction 的 IpcUserMessage 对齐)。 */
export type HandoffWireMessage =
  | string
  | { type: 'user'; content: string | Array<{ type: string; [k: string]: unknown }> };

/**
 * 把一段内部说明前置到发给 agent 的 wire 消息上(**不影响落库/显示内容**)。
 * blocks 形态下前插独立 text block,string 形态下直接前拼。
 *
 * 交接前缀与手机客户端说明(mobileClientPromptNote)共用这一份形态处理 —— blocks /
 * string 两态各自前置的写法复制一遍就会有一处写错的风险,判据只留一份。
 */
export function prependNoteToWireUserMessage(
  message: HandoffWireMessage,
  note: string,
): HandoffWireMessage {
  if (typeof message === 'string') {
    return `${note}\n\n${message}`;
  }
  if (typeof message.content === 'string') {
    return { ...message, content: `${note}\n\n${message.content}` };
  }
  return { ...message, content: [{ type: 'text', text: note }, ...message.content] };
}

/** 把交接文本前置到发给 agent 的 wire 消息上(不影响落库/显示内容)。 */
export function prependHandoffToUserMessage(
  message: HandoffWireMessage,
  handoff: string,
): HandoffWireMessage {
  return prependNoteToWireUserMessage(message, handoff);
}

/**
 * pending-handoff 注册表:切换后"下一条 user 消息注入交接前缀"的状态。
 *  - 内存 Map 为一级缓存(null = 已确认无 pending);
 *  - miss 时(app 重启后首次 send)经注入的 queryPending 从 DB 确定性重建
 *    ("最后一条 agent_switch 行之后没有 user 行" ⟺ pending);
 *  - consume 仅在 vendor dispatch 跨过不可逆边界(accepted)后调用,失败保留
 *    pending 下次重试。
 */
export interface AgentHandoffPendingRegistry {
  /**
   * 写入待注入交接。
   *
   * `expectedGeneration` 给"读历史 → 一堆异步活 → 才写回"的调用方(引擎切换、消息
   * 删除)用:它们在读历史之前用 `readGeneration()` 取一次,写回时带上;期间若发生
   * `/clear`,这次写就被丢弃。没有它,一个基于 clear 前历史算出来的交接会盖掉
   * `/clear` 刚立的墓碑,把已清空的上下文重新灌回去。
   *
   * 比较的是 **clear 纪元**,只由 `/clear`(invalidate / clear)推进——`set` 与
   * `consume` 都不推进它,所以同一流程内的二次写入、以及与别处 consume 的并发,
   * 都不会被误拒。
   */
  set(sessionId: string, handoff: string, expectedGeneration?: number): void;
  /** 取当前 clear 纪元(只由 `/clear` 推进),配合 `set` 的 `expectedGeneration` 使用。 */
  readGeneration(sessionId: string): number;
  peek(sessionId: string): Promise<string | null>;
  consume(sessionId: string): void;
  /**
   * 丢弃内存里的待注入交接并推进 clear 纪元,**允许后续 peek 回落 DB 重建**。
   *
   * 给 rewind 提交用:回退之后 DB 历史本身就变了,回落重建出来的是回退后的正确
   * 结果,不需要墓碑。
   *
   * 注意纪元条目是**故意留着**的,不随本次调用删除:纪元缺省值是 0,删掉就等于把
   * 它退回 0,而绝大多数会话在首次 clear 之前取到的快照正是 0——那些正在读历史的
   * 切换 / 删除流程写回时会重新校验通过,基于回退前历史算出的交接照样盖回来,这个
   * 保护就白做了。留下的是每个被 clear 过的 session 一个 `string -> number`,与
   * `pending` 自身同量级。
   */
  clear(sessionId: string): void;
  /**
   * 墓碑式失效:留下 null 条目,后续 peek 直接返回 null,**不回落 DB**。
   *
   * 给 `/clear` 用。`cleared_at` 现在由 clear handler 内同步落库(见 register.ts 的
   * `INPUT_CLEAR_SESSION`),DB 回落本身已经能过滤掉 clear 之前的交接;但落库失败
   * 或 DB 侧过滤有缺口时,`clear()` 的回落语义会把旧交接重建出来并缓存,而后来的
   * DB 更新不会让那份缓存失效。墓碑不依赖 DB 状态,是这里更硬的保证——真有新交接时
   * `set()` 会覆盖它。
   *
   * **不推进 clear 纪元**:纪元一旦推进,就等于向在途的切换 / 删除宣告「DB 边界已
   * 就位」,而此刻 `cleared_at` 还没落库。推进动作交给 `sealClearBoundary`,由 handler
   * 在落库尝试结束之后调用。墓碑本身是同步生效的,先立不影响。
   */
  invalidate(sessionId: string): void;
  /**
   * 封上 clear 边界:**重立墓碑 + 推进 clear 纪元**,作废所有在此之前取过纪元的在途
   * 写入。必须在 `/clear` 的 `cleared_at` 落库尝试**结束之后**调用(成功或失败都要调)。
   *
   * 两件事都不能省,因为 `invalidate` 与本调用之间那段 await 是双向漏的:
   *  - 纪元若在 `invalidate` 就推进,窗口内**启动**的切换 / 删除会同时拿到「clear 之后
   *    的纪元」和「clear 之前的 DB 历史」——校验通过,基于已清空历史算出的交接盖掉墓碑;
   *  - 纪元推迟到这里,窗口内**写回**的那批(纪元是 clear 前取的、此刻还没被推进)校验
   *    同样通过,一样盖掉墓碑,而单纯推进纪元并不会把已经写进去的那份清掉。
   *
   * 所以是「先重立墓碑清掉窗口内挤进来的,再推进纪元挡住后面写回的」。落库失败也要调:
   * 在途那批算的仍是过期历史,宁可一并丢弃。
   *
   * 代价是窗口内启动、读到的却是**已清空**历史的那一批也会被误伤——丢掉一份本来正确
   * 的交接,方向保守,可接受。
   */
  sealClearBoundary(sessionId: string): void;
}

export function createAgentHandoffPendingRegistry(
  queryPending: (sessionId: string) => Promise<string | null>,
  onConsume?: (sessionId: string) => void,
  /**
   * 内存命中时的补充组合钩子。存在的理由:交接不只由 queryPending 产出——
   * agent-switch / 消息删除会直接 `set` 进内存(register.ts 的 setPendingHandoff),
   * 那条路径不经过 DB fallback。fork 出的子会话若在首发前切了引擎,内存里就只有
   * 切换交接,来源标记会被整条跳过。这里对**非 null 的内存值**再过一次组合,把两
   * 者并起来;null(已 consume)不触发,消费语义不变。
   *
   * 只对 `set` 进来的值生效:queryPending 的产出已经组合过,再过一遍会让首发未
   * accepted 的重试拿到两份来源标记(下面的 composedByQuery 就是这道闸)。
   */
  decorateCached?: (sessionId: string, handoff: string) => Promise<string>,
): AgentHandoffPendingRegistry {
  const pending = new Map<string, string | null>();
  /** 值由 queryPending 产出(已含组合结果)的 session,decorate 必须跳过它们。 */
  const composedByQuery = new Set<string>();
  /**
   * 每个 session 的 **clear 纪元**:只有 `/clear`(invalidate / clear)递增它。
   *
   * 它回答的问题只有一个——"我手上这份按某时刻历史算出来的东西,期间有没有被用户
   * 清空作废过"。所以 `set` / `consume` **不**递增:
   *  - `consume` 递增会误伤正在途中的新交接:旧交接被 accepted 消费的同时,一个新的
   *    引擎切换可能正等着读历史/写库,它带着更早的纪元回来就被无辜丢弃,新引擎反而
   *    拿不到上下文(这是最常见的一种并发,根本不需要用户 /clear);
   *  - `set` 递增会让同一流程内的第二次写入(resume 回落用全量交接覆盖增量交接)
   *    被自己先前那次挡掉。
   *
   * peek 写回时除了纪元,还要确认缓存值仍是自己读到的那一份——纪元不变但被别的
   * `set` 换过内容时,不能拿旧值盖回去。
   */
  const clearEpoch = new Map<string, number>();
  const bumpClearEpoch = (sessionId: string): void => {
    clearEpoch.set(sessionId, (clearEpoch.get(sessionId) ?? 0) + 1);
  };
  const genOf = (sessionId: string): number => clearEpoch.get(sessionId) ?? 0;
  return {
    set(sessionId, handoff, expectedGeneration) {
      // 调用方带了 clear 纪元就校验:它是在读历史之前取的,不符说明期间用户 /clear 过,
      // 这份交接算的是已作废的历史,丢弃而不是盖回去。纪元只由 clear 推进,所以同一
      // 流程内的二次写入、以及与别处 consume 的并发,都不会被误拒。
      if (expectedGeneration !== undefined && genOf(sessionId) !== expectedGeneration) return;
      pending.set(sessionId, handoff);
      // 外部直接塞进来的交接没经过 queryPending 的组合,重新纳入 decorate 范围。
      composedByQuery.delete(sessionId);
    },
    readGeneration(sessionId) {
      return genOf(sessionId);
    },
    async peek(sessionId) {
      if (pending.has(sessionId)) {
        const cached = pending.get(sessionId) ?? null;
        if (cached === null || !decorateCached || composedByQuery.has(sessionId)) return cached;
        const gen = genOf(sessionId);
        try {
          const decorated = await decorateCached(sessionId, cached);
          // 期间被 /clear:本次结果基于已作废的状态,既不写回也不返回——返回它等于
          // 把 clear 掉的交接注入这一次发送。
          if (genOf(sessionId) !== gen) return null;
          // 纪元没变但值被别的 set 换过:别拿旧值盖回去,让下一次 peek 处理新值。
          if (pending.get(sessionId) !== cached) return null;
          // 组合结果回写并标记为已组合:同一条待注入交接在 consume 之前可能被 peek
          // 多次(首发被拒后的重试),没有这步每次都要重跑一遍 decorate 的 DB 查询,
          // 而且要靠 decorate 自身幂等才不会叠加。
          pending.set(sessionId, decorated);
          composedByQuery.add(sessionId);
          return decorated;
        } catch {
          // 失败路径与成功路径同一套校验:decorate 抛错期间若发生 /clear,或这份交接
          // 已被别处 consume / 被新交接替换,退回 cached 都等于把过期内容注入这次发送
          // ——尤其 consume 之后再注入,accepted 后的无条件 consume 还会抹掉更新的那份。
          if (genOf(sessionId) !== gen) return null;
          if (pending.get(sessionId) !== cached) return null;
          // 组合失败不能吞掉本来就该注入的交接——退回未组合的原值,且不写缓存,
          // 下次 peek 仍会重试组合。
          return cached;
        }
      }
      const gen = genOf(sessionId);
      let fromDb: string | null = null;
      try {
        fromDb = await queryPending(sessionId);
      } catch {
        // 查询失败按无 pending 处理(不阻塞发送);下次 send 重查。
        return null;
      }
      // 期间 /clear 或有人写入了新交接:这份 DB 重建结果已过时,不写回也不返回。
      if (genOf(sessionId) !== gen || pending.has(sessionId)) return null;
      pending.set(sessionId, fromDb);
      composedByQuery.add(sessionId);
      return fromDb;
    },
    consume(sessionId) {
      pending.set(sessionId, null);
      composedByQuery.delete(sessionId);
      // 不推进 clear 纪元:消费的是"这一份"交接,不代表别处正在构造的新交接作废。
      onConsume?.(sessionId);
    },
    clear(sessionId) {
      pending.delete(sessionId);
      composedByQuery.delete(sessionId);
      // 不要"顺手"改成 clearEpoch.delete():缺省值 0 会让 clear 前取到 0 的在途写入
      // 重新校验通过。理由见接口声明处。
      bumpClearEpoch(sessionId);
    },
    invalidate(sessionId) {
      pending.set(sessionId, null);
      composedByQuery.delete(sessionId);
      // 纪元不在这里推进,见接口声明:要等 cleared_at 落库尝试结束。
    },
    sealClearBoundary(sessionId) {
      // 重立墓碑再推进纪元,顺序不能反过来也不能省。落库这段 await 里,一份用
      // clear 前纪元的 set 是能挤进来的(那时纪元还没推进,校验通过),它算的是
      // clear 前的历史;只推进纪元不会把它清掉。
      pending.set(sessionId, null);
      composedByQuery.delete(sessionId);
      bumpClearEpoch(sessionId);
    },
  };
}
