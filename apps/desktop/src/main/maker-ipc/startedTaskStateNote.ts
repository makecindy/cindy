/**
 * `[你开出的任务]`：一条对话再跑一轮时（主人说话或收到来信），宿主附上它用 send_to_session 新建、
 * 开出后还没有发回的本机任务现在的状态（2026-11-21 主人裁决）。
 *
 * 它不回传结果、不唤醒任何任务（cindy-bots-runtime.md §6.1「不由宿主编排回传」不变）：只在这一轮
 * 本来就要发生时，陈述几条状态事实，怎么处理交给模型。原因是开任务的一方只拿到「已排队」，任务停了、
 * 卡在授权或出错都要自己去查，常把旧状态当成最新状态带回主聊天。
 *
 * 数据全部是已有的：开出的任务来自这条对话自己落库的 send_to_session 回执（`wake_kind: created`），
 * 「发回过」来自它收到的、`origin.senderSessionId` 是该任务的来信，状态来自任务运行时快照。读取按
 * `idx_messages_session_created` 限在最近 {@link STARTED_TASK_NOTE_WINDOW_MS} 与 /clear 之后，最多
 * {@link OPENER_ROW_LIMIT} 行；不新增表、字段或持久状态。说明只进当次 wire 消息，不落库，按
 * wireNoteMemory 的规则内容没变就不重复。
 */
import { formatSourceRef } from '@cindy/maker-shared/message-source';

export const STARTED_TASK_NOTE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
export const STARTED_TASK_NOTE_MAX_TASKS = 5;
/** How many unreported tasks are looked up to find the ones worth listing (one primary-key query). */
const STARTED_TASK_LOOKUP_LIMIT = 20;
export const OPENER_ROW_LIMIT = 400;

export interface OpenerMessageRow {
  role: string;
  content: string;
  toolUseId: string | null;
  agentMeta: string | null;
  createdAt: number;
}

export type StartedTaskState = 'idle' | 'error' | 'waiting-permission' | 'waiting-answer';

/** Fields of SessionActivitySnapshot this note reads. */
export interface StartedTaskLive {
  phase: string;
  interactionKind?: string | null;
  /** A durable error can keep `phase: error` while a newer turn runs. */
  currentTurnActive?: boolean;
}

export interface StartedTaskStateNoteDeps {
  now(): number;
  /** The opener's tool_use / tool_result / user rows since `sinceMs`, newest first, at most `limit`. */
  readOpenerRows(sessionId: string, sinceMs: number, limit: number): Promise<OpenerMessageRow[]>;
  /** The opener's /clear boundary; earlier hand-offs are not in its context any more. */
  readClearedAt(sessionId: string): Promise<number | null>;
  /** Title and record status of local tasks; missing ids are gone. */
  readTasks(sessionIds: readonly string[]): Promise<Array<{ id: string; title: string | null; status: string }>>;
  /** Live activity of a local task (the snapshot get_task_digest reads), null when unknown. */
  readPhase(sessionId: string): Promise<StartedTaskLive | null>;
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Same reading as the teammate chat's started-task links (BotStartedTasks.tsx): the call or the gateway's call_tool. */
function isSendToSessionCall(content: string): boolean {
  const use = record(parseJson(content));
  const name = typeof use?.toolName === 'string' ? use.toolName : '';
  if (/send_to_session$/.test(name)) return true;
  if (!/call_tool$/.test(name)) return false;
  const input = typeof use?.input === 'string' ? record(parseJson(use.input)) : record(use?.input);
  return input?.name === 'send_to_session';
}

function createdTarget(content: string): string | null {
  const receipt = record(parseJson(content));
  if (receipt?.ok !== true || receipt.wake_kind !== 'created') return null;
  const id = receipt.target_session_id;
  // Only this computer's tasks: a qualified id belongs to another computer.
  return typeof id === 'string' && id && !id.includes('::') ? id : null;
}

function letterSender(agentMeta: string | null): string | null {
  const origin = record(record(parseJson(agentMeta))?.origin);
  const sender = origin?.kind === 'session' ? origin.senderSessionId : undefined;
  return typeof sender === 'string' && sender ? sender : null;
}

/**
 * Tasks this conversation created that have not written back since, newest first. A letter from
 * the task after its creation counts as written back, and so does the input being sent right now.
 */
export function collectUnreportedStartedTasks(
  rows: readonly OpenerMessageRow[],
  currentSenderSessionId?: string,
): Array<{ sessionId: string; createdAt: number }> {
  const calls = new Set<string>();
  for (const row of rows) {
    if (row.role === 'tool_use' && row.toolUseId && isSendToSessionCall(row.content)) calls.add(row.toolUseId);
  }
  const created = new Map<string, number>();
  const lastLetter = new Map<string, number>();
  for (const row of rows) {
    if (row.role === 'tool_result' && row.toolUseId && calls.has(row.toolUseId)) {
      const id = createdTarget(row.content);
      if (id) created.set(id, Math.min(created.get(id) ?? row.createdAt, row.createdAt));
    } else if (row.role === 'user') {
      const sender = letterSender(row.agentMeta);
      if (sender) lastLetter.set(sender, Math.max(lastLetter.get(sender) ?? 0, row.createdAt));
    }
  }
  return [...created]
    .filter(([id, at]) => id !== currentSenderSessionId && (lastLetter.get(id) ?? -1) < at)
    .map(([sessionId, createdAt]) => ({ sessionId, createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function startedTaskState(live: StartedTaskLive | null): StartedTaskState | null {
  // Still working (or unknown): nothing to say yet.
  if (!live || live.currentTurnActive === true) return null;
  switch (live.phase) {
    case 'running':
      return null;
    case 'needs-interaction':
      return live.interactionKind === 'ask_user_question' ? 'waiting-answer' : 'waiting-permission';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

const STATE_TEXT: Record<StartedTaskState, string> = {
  idle: '空闲',
  error: '出错',
  'waiting-permission': '等待主人确认',
  'waiting-answer': '等待主人回答',
};

export function buildStartedTaskStateNote(
  tasks: ReadonlyArray<{ sessionId: string; title: string | null; state: StartedTaskState }>,
): string | null {
  if (tasks.length === 0) return null;
  const lines = tasks.map((task) => `- 任务${formatSourceRef(task.title, 'session_id', task.sessionId)}：${STATE_TEXT[task.state]}`);
  return [
    '[你开出的任务] 你在这条对话里用 send_to_session 新建的下列任务，开出后还没有发回；以下是宿主读到的当前状态，不是对方的回信：',
    ...lines,
    '要看详情用 get_task_digest。',
  ].join('\n');
}

/** The note for the turn about to start in `sessionId`, or null when there is nothing to say. */
export async function readStartedTaskStateNote(
  sessionId: string,
  opts: { currentSenderSessionId?: string },
  deps: StartedTaskStateNoteDeps,
): Promise<string | null> {
  const clearedAt = await deps.readClearedAt(sessionId);
  const since = Math.max(deps.now() - STARTED_TASK_NOTE_WINDOW_MS, clearedAt ?? 0);
  const rows = await deps.readOpenerRows(sessionId, since, OPENER_ROW_LIMIT);
  const candidates = collectUnreportedStartedTasks(rows, opts.currentSenderSessionId)
    .filter((task) => task.sessionId !== sessionId)
    .slice(0, STARTED_TASK_LOOKUP_LIMIT);
  if (candidates.length === 0) return null;
  const known = new Map((await deps.readTasks(candidates.map((task) => task.sessionId))).map((task) => [task.id, task]));
  const entries: Array<{ sessionId: string; title: string | null; state: StartedTaskState }> = [];
  for (const task of candidates) {
    if (entries.length >= STARTED_TASK_NOTE_MAX_TASKS) break;
    const row = known.get(task.sessionId);
    // Archived or deleted tasks were put away on purpose; do not bring them back up.
    if (!row || row.status !== 'active') continue;
    const state = startedTaskState(await deps.readPhase(task.sessionId).catch(() => null));
    if (state) entries.push({ sessionId: task.sessionId, title: row.title, state });
  }
  return buildStartedTaskStateNote(entries);
}
