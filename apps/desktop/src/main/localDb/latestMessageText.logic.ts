/**
 * Magic 重命名的消息筛选纯逻辑。
 *
 * 标题素材不能按数据库里的原始消息行数截取：一个 agent turn 可能落下很多条
 * assistant 施工播报，最后一条才是正式答复。这里按 user 边界分组，并优先使用
 * host 写入的 turn 完成标记；没有任何完成标记的老数据才退化为该组最后一条顶层
 * assistant。
 */

export interface TitleMessageCandidate {
  role: 'user' | 'assistant';
  text: string;
  createdAt: number | null;
  rowid: number;
  /** Persisted tool_use/tool_result id, used to disambiguate legacy parentUuid. */
  toolUseId?: string | null;
  agentMeta: Record<string, unknown> | null;
}

export interface SelectedTitleMessage {
  role: 'user' | 'assistant';
  text: string;
  createdAt: number | null;
  rowid: number;
}

const EXPLICIT_TOOL_PARENT_META_KEYS = ['parentToolUseId', 'parent_tool_use_id'] as const;
// Live Claude SDK tool ids use one of these prefixes. A bare `parentUuid` is
// intentionally not enough: legacy Claude imports used that field for the
// ordinary transcript chain, and deleting those rows would erase valid title
// evidence from old sessions.
const TOOL_PARENT_ID_RE = /^(?:toolu|call)[_-]/iu;

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Claude subagent assistant rows carry an explicit tool parent and are not
 * top-level answers. Unknown legacy `parentUuid` values are retained because
 * they may be transcript links rather than subagent edges.
 */
export function isTopLevelTitleAssistant(
  meta: Record<string, unknown> | null,
  knownToolUseIds: ReadonlySet<string> = new Set(),
): boolean {
  if (!meta) return true;
  if (EXPLICIT_TOOL_PARENT_META_KEYS.some((key) => hasNonEmptyString(meta[key]))) return false;
  if (typeof meta.parentUuid !== 'string' || !meta.parentUuid.trim()) return true;
  const parentUuid = meta.parentUuid.trim();
  return !knownToolUseIds.has(parentUuid) && !TOOL_PARENT_ID_RE.test(parentUuid);
}

/** Host writes one of these fields when a real SDK turn reaches its terminal boundary. */
export function hasTitleTurnBoundaryMeta(meta: Record<string, unknown> | null): boolean {
  if (!meta) return false;
  return (
    Object.prototype.hasOwnProperty.call(meta, 'turnCompleted') ||
    Object.prototype.hasOwnProperty.call(meta, 'turnCostUsd') ||
    Object.prototype.hasOwnProperty.call(meta, 'turnMoney') ||
    Object.prototype.hasOwnProperty.call(meta, 'turnUsageDetails')
  );
}

/** Equivalent terminal signals used by the renderer's turn-final selection. */
export function isTitleTurnCompleted(meta: Record<string, unknown> | null): boolean {
  if (!meta) return false;
  if (Object.prototype.hasOwnProperty.call(meta, 'turnCompleted')) {
    return meta.turnCompleted === true;
  }
  if (typeof meta.turnCostUsd === 'number' && meta.turnCostUsd > 0) return true;
  if (
    meta.turnMoney &&
    typeof meta.turnMoney === 'object' &&
    !Array.isArray(meta.turnMoney) &&
    typeof (meta.turnMoney as { amount?: unknown }).amount === 'number' &&
    (meta.turnMoney as { amount: number }).amount > 0
  ) {
    return true;
  }
  return meta.turnUsageDetails !== undefined;
}

/** System/status cards are not useful conversation subjects even if they have text. */
function isInternalTitleAssistant(meta: Record<string, unknown> | null): boolean {
  if (!meta) return false;
  return (
    meta.goalCompletion !== undefined ||
    meta.goalNotice !== undefined ||
    meta.reviewRun !== undefined ||
    meta.scheduleSkip !== undefined
  );
}

/** Only an explicit user send starts a new title turn; steer stays inside the current turn. */
export function isTitleTurnBoundaryUser(meta: Record<string, unknown> | null): boolean {
  return meta?.delivery !== 'steer' && isVisibleTitleUser(meta);
}

/** Hidden host-authored continuation prompts are never user-visible title evidence. */
export function isVisibleTitleUser(meta: Record<string, unknown> | null): boolean {
  return meta?.autoResume !== true;
}

function compareTitleRows(a: TitleMessageCandidate, b: TitleMessageCandidate): number {
  const at = a.createdAt ?? 0;
  const bt = b.createdAt ?? 0;
  return at === bt ? a.rowid - b.rowid : at - bt;
}

interface TitleTurn {
  users: TitleMessageCandidate[];
  assistants: TitleMessageCandidate[];
}

interface EffectiveTitleGroup {
  messages: SelectedTitleMessage[];
}

function pickTurnAssistant(
  turn: TitleTurn,
  unsealedTurnIsInFlight: boolean,
  knownToolUseIds: ReadonlySet<string>,
): SelectedTitleMessage | null {
  const assistants = turn.assistants.filter(
    (row) =>
      row.text &&
      isTopLevelTitleAssistant(row.agentMeta, knownToolUseIds) &&
      !isInternalTitleAssistant(row.agentMeta),
  );
  if (assistants.length === 0) return null;

  const completed = assistants.filter((row) => isTitleTurnCompleted(row.agentMeta));
  if (completed.length > 0) {
    // A background continuation can seal more than one assistant in one user turn. The
    // latest sealed answer is the most useful title evidence and avoids reintroducing
    // intermediate implementation narration.
    const last = completed[completed.length - 1];
    return { role: 'assistant', text: last.text, createdAt: last.createdAt, rowid: last.rowid };
  }

  // New rows may have a UUID/usage payload on every progress message but only the final
  // row has turnCompleted/turn usage metadata. Once such a boundary-aware row is present,
  // an unsealed assistant is an in-flight progress update and must not enter the prompt.
  if (unsealedTurnIsInFlight || assistants.some((row) => hasTitleTurnBoundaryMeta(row.agentMeta))) {
    return null;
  }

  // Pre-seal historical rows have no terminal marker at all. Preserve the old behavior
  // for those sessions by taking the last top-level assistant in the user segment.
  const last = assistants[assistants.length - 1];
  return { role: 'assistant', text: last.text, createdAt: last.createdAt, rowid: last.rowid };
}

/**
 * Select recent effective title messages from chronologically ordered (or sortable) DB rows.
 * `limit` is a soft effective-message budget, not a raw-row cutoff. Complete
 * user/steer/assistant groups are kept intact, so one selected group may exceed it.
 */
export function selectRecentTitleMessages(
  inputRows: readonly TitleMessageCandidate[],
  limit: number,
  knownToolUseIds: ReadonlySet<string> = new Set(),
  latestTurnIsInFlight = false,
): SelectedTitleMessage[] {
  if (limit <= 0 || inputRows.length === 0) return [];

  const rows = [...inputRows].sort(compareTitleRows);
  const turns: TitleTurn[] = [];
  let current: TitleTurn | null = null;
  for (const row of rows) {
    if (!row.text) continue;
    if (row.role === 'user') {
      if (!isVisibleTitleUser(row.agentMeta)) continue;
      if (row.agentMeta?.delivery === 'steer') {
        current ??= { users: [], assistants: [] };
        current.users.push(row);
        continue;
      }
      if (current) turns.push(current);
      current = { users: [row], assistants: [] };
    } else if (current) {
      current.assistants.push(row);
    } else {
      // Imported/worker sessions can contain assistant rows without a visible
      // user row. Keep them in an assistant-only group instead of dropping the
      // entire session from Magic rename.
      current = { users: [], assistants: [row] };
    }
  }
  if (current) turns.push(current);

  // Legacy data has no terminal metadata, while current persistence seals each
  // finished turn. Only unsealed turns after the latest sealed boundary are
  // treated as in-flight progress; older legacy turns retain their final-row
  // fallback even when the same session later contains sealed data.
  let lastCompletedTurnIndex = -1;
  turns.forEach((turn, index) => {
    const hasCompletedAssistant = turn.assistants.some(
      (row) =>
        isTopLevelTitleAssistant(row.agentMeta, knownToolUseIds) &&
        !isInternalTitleAssistant(row.agentMeta) &&
        isTitleTurnCompleted(row.agentMeta),
    );
    if (hasCompletedAssistant) lastCompletedTurnIndex = index;
  });

  const groups: EffectiveTitleGroup[] = [];
  const latestTurnIndex = turns.length - 1;
  for (const [index, turn] of turns.entries()) {
    const unsealedTurnIsInFlight =
      (lastCompletedTurnIndex >= 0 && index > lastCompletedTurnIndex) ||
      (latestTurnIsInFlight && index === latestTurnIndex);
    const assistant = pickTurnAssistant(turn, unsealedTurnIsInFlight, knownToolUseIds);
    const selected: SelectedTitleMessage[] = [];
    for (const user of turn.users) {
      selected.push({
        role: 'user',
        text: user.text,
        createdAt: user.createdAt,
        rowid: user.rowid,
      });
    }
    if (assistant) selected.push(assistant);
    if (selected.length > 0) groups.push({ messages: selected });
  }

  // Keep each user/assistant turn intact. Starting from the newest group means
  // a long history can never leave an orphan Assistant at the front of the
  // prompt merely because the raw message budget ended between turn members.
  const selectedGroups: EffectiveTitleGroup[] = [];
  let selectedCount = 0;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (selectedGroups.length > 0 && selectedCount + group.messages.length > limit) break;
    selectedGroups.unshift(group);
    selectedCount += group.messages.length;
  }
  return selectedGroups.flatMap((group) => group.messages);
}
