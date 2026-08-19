/**
 * 批次 ε「成长时刻」的纯判定层:伙伴在做事的过程中往自己的记忆里写了什么,
 * 以及那条写入应该挂在哪一句话的末尾。
 *
 * 技术路径(2026-08 盘点结论):bot 会话的记忆写入**没有**任何专用事件或推送,
 * 它就是一次普通的 MCP 工具调用 —— `mcp__cindy_memory__call_tool`,入参
 * `{ name: 'memory_write', args: { type, name, title, description, body } }`。
 * 它已经作为一条 `role: 'tool_use'` 的 ChatMessage 落在消息流里(见
 * makerChatStore 的 `case 'tool_use'`),所以「这一轮写没写记忆」在 Renderer
 * 侧就能判出来,**不需要动引擎、不需要新 IPC、不需要新事件**。
 *
 * 分域已经由批次 β 做好:bot 会话的 `makerMemoryScopeKey` 恒为
 * `buildBotMemoryScopeKey(botId)`,所以这里看到的每一次写入都落在这个伙伴
 * 自己的记忆空间里,不会串到 workdir 记忆。
 */

import type { MemoryRecord } from '@cindy/maker-core';

import type { ChatMessage } from '@/hooks/useCCAgentChat';

/**
 * 「本事」的落点约定。
 *
 * makerMemory 有 type 概念(user / feedback / project / reference / digest),但
 * 没有一个语义等同于「TA 自己长出来的可复用做法」的类型:`feedback` 是用户给
 * 的反馈偏好,那属于「TA 记得的」。所以本批不新造存储、也不改 type 枚举,改用
 * **slug 前缀约定**:`learned-*` 的分片计入「TA 学会的」,其余计入「TA 记得的」。
 *
 * 前缀用连字符而不是下划线是有原因的:文件名是 `<type>_<slug>.md`,storage 的
 * `validateNoTypePrefix` 会拒绝以 `<type>_` 开头的 slug,连字符绕开该校验。
 */
export const LEARNED_MEMORY_SLUG_PREFIX = 'learned-';

/** 记忆 MCP 的二级分派入口(Claude/Codex/PI 三个 harness 都是这个投影名)。 */
const MEMORY_DISPATCH_TOOL_SUFFIX = 'cindy_memory__call_tool';
/** 写入操作在二级分派里的操作名。 */
const MEMORY_WRITE_OPERATION = 'memory_write';

/**
 * 真技能沉淀走的是另一台 server —— `cindy_helper` 的 `bots` 类目
 * (与 list_bots / set_bot_note 同一处,见 lizi-mcps 的 xdt-helper/bot_skills.ts)。
 */
const HELPER_DISPATCH_TOOL_SUFFIX = 'cindy_helper__call_tool';
/** 存技能操作在二级分派里的操作名。 */
const SKILL_SAVE_OPERATION = 'save_bot_skill';

/** 一次记忆写入在气泡尾注里的最小信息。 */
export interface BotGrowthEvent {
  /** true = 走 `learned-` 约定的「本事」,false = 普通记忆。 */
  learned: boolean;
  /** 展示标题(memory_write 的 `title`);提不出就是 null,由文案降级兜底。 */
  title: string | null;
}

/** 一句话末尾那条尾注的完整描述(同轮多次写入已合并)。 */
export interface BotGrowthNote {
  /** 本轮写入条数,≥1。 */
  count: number;
  /** 仅在 count === 1 且拿得到标题时非 null。 */
  title: string | null;
  /** 点尾注该高亮设置页的哪个列表。 */
  target: BotGrowthTarget;
}

export type BotGrowthTarget = 'memory' | 'learned';

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 从 memory_write 的入参里提取尾注需要的东西。
 *
 * `digest` 是 Pi 压缩产生的系统内部分片,对用户不是「TA 记得的事」
 * (设置页的成长列表也把它过滤掉),因此不算成长时刻 —— 返回 null。
 * 实际上 memory_write 的 type 枚举本来就不含 digest,这里是防御。
 */
function parseMemoryWriteArgs(args: Record<string, unknown>): BotGrowthEvent | null {
  if (readString(args, 'type') === 'digest') return null;
  const slug = readString(args, 'name');
  return {
    learned: slug !== null && slug.startsWith(LEARNED_MEMORY_SLUG_PREFIX),
    title: readString(args, 'title'),
  };
}

/**
 * 判定一条 `tool_use` 消息是不是「伙伴刚往记忆里写了一条」。
 *
 * 认两种形态:
 *  1. 二级分派(**当前真实形态**):`mcp__cindy_memory__call_tool`,
 *     入参 `{ name: 'memory_write', args: {...} }`。
 *  2. 直挂形态:工具名本身以 `memory_write` 结尾,入参即 args。当前不会出现,
 *     留着是为了 MCP 投影方式变化时尾注不至于静默消失。
 *
 * 判不出来一律返回 null —— 尾注宁可不出,不能对着别的工具调用编一句「记住了」。
 */
export function parseMemoryWriteToolUse(
  toolName: string | undefined,
  toolInput: unknown,
): BotGrowthEvent | null {
  const name = toolName?.trim();
  if (!name) return null;
  const input = asRecord(toolInput);
  if (!input) return null;

  if (name.endsWith(MEMORY_DISPATCH_TOOL_SUFFIX)) {
    if (readString(input, 'name') !== MEMORY_WRITE_OPERATION) return null;
    const args = asRecord(input.args);
    return args ? parseMemoryWriteArgs(args) : null;
  }

  if (name === MEMORY_WRITE_OPERATION || name.endsWith(`__${MEMORY_WRITE_OPERATION}`)) {
    return parseMemoryWriteArgs(input);
  }

  return null;
}

/**
 * 判定一条 `tool_use` 消息是不是「伙伴刚把一次做法沉淀成了真技能」。
 *
 * 与记忆写入同构:认二级分派(当前真实形态)与直挂两种形态。技能恒计入
 * 「TA 学会的」—— 它本来就是那个列表的正主,不像记忆还要看 slug 前缀。
 */
export function parseBotSkillSaveToolUse(
  toolName: string | undefined,
  toolInput: unknown,
): BotGrowthEvent | null {
  const name = toolName?.trim();
  if (!name) return null;
  const input = asRecord(toolInput);
  if (!input) return null;

  if (name.endsWith(HELPER_DISPATCH_TOOL_SUFFIX)) {
    if (readString(input, 'name') !== SKILL_SAVE_OPERATION) return null;
    const args = asRecord(input.args);
    return args ? { learned: true, title: readString(args, 'name') } : null;
  }

  if (name === SKILL_SAVE_OPERATION || name.endsWith(`__${SKILL_SAVE_OPERATION}`)) {
    return { learned: true, title: readString(input, 'name') };
  }

  return null;
}

/** 一轮里两种成长动作(记一笔 / 学一手)的统一入口。判不出来返回 null。 */
export function parseBotGrowthToolUse(
  toolName: string | undefined,
  toolInput: unknown,
): BotGrowthEvent | null {
  return (
    parseMemoryWriteToolUse(toolName, toolInput) ?? parseBotSkillSaveToolUse(toolName, toolInput)
  );
}

/** 同轮多条写入合并成一条尾注:全是本事才算「学会」,混合按记忆处理。 */
export function summarizeBotGrowthEvents(events: readonly BotGrowthEvent[]): BotGrowthNote | null {
  if (events.length === 0) return null;
  const learned = events.every((event) => event.learned);
  return {
    count: events.length,
    title: events.length === 1 ? events[0].title : null,
    target: learned ? 'learned' : 'memory',
  };
}

/**
 * 扫一遍可见消息,算出「哪句话的末尾该挂尾注、挂什么」。
 *
 * 挂载点用 `turnFinalAssistantClientIds`(MessageStream 已有的口径,与 action bar
 * 同源),也就是每个 user turn 的收尾正文 —— 尾注属于「TA 说完这段话」的注脚,
 * 不该挂在执行过程中的中间句上。
 *
 * 一条 user 消息(非 steer)= 新一轮开始,此时清空待挂事件:上一轮写了记忆却始终
 * 没有收尾正文(比如中途被打断)的情况下,与其把尾注挂到下一轮的答复上误导用户,
 * 不如不挂。
 */
export function collectBotGrowthNotes(
  messages: readonly ChatMessage[],
  turnFinalAssistantClientIds: ReadonlySet<string>,
): Map<string, BotGrowthNote> {
  const out = new Map<string, BotGrowthNote>();
  let pending: BotGrowthEvent[] = [];
  for (const message of messages) {
    if (message.role === 'user' && message.delivery !== 'steer') {
      pending = [];
      continue;
    }
    if (message.role === 'tool_use') {
      const event = parseBotGrowthToolUse(message.toolName, message.toolInput);
      if (event) pending.push(event);
      continue;
    }
    if (message.role === 'assistant' && turnFinalAssistantClientIds.has(message.clientId)) {
      const note = summarizeBotGrowthEvents(pending);
      if (note) out.set(message.clientId, note);
      pending = [];
    }
  }
  return out;
}

/** 尾注文案的**判定**部分(纯函数,不碰 i18n),渲染方拿 key + 参数自己去查。 */
export function botGrowthNoteLabel(note: BotGrowthNote): {
  key: string;
  params: Record<string, string | number>;
} {
  if (note.count > 1) {
    return {
      key: note.target === 'learned' ? 'bots.growth.learnedMany' : 'bots.growth.rememberedMany',
      params: { count: note.count },
    };
  }
  if (note.title) {
    return {
      key: note.target === 'learned' ? 'bots.growth.learnedOne' : 'bots.growth.rememberedOne',
      params: { title: note.title },
    };
  }
  return {
    key:
      note.target === 'learned' ? 'bots.growth.learnedFallback' : 'bots.growth.rememberedFallback',
    params: {},
  };
}

/** slug 是否走了「本事」约定。 */
export function isLearnedMemorySlug(slug: string): boolean {
  return slug.startsWith(LEARNED_MEMORY_SLUG_PREFIX);
}

/**
 * 把伙伴记忆分片切成设置页并排的两个列表。
 *
 * `digest` 两边都不进:它是系统内部压缩摘要,不进 MEMORY.md 索引,对用户既不是
 * 「记得的事」也不是「学会的本事」,但仍然继续被检索使用 —— 只是不展示。
 */
export function partitionBotMemoryRecords(records: readonly MemoryRecord[]): {
  memories: MemoryRecord[];
  learned: MemoryRecord[];
} {
  const memories: MemoryRecord[] = [];
  const learned: MemoryRecord[] = [];
  for (const record of records) {
    if (record.frontmatter.type === 'digest') continue;
    if (isLearnedMemorySlug(record.slug)) learned.push(record);
    else memories.push(record);
  }
  return { memories, learned };
}
