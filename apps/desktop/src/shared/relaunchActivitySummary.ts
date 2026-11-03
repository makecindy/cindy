/**
 * relaunchActivitySummary.ts — 更新重启确认里给用户看的脱敏类别。
 *
 * 忙闲仍由 relaunchBusyActivity 的布尔决定。这里只把已有来源标签翻译成固定类别，
 * 不接收会话 id、路径、提示词或远程控制者。读不全时返回空类别，调用方保留通用警告。
 */

export const RELAUNCH_ACTIVITY_CATEGORIES = [
  'companion',
  'conversation',
  'background-command',
  'scheduled-task',
  'generation',
  'subtask',
] as const;

export type RelaunchActivityCategory = (typeof RELAUNCH_ACTIVITY_CATEGORIES)[number];

const REASON_CATEGORY: Record<string, RelaunchActivityCategory> = {
  'background-bash': 'background-command',
  'scheduler-run-running': 'scheduled-task',
  // 插件后台活动也覆盖发邮件、取消等非生成动作，分不清时不能写成生成任务。
  'cindy-slot-async-job': 'generation',
  'pi-subagent': 'subtask',
  'claude-background-activity': 'subtask',
};

export interface RelaunchCompanionFact {
  /** 用户已经可见的伙伴名；null 表示只能说类别。 */
  name: string | null;
}

export interface RelaunchTurnFacts {
  companions: readonly RelaunchCompanionFact[];
  conversation: boolean;
}

export interface RelaunchActivitySummary {
  categories: RelaunchActivityCategory[];
  companionNames: string[];
}

const MAX_COMPANION_NAME_LENGTH = 40;
/** 侧栏确认没有独立滚动区。再多就只说伙伴类别，避免姓名把按钮挤出窗口。 */
const MAX_LISTED_COMPANION_NAMES = 3;
const COMPANION_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'’-]{0,39}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 只接受能放进侧栏确认句的伙伴显示名。隐藏、归档、路径、链接和 uuid 都不当成名字。
 */
export function safeCompanionDisplayName(
  raw: unknown,
  visibility?: { status?: string | null; hiddenAt?: number | null },
): string | null {
  if (visibility?.hiddenAt != null) return null;
  if (visibility?.status === 'archived' || visibility?.status === 'deleting') return null;
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name || name.length > MAX_COMPANION_NAME_LENGTH) return null;
  if (name.includes('..') || UUID_PATTERN.test(name)) return null;
  if (!COMPANION_NAME_PATTERN.test(name)) return null;
  return name;
}

/**
 * 把已有 reason 标签译成类别。任一标签读不出类别时整份摘要作废，
 * 避免只报第一个，或报一份不完整清单让用户以为只会打断这些。
 */
export function summarizeRelaunchActivity(
  reasons: readonly string[],
  turns: RelaunchTurnFacts | null,
): RelaunchActivitySummary {
  const found = new Set<RelaunchActivityCategory>();
  let incomplete = false;
  let companionNames: string[] = [];

  for (const reason of reasons) {
    if (reason === 'session-in-turn') {
      if (!turns || (turns.companions.length === 0 && !turns.conversation)) {
        incomplete = true;
        continue;
      }
      if (turns.companions.length > 0) found.add('companion');
      if (turns.conversation) found.add('conversation');
      const unnamed = turns.companions.length > MAX_LISTED_COMPANION_NAMES
        || turns.companions.some((companion) => safeCompanionDisplayName(companion.name) == null);
      companionNames = unnamed
        ? []
        : turns.companions.flatMap((companion) => {
          const safe = safeCompanionDisplayName(companion.name);
          return safe ? [safe] : [];
        });
      continue;
    }
    const category = REASON_CATEGORY[reason];
    if (!category) {
      incomplete = true;
      continue;
    }
    found.add(category);
  }

  if (incomplete || found.size === 0) return { categories: [], companionNames: [] };
  return {
    categories: RELAUNCH_ACTIVITY_CATEGORIES.filter((category) => found.has(category)),
    companionNames,
  };
}

export interface RelaunchTurnRow {
  id: string;
  source: string | null;
  displayName: string | null;
  botStatus: string | null;
  hiddenAt: number | null;
  /** bot_session_links.role。delegation 是普通任务，不是伙伴对话。 */
  linkRole?: string | null;
}

/** 把 turn 会话行收成伙伴 / 对话。缺行、超限或来源读不出时返回 null，不猜类别。 */
export function classifyRelaunchTurnRows(
  requestedIds: readonly string[],
  rows: readonly RelaunchTurnRow[],
): RelaunchTurnFacts | null {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of requestedIds) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) return { companions: [], conversation: false };
  if (ids.length > 32) return null;

  const byId = new Map<string, RelaunchTurnRow[]>();
  for (const row of rows) {
    const list = byId.get(row.id);
    if (list) list.push(row);
    else byId.set(row.id, [row]);
  }
  if (ids.some((id) => !byId.has(id))) return null;

  const named: RelaunchCompanionFact[] = [];
  const usedNames = new Set<string>();
  let unnamedCompanion = false;
  let conversation = false;
  for (const id of ids) {
    const group = byId.get(id) ?? [];
    const source = group.find((row) => row.source)?.source ?? null;
    const bot = group.find((row) =>
      row.displayName != null || row.botStatus != null || row.hiddenAt != null);
    const role = group.find((row) => row.linkRole != null)?.linkRole ?? null;
    // delegation 走普通任务入口，不能因为 join 到伙伴资料就说「伙伴正在回复」。
    const isCompanion = role !== 'delegation' && (
      source === 'bot' || role === 'canonical' || role === 'history' || role === 'group' || role === 'channel'
    );
    if (!source && !isCompanion) return null;
    if (isCompanion) {
      const name = safeCompanionDisplayName(bot?.displayName, {
        status: bot?.botStatus,
        hiddenAt: bot?.hiddenAt,
      });
      if (!name) {
        unnamedCompanion = true;
        continue;
      }
      if (!usedNames.has(name)) {
        usedNames.add(name);
        named.push({ name });
      }
      continue;
    }
    conversation = true;
  }
  if (unnamedCompanion || named.length > MAX_LISTED_COMPANION_NAMES) {
    return { companions: [{ name: null }], conversation };
  }
  return { companions: named, conversation };
}

const CATEGORY_KEYS: Record<RelaunchActivityCategory, string> = {
  companion: 'update.banner.activity.companion',
  conversation: 'update.banner.activity.conversation',
  'background-command': 'update.banner.activity.backgroundCommand',
  'scheduled-task': 'update.banner.activity.scheduledTask',
  generation: 'update.banner.activity.generation',
  subtask: 'update.banner.activity.subtask',
};

function joinLocalized(
  parts: readonly string[],
  translate: (key: string) => string,
  keys: { joiner: string; pair: string; last: string },
): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return parts[0] + translate(keys.pair) + parts[1];
  return parts.slice(0, -1).join(translate(keys.joiner)) + translate(keys.last) + parts[parts.length - 1];
}

/**
 * 有具体类别时返回各语言的完整警告句；没有时返回 null，调用方继续用通用警告。
 * translate 必须自己替换 {{activities}} / {{names}}。名字数量决定单复数模板。
 */
export function formatRelaunchActivityHint(
  translate: (key: string, vars?: Record<string, string>) => string,
  summary: RelaunchActivitySummary | null,
): string | null {
  if (!summary || summary.categories.length === 0) return null;
  const parts = summary.categories.map((category) => {
    if (category !== 'companion' || summary.companionNames.length === 0
      || summary.companionNames.length > MAX_LISTED_COMPANION_NAMES) {
      return translate(CATEGORY_KEYS[category]);
    }
    const names = joinLocalized(summary.companionNames, (key) => translate(key), {
      joiner: 'update.banner.activityNameJoiner',
      pair: 'update.banner.activityNameJoinerPair',
      last: 'update.banner.activityNameJoinerLast',
    });
    const key = summary.companionNames.length === 1
      ? 'update.banner.activity.companionOne'
      : 'update.banner.activity.companionOther';
    return translate(key, { names });
  });
  const activities = joinLocalized(parts, (key) => translate(key), {
    joiner: 'update.banner.activityJoiner',
    pair: 'update.banner.activityJoinerPair',
    last: 'update.banner.activityJoinerLast',
  });
  return translate('update.banner.confirmBusyActivities', { activities });
}

/** Renderer 不信任 IPC 形状。缺 busy 布尔时返回 null，由调用方 fail closed。 */
export function normalizeRelaunchActivitySummary(value: unknown): {
  busy: boolean;
  categories: RelaunchActivityCategory[];
  companionNames: string[];
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { busy?: unknown; categories?: unknown; companionNames?: unknown };
  if (typeof record.busy !== 'boolean') return null;
  const categories = RELAUNCH_ACTIVITY_CATEGORIES.filter((category) =>
    Array.isArray(record.categories) && record.categories.includes(category));
  const rawNames = Array.isArray(record.companionNames) ? record.companionNames : [];
  const companionNames: string[] = [];
  for (const name of rawNames) {
    const safe = safeCompanionDisplayName(name);
    if (!safe) return { busy: record.busy, categories, companionNames: [] };
    if (!companionNames.includes(safe)) companionNames.push(safe);
  }
  if (!categories.includes('companion') || companionNames.length > MAX_LISTED_COMPANION_NAMES) {
    return { busy: record.busy, categories, companionNames: [] };
  }
  return { busy: record.busy, categories, companionNames };
}
