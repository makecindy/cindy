/**
 * verbAggregator
 * ---------------------------------------------------------------------------
 * F1 — collapse a tool-call segment into a one-line "Edited 3 files, ran 2
 *      commands and read a file" summary.
 *
 * Tool-name → verb mapping is intentionally STATIC (ADR-1):
 *   - Edit / MultiEdit → 'edited'
 *   - Write           → 'created'
 *   - Bash / exec     → 'ran'
 *   - Read            → 'read'
 *   - TodoWrite       → 'updated'
 *   - Glob / Grep     → 'searched'
 *   - WebFetch / WebSearch / web_search → 'fetched'
 *   - default         → 'used'
 *
 * Sort order is fixed (see ORDER below) so the same multi-verb summary
 * always renders the same way regardless of the wall-clock arrival order.
 * Truncation kicks in at >5 distinct verbs ("… and N more").
 *
 * 文案 i18n(issue #450):聚合短语 / 行级动词都走 i18n key。CJK 语序与英文
 * 不同,所以 key 是「整短语」粒度(如 "edited {{count}} files" / "编辑
 * {{count}} 个文件"),不拆 verb/noun 两段拼接。聚合/行级 key 在下方映射表,
 * command intent 的动词 key 表在 `src/shared/agentActionVerbKeys.ts`(与
 * main 灵动岛措辞共享)— i18nCompleteness 静态扫描认不出 `t(变量)`,这些
 * key 的 4 语言齐全性由 `agentActionsI18n.test.ts` 显式断言兜底。
 */

import type { TFunction } from 'i18next';
import type { CommandIntentAction } from '@cindy/maker-shared';

import { INTENT_ROW_VERB_KEY } from '../../../shared/agentActionVerbKeys';

import type { ChatMessage } from '@/lib/makerChatStore';

export type Verb =
  | 'edited'
  | 'created'
  | 'ran'
  | 'read'
  | 'updated'
  | 'searched'
  | 'fetched'
  | 'used';

export interface VerbEntry {
  verb: Verb;
  count: number;
}

export interface AgentActionSummary {
  /** Already sorted (ORDER) and truncated to <=5 entries. */
  verbs: VerbEntry[];
  /** Total tool calls (pre-truncation). */
  totalCalls: number;
  /** Number of verbs that were truncated off the tail; 0 when none. */
  truncatedExtra: number;
}

const TOOL_TO_VERB: Record<string, Verb> = {
  Edit: 'edited',
  MultiEdit: 'edited',
  file_change: 'edited',
  Write: 'created',
  Bash: 'ran',
  exec: 'ran',
  Read: 'read',
  TodoWrite: 'updated',
  Glob: 'searched',
  Grep: 'searched',
  WebFetch: 'fetched',
  WebSearch: 'fetched',
  web_search: 'fetched',
  // pi 内置工具(全小写,见 toolUseDescriptor.ts 数据来源约定)。
  bash: 'ran',
  read: 'read',
  ls: 'read',
  edit: 'edited',
  write: 'created',
  grep: 'searched',
  find: 'searched',
};

const ORDER: Verb[] = [
  'edited',
  'ran',
  'read',
  'updated',
  'created',
  'searched',
  'fetched',
  'used',
];

/** 聚合摘要短语 key(带 count 插值;en 另有 _one/_other 复数变体)。 */
const PART_KEY: Record<Verb, string> = {
  edited: 'chat.agentActions.part.edited',
  created: 'chat.agentActions.part.created',
  ran: 'chat.agentActions.part.ran',
  read: 'chat.agentActions.part.read',
  updated: 'chat.agentActions.part.updated',
  searched: 'chat.agentActions.part.searched',
  fetched: 'chat.agentActions.part.fetched',
  used: 'chat.agentActions.part.used',
};

/** 行级动词 label key("Edited" / "编辑")。 */
const ROW_VERB_KEY: Record<Verb, string> = {
  edited: 'chat.agentActionRow.verb.edited',
  created: 'chat.agentActionRow.verb.created',
  ran: 'chat.agentActionRow.verb.ran',
  read: 'chat.agentActionRow.verb.read',
  updated: 'chat.agentActionRow.verb.updated',
  searched: 'chat.agentActionRow.verb.searched',
  fetched: 'chat.agentActionRow.verb.fetched',
  used: 'chat.agentActionRow.verb.used',
};

/**
 * command intent 的行级动词 label key;消费端自行 `t()`。key 表已下沉到
 * `src/shared/agentActionVerbKeys.ts`(main 灵动岛措辞与面板共用同一事实源),
 * 本函数保留为薄委托,面板消费端(AgentActionRow 等)零改动。
 */
export function verbLabelKeyForIntent(action: CommandIntentAction): string {
  return INTENT_ROW_VERB_KEY[action];
}

/** Pure helper — exposed for unit testing the per-row label too. */
export function verbForTool(toolName: string): Verb {
  return TOOL_TO_VERB[toolName] ?? 'used';
}

/**
 * 行级动词 label 的 i18n key("Edited" / "编辑" 这一档)。消费端自行 `t()`,
 * 保持本模块无 React 依赖。
 */
export function verbLabelKeyForRow(verb: Verb): string {
  return ROW_VERB_KEY[verb];
}

/** Aggregate a flat list of tool_use messages into the segment summary. */
export function aggregateVerbs(toolCalls: ChatMessage[]): AgentActionSummary {
  const counter = new Map<Verb, number>();
  for (const msg of toolCalls) {
    const v = verbForTool(msg.toolName ?? '');
    counter.set(v, (counter.get(v) ?? 0) + 1);
  }

  let entries: VerbEntry[] = ORDER.flatMap((verb) => {
    const count = counter.get(verb);
    return count === undefined ? [] : [{ verb, count }];
  });

  const truncatedExtra = entries.length > 5 ? entries.length - 5 : 0;
  if (truncatedExtra > 0) {
    entries = entries.slice(0, 5);
  }

  return {
    verbs: entries,
    totalCalls: toolCalls.length,
    truncatedExtra,
  };
}

/** 首字母大写(仅对拉丁字母生效,CJK 短语天然 no-op)。 */
function capitalizeFirst(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Format the summary for the collapsed-row header.
 * First verb capitalized to read like a sentence:
 *   "Edited 3 files, ran 2 commands and read a file"(en)
 *   "编辑 3 个文件、运行 2 条命令和读取 1 个文件"(zh-CN)
 */
export function formatSummary(summary: AgentActionSummary, t: TFunction): string {
  const parts: string[] = summary.verbs.map((e) => t(PART_KEY[e.verb], { count: e.count }));
  if (summary.truncatedExtra > 0) {
    parts.push(t('chat.agentActions.more', { count: summary.truncatedExtra }));
  }

  if (parts.length === 0) return '';
  if (parts.length === 1) return capitalizeFirst(parts[0]);

  const separator = t('chat.agentActions.separator');
  const lastSeparator = t('chat.agentActions.lastSeparator');
  const body = `${parts.slice(0, -1).join(separator)}${lastSeparator}${parts[parts.length - 1]}`;
  return capitalizeFirst(body);
}
