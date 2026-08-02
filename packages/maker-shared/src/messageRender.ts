import {
  type AgentTaskUpdate,
  findAgentTaskUpdate,
  isAgentTaskToolName,
} from './agentTask';
import { HISTORY_GAP_SPLIT_MS } from './historyGap';

export interface MessageRenderSourceMessageLike {
  id?: string | null;
  clientId?: string | null;
  role?: string | null;
  content?: unknown;
  createdAt?: string;
  /** Renderer-local time of the latest in-place plan payload update. */
  planUpdatedAtMs?: number;
  toolName?: string | null;
  toolInput?: unknown;
  /** SDK tool-use id — used to link a Task/collab tool-call to its live `agent_task_update`. */
  toolUseId?: string | null;
}

export type MessageRenderNormalizedMessageKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'thinking'
  | 'ask_user'
  | 'plan_review'
  | 'system';

/**
 * tool 消息携带的产出媒体的最小形状(agent 出图/出视频等,tool_result 里提取)。
 * 只声明分组/去重所需字段;消费端(mobile 等)的完整媒体类型结构性兼容本形状,
 * 经 `dedupeToolMediaByUrl` 的泛型签名保留原类型,渲染时可读到全量字段。
 */
export interface MessageRenderToolMediaLike {
  kind: string;
  url: string;
  title?: string;
}

export interface MessageRenderNormalizedMessage<
  TSource extends MessageRenderSourceMessageLike = MessageRenderSourceMessageLike,
> {
  key: string;
  source: TSource;
  kind: MessageRenderNormalizedMessageKind;
  label: string;
  body: string;
  secondaryBody?: string;
  createdAt: string;
  isStreaming?: boolean;
  /**
   * tool 消息专用:配对 tool_result 的落库时刻(ISO)。`createdAt` 是**调用发起**时刻,
   * 单靠它无法知道一次工具调用什么时候结束 —— 于是一个跑了半小时以上的调用(长 Bash、
   * 子 agent)后面紧跟的下一个调用会被空洞判定误伤,把一段连续工作切碎。空洞锚点优先取
   * 本字段,与桌面 `MessageStream` 的 resultTsMap 同口径。缺失(结果未到 / 老数据)时退回
   * `createdAt`。
   */
  settledAt?: string;
  /** Host 在 SDK done 边界写入；每个 true 都是一条不应折入工作过程的正式回复。 */
  turnCompleted?: boolean;
  /** tool 消息专用:配对 tool_result 提取出的产出媒体(驱动 tool_media 独立渲染项)。 */
  media?: readonly MessageRenderToolMediaLike[];
}

export interface MessageRenderOptions {
  isSessionStreaming?: boolean;
  /**
   * Gate for the orphan `agent_task` sweep. Callers whose `isSessionStreaming` is broader
   * than "a remote turn is running" (e.g. mobile also sets it for local sending/queueing,
   * before the first remote status event arrives) should pass the narrow remote-turn signal
   * here, so stale leftover updates can't flash during the send→status gap. Defaults to
   * `isSessionStreaming` when omitted.
   */
  renderOrphanTaskUpdates?: boolean;
}

export interface MessageRenderTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface MessageRenderMessageItem<
  TMessage extends MessageRenderNormalizedMessage = MessageRenderNormalizedMessage,
> {
  type: 'message';
  key: string;
  message: TMessage;
}

export interface MessageRenderThinkingItem<
  TMessage extends MessageRenderNormalizedMessage = MessageRenderNormalizedMessage,
> {
  type: 'thinking';
  key: string;
  message: TMessage;
  durationMs?: number;
  redacted: boolean;
}

export interface MessageRenderToolGroupItem<
  TMessage extends MessageRenderNormalizedMessage = MessageRenderNormalizedMessage,
> {
  type: 'tool_group';
  key: string;
  tools: TMessage[];
}

export interface MessageRenderTodoCardItem {
  type: 'todo';
  key: string;
  todos: MessageRenderTodoItem[];
  createdAt: string;
  /** True only while this plan card belongs to the session's active unsettled tail. */
  isStreaming?: boolean;
}

/**
 * tool 产出媒体的独立渲染项(对齐桌面 MessageStream 的 'tool_media' RenderItem):
 * agent 出的图/视频(lizi_art、飞书拉图等)跳出 tool_group 折叠,作为聊天流里
 * 独立可见的视觉消息渲染在所属 tool_group 之后。携带的是产出媒体的 tool 消息
 * 引用(同一 normalized 对象),渲染端经 `dedupeToolMediaByUrl` 拿到按 url 去重
 * 的完整媒体列表。刻意不进 MessageRenderWorkChildItem —— 「工作过程」折叠时
 * 产物继续留在折叠块外可见(与桌面语义一致)。
 */
export interface MessageRenderToolMediaItem<
  TMessage extends MessageRenderNormalizedMessage = MessageRenderNormalizedMessage,
> {
  type: 'tool_media';
  key: string;
  /** 本组内携带媒体的 tool 消息(按组内顺序)。 */
  tools: TMessage[];
}

/**
 * A sub-agent task (Claude `Task`/`Agent`, Codex `collab:*`). Carries the originating
 * tool-call (when persisted/known) and/or the live `agent_task_update`. Either may be
 * absent: a linked card has both, an orphan live update has only `update`.
 */
export interface MessageRenderAgentTaskItem<
  TMessage extends MessageRenderNormalizedMessage = MessageRenderNormalizedMessage,
> {
  type: 'agent_task';
  key: string;
  toolCall?: TMessage;
  update?: AgentTaskUpdate;
  createdAt: string;
}

export type MessageRenderWorkChildItem<
  TMessage extends MessageRenderNormalizedMessage = MessageRenderNormalizedMessage,
> =
  | MessageRenderThinkingItem<TMessage>
  | MessageRenderToolGroupItem<TMessage>
  | MessageRenderTodoCardItem
  | MessageRenderAgentTaskItem<TMessage>
  | MessageRenderMessageItem<TMessage>
  | MessageRenderWorkGroupItem<TMessage>;

export interface MessageRenderWorkGroupItem<
  TMessage extends MessageRenderNormalizedMessage = MessageRenderNormalizedMessage,
> {
  type: 'work_group';
  key: string;
  children: MessageRenderWorkChildItem<TMessage>[];
  durationMs?: number;
  /** True only for the trailing activity run in an active turn. */
  isStreaming?: boolean;
  /** Epoch milliseconds of the first real activity, for a live elapsed timer. */
  startedAtMs?: number;
}

export type MessageRenderItem<
  TMessage extends MessageRenderNormalizedMessage = MessageRenderNormalizedMessage,
> =
  | MessageRenderMessageItem<TMessage>
  | MessageRenderThinkingItem<TMessage>
  | MessageRenderToolGroupItem<TMessage>
  | MessageRenderToolMediaItem<TMessage>
  | MessageRenderTodoCardItem
  | MessageRenderAgentTaskItem<TMessage>
  | MessageRenderWorkGroupItem<TMessage>;

export type MessageRenderTodoSource = 'todo' | 'codex' | 'task';

export interface MessageRenderTodoInsertion {
  key: string;
  todos: MessageRenderTodoItem[];
  createdAt?: string;
  updatedAtMs?: number;
  source: MessageRenderTodoSource;
}

export interface MessageRenderLatestTodoState {
  insertion: MessageRenderTodoInsertion | null;
  hasPlanEvent: boolean;
  isResolved: boolean;
  latestPlanIndex: number;
  latestInsertionIndex: number;
}

export interface MessageRenderTodoGroupingOptions {
  keyPrefix?: string;
}

const TASK_PLAN_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

export function buildMessageRenderItems<
  TMessage extends MessageRenderNormalizedMessage,
>(
  messages: readonly TMessage[],
  options: MessageRenderOptions = {},
  taskUpdates?: ReadonlyMap<string, AgentTaskUpdate>,
): MessageRenderItem<TMessage>[] {
  return groupMessageWorkRuns(
    buildLinearItems(
      messages,
      taskUpdates,
      options.renderOrphanTaskUpdates ?? (options.isSessionStreaming === true),
    ),
    options.isSessionStreaming === true,
  );
}

function buildLinearItems<
  TMessage extends MessageRenderNormalizedMessage,
>(
  messages: readonly TMessage[],
  taskUpdates?: ReadonlyMap<string, AgentTaskUpdate>,
  includeOrphanTaskUpdates = false,
): MessageRenderItem<TMessage>[] {
  const sourceMessages = messages.map((message) => message.source);
  const todoInsertAt = findMessageTodoInsertions(sourceMessages);
  const agentPlanToolUseIds = collectAgentPlanToolUseIds(sourceMessages);
  const items: MessageRenderItem<TMessage>[] = [];
  // Keys (toolUseId / clientId / taskId / parentToolUseId) already surfaced as an inline
  // agent_task card, so the orphan-update sweep below doesn't render the same task twice.
  const renderedTaskKeys = new Set<string>();
  let pendingTools: TMessage[] = [];
  // 段内已见过的最晚**结束**时刻(调用发起 / 结果落库取最大值),空洞判定的锚点。
  // 不能只比紧邻的上一条:并行工具会乱序完成(A 跑 40 分钟还没回,B 紧随其后一分钟就结束,
  // 这时又发起 C),只比 B 的早结束时间会把 C 误判成空洞、把一段连续工作切碎
  // (与桌面 MessageStream 的 pendingSegmentEndMs 同口径)。
  let pendingToolsEndMs: number | null = null;
  const notePendingToolEnd = (ms: number | null) => {
    if (ms === null) return;
    pendingToolsEndMs = pendingToolsEndMs === null ? ms : Math.max(pendingToolsEndMs, ms);
  };

  const flushTools = () => {
    pendingToolsEndMs = null;
    if (pendingTools.length === 0) return;
    items.push({
      type: 'tool_group',
      key: `tools-${messageClientId(pendingTools[0])}`,
      tools: pendingTools,
    });
    // tool 产出媒体(agent 出图等)提为独立 tool_media 项,紧跟所属 tool_group,
    // 跳出折叠卡可见(对齐桌面 MessageStream flushSegment)。key 派生自组首 tool
    // 的 clientId(与 tool_group 同源、prefix 不同),流式中组内新增 tool 时稳定。
    const mediaTools = pendingTools.filter((tool) => (tool.media?.length ?? 0) > 0);
    if (dedupeToolMediaByUrl(mediaTools.flatMap((tool) => tool.media ?? [])).length > 0) {
      items.push({
        type: 'tool_media',
        key: `media-${messageClientId(pendingTools[0])}`,
        tools: mediaTools,
      });
    }
    pendingTools = [];
  };

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.kind === 'tool') {
      if (isAgentPlanToolResult(message.source, agentPlanToolUseIds)) {
        continue;
      }
      const toolName = toolNameOf(message.source);
      if (isAgentTaskToolName(toolName)) {
        flushTools();
        const toolUseId = message.source.toolUseId ?? null;
        const clientId = message.source.clientId ?? message.source.id ?? null;
        const update = findAgentTaskUpdate(taskUpdates, toolUseId, clientId);
        const linkKey = toolUseId ?? clientId ?? messageClientId(message);
        renderedTaskKeys.add(linkKey);
        if (update?.taskId) renderedTaskKeys.add(update.taskId);
        if (update?.parentToolUseId) renderedTaskKeys.add(update.parentToolUseId);
        items.push({
          type: 'agent_task',
          key: `task-${linkKey}`,
          toolCall: message,
          update,
          createdAt: message.createdAt,
        });
        continue;
      }
      if (isAgentPlanToolName(toolName)) {
        const insertion = todoInsertAt.get(index);
        if (insertion) {
          flushTools();
          items.push({
            type: 'todo',
            key: insertion.key,
            todos: insertion.todos,
            createdAt: message.createdAt,
            isStreaming: false,
          });
        }
        continue;
      }
      // 历史窗口空洞可能正好落在两次工具调用之间(缺的是 user 行):那样两段窗口的调用会被
      // 合进同一个 tool_group,组首尾时间差直接成了跨空洞的假时长,而工作组分组只看组首时间、
      // 发现不了组内部的跳变。所以段内也按同一阈值切开,让「已工作 Xs」的时长和分组都落在
      // 真实连续的动作上(对齐桌面 MessageStream 的段内切分)。
      const callMs = parseTimestampMs(message.createdAt);
      if (
        pendingTools.length > 0
        && pendingToolsEndMs !== null
        && callMs !== null
        && callMs - pendingToolsEndMs > HISTORY_GAP_SPLIT_MS
      ) {
        flushTools();
      }
      pendingTools.push(message);
      notePendingToolEnd(callMs);
      notePendingToolEnd(parseTimestampMs(message.settledAt));
      continue;
    }

    flushTools();
    if (message.kind === 'thinking') {
      const thinking = parseThinking(message.source);
      items.push({
        type: 'thinking',
        key: `thinking-${messageClientId(message)}`,
        message,
        durationMs: thinking.durationMs,
        redacted: thinking.redacted,
      });
      continue;
    }

    items.push({
      type: 'message',
      key: `message-${messageClientId(message)}`,
      message,
    });
  }
  flushTools();
  if (includeOrphanTaskUpdates) {
    appendOrphanAgentTasks(items, taskUpdates, renderedTaskKeys);
  }
  return items;
}

/**
 * Render live task updates that never matched a persisted tool-call (e.g. Codex collab
 * agents whose spawning tool-call hasn't reached this client). Appended after the linear
 * pass; de-duped against tasks already shown inline via `renderedTaskKeys`.
 *
 * Only invoked while the session is actively running (`isSessionStreaming`): an orphan is a
 * LIVE placeholder for a tool-call that hasn't been persisted/delivered yet. When the session
 * is idle, unmatched updates are stale leftovers (e.g. the originating tool-call slid out of
 * the paged message window) — rendering them would replay old sub-agent cards at the tail of
 * the conversation.
 */
function appendOrphanAgentTasks<
  TMessage extends MessageRenderNormalizedMessage,
>(
  items: MessageRenderItem<TMessage>[],
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate> | undefined,
  renderedTaskKeys: ReadonlySet<string>,
): void {
  if (!taskUpdates) return;
  const seenTaskIds = new Set<string>();
  for (const update of taskUpdates.values()) {
    const primaryKey = update.parentToolUseId ?? update.taskId;
    if (
      seenTaskIds.has(update.taskId)
      || renderedTaskKeys.has(primaryKey)
      || renderedTaskKeys.has(update.taskId)
    ) {
      continue;
    }
    seenTaskIds.add(update.taskId);
    items.push({
      type: 'agent_task',
      key: `task-update-${primaryKey}`,
      update,
      createdAt: update.updatedAt ?? update.createdAt ?? '',
    });
  }
}

/**
 * tool 产出媒体按 url 去重(丢弃空 url):同一 segment 内多个 tool_result 引用同一
 * 张图时只渲染一次,保持插入顺序与 tool 调用顺序一致(对齐桌面 flushSegment 的
 * de-dup)。泛型保留调用方的完整媒体类型(mobile 的 NormalizedToolMedia 等)。
 */
export function dedupeToolMediaByUrl<TMedia extends MessageRenderToolMediaLike>(
  media: readonly TMedia[],
): TMedia[] {
  const seen = new Set<string>();
  const out: TMedia[] = [];
  for (const item of media) {
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

export function findMessageTodoInsertions<TMessage extends MessageRenderSourceMessageLike>(
  messages: readonly TMessage[],
  options: MessageRenderTodoGroupingOptions = {},
): Map<number, MessageRenderTodoInsertion> {
  const keyPrefix = options.keyPrefix ?? 'todo';
  const resultByToolUseId = buildToolResultLookup(messages);
  const sessions: Array<{
    todos: MessageRenderTodoItem[];
    firstIndex: number;
    lastIndex: number;
    source: MessageRenderTodoSource;
  }> = [];
  const lastSessionBySource = new Map<MessageRenderTodoSource, (typeof sessions)[number]>();
  const taskState = new Map<string, MessageRenderTodoItem>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const source = agentPlanSource(toolNameOf(message));
    if (!source) continue;

    const resultText = resultByToolUseId.get(toolUseIdOf(message) ?? '');
    const previous = lastSessionBySource.get(source);
    const previousAllDone = previous?.todos.every((todo) => todo.status === 'completed');
    const continuesCompletedTaskSession =
      source === 'task'
      && Boolean(previousAllDone)
      && taskToolTargetsExistingTask(message, resultText, taskState);
    const startsNewSession = !previous || (Boolean(previousAllDone) && !continuesCompletedTaskSession);
    if (source === 'task' && startsNewSession) {
      taskState.clear();
    }

    const parsed =
      extractPlanTodos(toolNameOf(message), toolInputOf(message))
      ?? applyTaskPlanTool(
        taskState,
        message,
        resultText,
      );
    if (!parsed) continue;

    if (!startsNewSession && previous) {
      previous.todos = parsed;
      previous.lastIndex = index;
    } else {
      const session = { todos: parsed, firstIndex: index, lastIndex: index, source };
      sessions.push(session);
      lastSessionBySource.set(source, session);
    }
  }

  const out = new Map<number, MessageRenderTodoInsertion>();
  for (const session of sessions) {
    const first = messages[session.firstIndex];
    out.set(session.lastIndex, {
      key: `${keyPrefix}-${sourceClientId(first)}`,
      todos: session.todos,
      createdAt: messages[session.lastIndex]?.createdAt,
      updatedAtMs: messages[session.lastIndex]?.planUpdatedAtMs,
      source: session.source,
    });
  }
  return out;
}

/**
 * 常驻计划面板(composer 上方钉住式)用:取整段会话里**最近一次更新**的 plan
 * session 快照 —— 跨 source(TodoWrite / update_plan / Task*)按 lastIndex 取
 * 最大者。面板只展示"当前计划"一份,历史 session 不再逐张呈现。
 * 没有任何 plan 调用时返回 null(面板不渲染、不占位)。
 */
export function findLatestMessageTodoInsertion<TMessage extends MessageRenderSourceMessageLike>(
  messages: readonly TMessage[],
  options: MessageRenderTodoGroupingOptions = {},
): MessageRenderTodoInsertion | null {
  return getLatestMessageTodoState(messages, options).insertion;
}

export function getLatestMessageTodoState<TMessage extends MessageRenderSourceMessageLike>(
  messages: readonly TMessage[],
  options: MessageRenderTodoGroupingOptions = {},
): MessageRenderLatestTodoState {
  let latestPlanIndex = -1;
  let latestPlanMessage: TMessage | null = null;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!isAgentPlanToolName(toolNameOf(message))) continue;
    latestPlanIndex = index;
    latestPlanMessage = message;
  }

  let latest: MessageRenderTodoInsertion | null = null;
  let latestIndex = -1;
  for (const [index, insertion] of findMessageTodoInsertions(messages, options)) {
    if (index > latestIndex) {
      latestIndex = index;
      latest = insertion;
    }
  }
  const hasPlanEvent = latestPlanIndex >= 0;
  const insertionBelongsToLatestEvent = latestIndex === latestPlanIndex;
  const latestEventClearsPlan =
    latestPlanMessage !== null &&
    (isExplicitPlanClearEvent(latestPlanMessage) ||
      latestTaskEventClearsPlan(messages, latestPlanIndex));
  return {
    insertion: insertionBelongsToLatestEvent ? latest : null,
    hasPlanEvent,
    isResolved: !hasPlanEvent || insertionBelongsToLatestEvent || latestEventClearsPlan,
    latestPlanIndex,
    latestInsertionIndex: latestIndex,
  };
}

export interface CodexPlanSnapshotApplyResult<
  TMessage extends MessageRenderSourceMessageLike,
> {
  messages: readonly TMessage[];
  changed: boolean;
  toolUseId: string | null;
}

export function applyCodexPlanSnapshotOnDone<
  TMessage extends MessageRenderSourceMessageLike,
>(
  messages: readonly TMessage[],
  snapshot: unknown,
  turnId?: string | null,
  terminalStatus?: unknown,
  planUpdatedAtMs?: number,
): CodexPlanSnapshotApplyResult<TMessage> {
  const authoritativeSnapshot = Array.isArray(snapshot) ? snapshot : null;
  const hasAuthoritativeSnapshot = authoritativeSnapshot !== null;
  const canInferCompletion = terminalStatus === 'completed' && Boolean(turnId);
  if (!hasAuthoritativeSnapshot && !canInferCompletion) {
    return { messages, changed: false, toolUseId: null };
  }
  const expectedToolUseId = turnId ? `plan:${turnId}` : null;
  const shouldInferCompletion = canInferCompletion && (
    !hasAuthoritativeSnapshot
    || authoritativeSnapshot.some((item) => readRecord(item)?.status !== 'completed')
  );

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'tool_use' || toolNameOf(message) !== 'update_plan') continue;
    const content = readRecord(message.content);
    const contentToolUseId = typeof content?.toolUseId === 'string' ? content.toolUseId : null;
    const toolUseId = message.toolUseId ?? contentToolUseId;
    if (expectedToolUseId && toolUseId !== expectedToolUseId) continue;

    const input = readRecord(toolInputOf(message));
    if (!Array.isArray(input?.plan)) continue;
    // maker-core attaches the latest cached turn/plan/updated snapshot to done.
    // When Codex omits its final plan update, that array still contains open
    // items and is in progress rather than a terminal snapshot. Converge that
    // cached progress (or the persisted row when no snapshot exists) only for a
    // matching, explicitly successful turn. Without a turn id, an array can
    // still be applied as supplied but completion must never be inferred for an
    // unrelated last plan row.
    const snapshotSource = authoritativeSnapshot ?? input.plan;
    const nextSnapshot = shouldInferCompletion
      ? snapshotSource.map((item) => {
          const record = readRecord(item);
          return record ? { ...record, status: 'completed' } : item;
        })
      : authoritativeSnapshot;
    if (!nextSnapshot) {
      return { messages, changed: false, toolUseId: null };
    }
    if (samePlanSnapshot(input.plan, nextSnapshot)) {
      return { messages, changed: false, toolUseId };
    }

    const next = [...messages];
    next[index] = {
      ...message,
      ...(typeof planUpdatedAtMs === 'number' && Number.isFinite(planUpdatedAtMs)
        ? { planUpdatedAtMs }
        : {}),
      ...(message.toolInput !== undefined
        ? { toolInput: { ...input, plan: nextSnapshot } }
        : {}),
      ...(content
        ? { content: { ...content, input: { ...input, plan: nextSnapshot } } }
        : {}),
    };
    return { messages: next, changed: true, toolUseId };
  }
  return { messages, changed: false, toolUseId: null };
}

function samePlanSnapshot(left: unknown[], right: unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isAgentPlanToolName(toolName: string | undefined): boolean {
  return toolName === 'TodoWrite' || toolName === 'update_plan' || Boolean(toolName && TASK_PLAN_TOOL_NAMES.has(toolName));
}

export function extractPlanTodos(toolName: string | undefined, toolInput: unknown): MessageRenderTodoItem[] | null {
  if (toolName === 'TodoWrite') return extractTodos(toolInput);
  if (toolName !== 'update_plan') return null;

  const input = readRecord(toolInput);
  const structured = extractStructuredPlanItems(input?.items) ?? extractStructuredPlanItems(input?.plan);
  if (structured) return structured;

  const text = typeof input?.text === 'string' ? input.text : '';
  if (!text.trim()) return null;

  const items = text
    .split(/\r?\n/)
    .map(normalizePlanLine)
    .filter(Boolean);

  if (items.length === 0) return null;
  return items.map((content, index) => ({
    content,
    status: index === 0 ? 'in_progress' : 'pending',
  }));
}

export function extractTodos(toolInput: unknown): MessageRenderTodoItem[] | null {
  const input = readRecord(toolInput);
  const todos = input?.todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;

  const out = todos
    .map((item): MessageRenderTodoItem | null => {
      const record = readRecord(item);
      if (!record) return null;
      return {
        content: typeof record.content === 'string' ? record.content : String(record.content ?? ''),
        status: normalizeTodoStatus(record.status) ?? 'pending',
        activeForm: typeof record.activeForm === 'string' ? record.activeForm : undefined,
      };
    })
    .filter((item): item is MessageRenderTodoItem => item !== null);
  return out.length > 0 ? out : null;
}

function isExplicitPlanClearEvent(message: MessageRenderSourceMessageLike): boolean {
  const toolName = toolNameOf(message);
  const input = readRecord(toolInputOf(message));
  if (toolName === 'TodoWrite') return Array.isArray(input?.todos) && input.todos.length === 0;
  if (toolName === 'update_plan') {
    return (
      (Array.isArray(input?.items) && input.items.length === 0) ||
      (Array.isArray(input?.plan) && input.plan.length === 0) ||
      (typeof input?.text === 'string' && input.text.trim().length === 0) ||
      (input !== null && Object.keys(input).length === 0)
    );
  }
  return false;
}

function latestTaskEventClearsPlan<TMessage extends MessageRenderSourceMessageLike>(
  messages: readonly TMessage[],
  latestPlanIndex: number,
): boolean {
  const latest = messages[latestPlanIndex];
  const latestToolName = toolNameOf(latest);
  const resultByToolUseId = buildToolResultLookup(messages);
  const latestResultText = resultByToolUseId.get(toolUseIdOf(latest) ?? '');
  if (latestToolName === 'TaskList') return taskListResultClearsPlan(latestResultText);
  if (latestToolName !== 'TaskUpdate' && latestToolName !== 'TaskGet') return false;
  if (taskToolStatus(latest, latestResultText) !== 'deleted') return false;

  const taskState = new Map<string, MessageRenderTodoItem>();
  let previousTaskTodos: MessageRenderTodoItem[] | null = null;
  let resolvedTaskContext = false;

  for (let index = 0; index <= latestPlanIndex; index += 1) {
    const message = messages[index];
    if (agentPlanSource(toolNameOf(message)) !== 'task') continue;

    const resultText = resultByToolUseId.get(toolUseIdOf(message) ?? '');
    const startsNewSession =
      previousTaskTodos === null ||
      (
        previousTaskTodos.every((todo) => todo.status === 'completed') &&
        !taskToolTargetsExistingTask(message, resultText, taskState)
      );
    if (startsNewSession) taskState.clear();

    const hadTaskContext = taskState.size > 0;
    const parsed = applyTaskPlanTool(
      taskState,
      message,
      resultText,
    );
    if (parsed) {
      resolvedTaskContext = true;
      previousTaskTodos = parsed;
      continue;
    }
    if (index === latestPlanIndex) {
      return resolvedTaskContext && hadTaskContext && taskState.size === 0;
    }
  }
  return false;
}

function buildToolResultLookup<TMessage extends MessageRenderSourceMessageLike>(
  messages: readonly TMessage[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const message of messages) {
    const toolUseId = toolUseIdOf(message);
    if (!toolUseId || !isToolResultSource(message)) continue;
    const result = toolResultTextOf(message);
    if (result !== undefined) out.set(toolUseId, result);
  }
  return out;
}

function collectAgentPlanToolUseIds<TMessage extends MessageRenderSourceMessageLike>(
  messages: readonly TMessage[],
): Set<string> {
  const out = new Set<string>();
  for (const message of messages) {
    if (!isAgentPlanToolName(toolNameOf(message))) continue;
    const toolUseId = toolUseIdOf(message);
    if (toolUseId) out.add(toolUseId);
  }
  return out;
}

function isAgentPlanToolResult(
  message: MessageRenderSourceMessageLike,
  agentPlanToolUseIds: ReadonlySet<string>,
): boolean {
  if (!isToolResultSource(message)) return false;
  const toolUseId = toolUseIdOf(message);
  return Boolean(toolUseId && agentPlanToolUseIds.has(toolUseId));
}

function agentPlanSource(toolName: string | undefined): MessageRenderTodoSource | null {
  if (toolName === 'TodoWrite') return 'todo';
  if (toolName === 'update_plan') return 'codex';
  if (toolName && TASK_PLAN_TOOL_NAMES.has(toolName)) return 'task';
  return null;
}

function normalizeTodoStatus(value: unknown): MessageRenderTodoItem['status'] | null {
  if (value === 'pending' || value === 'completed') return value;
  if (value === 'in_progress' || value === 'inProgress' || value === 'running') return 'in_progress';
  return null;
}

function normalizeTaskStatus(status: unknown): MessageRenderTodoItem['status'] | 'deleted' | null {
  if (status === 'pending' || status === 'in_progress' || status === 'completed') return status;
  if (status === 'running' || status === 'inProgress') return 'in_progress';
  if (status === 'deleted') return 'deleted';
  return null;
}

function taskToolStatus(
  message: MessageRenderSourceMessageLike,
  resultText: string | undefined,
): MessageRenderTodoItem['status'] | 'deleted' | null {
  const toolName = toolNameOf(message);
  const input = readRecord(toolInputOf(message));
  const resultTask = taskRecordsFromResult(resultText)[0];
  if (toolName === 'TaskGet' && resultTask) return normalizeTaskStatus(resultTask.status);
  return normalizeTaskStatus(input?.status ?? resultTask?.status);
}

function taskToolTargetsExistingTask(
  message: MessageRenderSourceMessageLike,
  resultText: string | undefined,
  taskState: ReadonlyMap<string, MessageRenderTodoItem>,
): boolean {
  const toolName = toolNameOf(message);
  if (toolName !== 'TaskUpdate' && toolName !== 'TaskGet') return false;
  const input = readRecord(toolInputOf(message));
  const resultTask = taskRecordsFromResult(resultText)[0];
  const id = taskId(input ?? undefined) ?? taskId(resultTask);
  return Boolean(id && taskState.has(id));
}

function extractStructuredPlanItems(items: unknown): MessageRenderTodoItem[] | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const todos = items
    .map((item): MessageRenderTodoItem | null => {
      const record = readRecord(item);
      if (!record) return null;
      const rawContent = record.content ?? record.text ?? record.step ?? record.title;
      const content = typeof rawContent === 'string' ? rawContent.trim() : String(rawContent ?? '').trim();
      if (!content) return null;
      return {
        content,
        status: normalizeTodoStatus(record.status) ?? 'pending',
      };
    })
    .filter((item): item is MessageRenderTodoItem => item !== null);
  return todos.length > 0 ? todos : null;
}

function normalizePlanLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*\[[ xX-]\]\s+/, '')
    .trim();
}

function applyTaskPlanTool(
  taskState: Map<string, MessageRenderTodoItem>,
  message: MessageRenderSourceMessageLike,
  resultText: string | undefined,
): MessageRenderTodoItem[] | null {
  const toolName = toolNameOf(message);
  if (!TASK_PLAN_TOOL_NAMES.has(toolName)) return null;
  const input = readRecord(toolInputOf(message)) ?? {};
  const resultTasks = taskRecordsFromResult(resultText);

  if (toolName === 'TaskList') {
    if (resultTasks.length === 0) {
      if (taskListResultClearsPlan(resultText)) {
        taskState.clear();
        return null;
      }
      return currentTaskTodos(taskState);
    }
    const previousTaskState = new Map(taskState);
    taskState.clear();
    for (const task of resultTasks) {
      const id = taskId(task);
      if (!id) continue;
      const status = normalizeTaskStatus(task.status) ?? 'pending';
      if (status === 'deleted') continue;
      const content = taskContent(task) ?? previousTaskState.get(id)?.content;
      if (!content) continue;
      taskState.set(id, {
        content,
        status,
      });
    }
    return currentTaskTodos(taskState);
  }

  const resultTask = resultTasks[0];
  if (toolName === 'TaskCreate') {
    const id = taskId(resultTask) ?? taskId(input) ?? `task-create:${toolUseIdOf(message) ?? sourceClientId(message)}`;
    const status = normalizeTaskStatus(resultTask?.status);
    const content = taskContent(input) ?? taskContent(resultTask);
    if (!content) return currentTaskTodos(taskState);
    taskState.set(id, {
      content,
      status: status && status !== 'deleted' ? status : 'pending',
    });
    return currentTaskTodos(taskState);
  }

  const id = taskId(input) ?? taskId(resultTask);
  if (!id) return currentTaskTodos(taskState);

  if (toolName === 'TaskGet' && resultTask) {
    const existing = taskState.get(id);
    const status = normalizeTaskStatus(resultTask.status) ?? taskState.get(id)?.status ?? 'pending';
    if (status === 'deleted') {
      taskState.delete(id);
    } else {
      const content = taskContent(resultTask) ?? existing?.content;
      if (!content) return currentTaskTodos(taskState);
      taskState.set(id, {
        content,
        status,
      });
    }
    return currentTaskTodos(taskState);
  }

  const existing = taskState.get(id);
  const status = normalizeTaskStatus(input.status ?? resultTask?.status) ?? existing?.status ?? 'pending';
  if (status === 'deleted') {
    taskState.delete(id);
    return currentTaskTodos(taskState);
  }
  const content = taskContent(input) ?? taskContent(resultTask) ?? existing?.content;
  if (!content) return currentTaskTodos(taskState);
  taskState.set(id, {
    content,
    status,
  });
  return currentTaskTodos(taskState);
}

function taskListResultClearsPlan(resultText: string | undefined): boolean {
  const parsed = tryParseJsonRecord(resultText);
  return Boolean(parsed && Array.isArray(parsed.tasks) && parsed.tasks.length === 0);
}

function currentTaskTodos(taskState: Map<string, MessageRenderTodoItem>): MessageRenderTodoItem[] | null {
  const todos = [...taskState.values()].filter((todo) => todo.content.trim().length > 0);
  return todos.length > 0 ? todos : null;
}

function taskRecordsFromResult(resultText: string | undefined): Array<Record<string, unknown>> {
  const parsed = tryParseJsonRecord(resultText);
  if (!parsed) return taskRecordsFromPlainResult(resultText);
  const rawTasks = parsed.tasks;
  if (Array.isArray(rawTasks)) {
    return rawTasks.filter((task): task is Record<string, unknown> =>
      Boolean(task && typeof task === 'object' && !Array.isArray(task)),
    );
  }
  const rawTask = parsed.task;
  if (rawTask && typeof rawTask === 'object' && !Array.isArray(rawTask)) {
    return [rawTask as Record<string, unknown>];
  }
  if (taskId(parsed) || taskContent(parsed)) return [parsed];
  return taskRecordsFromPlainResult(resultText);
}

function taskRecordsFromPlainResult(resultText: string | undefined): Array<Record<string, unknown>> {
  if (!resultText?.trim()) return [];
  const tasks: Array<Record<string, unknown>> = [];
  for (const rawLine of resultText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const created = parsePlainTaskCreatedLine(line);
    if (created) {
      tasks.push(created);
      continue;
    }

    const snapshot = parsePlainTaskSnapshotLine(line);
    if (snapshot) {
      tasks.push(snapshot);
    }
  }
  return tasks;
}

function parsePlainTaskCreatedLine(line: string): Record<string, unknown> | null {
  if (!line.toLowerCase().startsWith('task')) return null;
  if (!isWhitespaceCode(line.charCodeAt('task'.length))) return null;
  const afterTask = line.slice('task'.length).trimStart();
  if (!afterTask.startsWith('#')) return null;
  const afterHash = afterTask.slice(1);
  const idEnd = firstWhitespaceIndex(afterHash);
  if (idEnd <= 0) return null;
  const id = afterHash.slice(0, idEnd);
  const rest = afterHash.slice(idEnd).trimStart();
  const marker = 'created successfully:';
  if (!rest.toLowerCase().startsWith(marker)) return null;
  const subject = rest.slice(marker.length).trim();
  return subject ? { id, status: 'pending', subject } : null;
}

function parsePlainTaskSnapshotLine(line: string): Record<string, unknown> | null {
  if (!line.startsWith('#')) return null;
  const afterHash = line.slice(1);
  const idEnd = firstWhitespaceIndex(afterHash);
  if (idEnd <= 0) return null;
  const id = afterHash.slice(0, idEnd);
  const rest = afterHash.slice(idEnd).trimStart();
  if (!rest.startsWith('[')) return null;
  const statusEnd = rest.indexOf(']');
  if (statusEnd <= 1) return null;
  const status = rest.slice(1, statusEnd).trim();
  let subject = rest.slice(statusEnd + 1).trim();
  const trailingMetaStart = subject.lastIndexOf(' [');
  if (trailingMetaStart > 0 && subject.endsWith(']')) {
    subject = subject.slice(0, trailingMetaStart).trim();
  }
  return subject ? { id, status, subject } : null;
}

function firstWhitespaceIndex(value: string): number {
  for (let index = 0; index < value.length; index++) {
    if (isWhitespaceCode(value.charCodeAt(index))) {
      return index;
    }
  }
  return -1;
}

function isWhitespaceCode(code: number): boolean {
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;
}

function firstString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function taskContent(record: Record<string, unknown> | undefined): string | undefined {
  return firstString(record, ['subject', 'content', 'description', 'activeForm', 'active_form', 'title', 'text']);
}

function taskId(record: Record<string, unknown> | undefined): string | undefined {
  return firstString(record, ['taskId', 'task_id', 'id']);
}

function tryParseJsonRecord(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return readRecord(parsed);
  } catch {
    return null;
  }
}

function groupMessageWorkRuns<
  TMessage extends MessageRenderNormalizedMessage,
>(
  items: readonly MessageRenderItem<TMessage>[],
  isSessionStreaming: boolean,
): MessageRenderItem<TMessage>[] {
  const out: MessageRenderItem<TMessage>[] = [];
  let currentTurn: MessageRenderItem<TMessage>[] = [];

  const flushTurn = (activeTail: boolean) => {
    if (currentTurn.length === 0) return;
    if (activeTail && isSessionStreaming) {
      out.push(...groupActiveWorkRuns(currentTurn));
      currentTurn = [];
      return;
    }
    const grouped = groupAnsweredTurnItems(currentTurn);
    out.push(...(grouped.handled ? grouped.items : groupLegacyWorkRuns(currentTurn)));
    currentTurn = [];
  };

  // 空洞判定的锚点:上一个 item 的**结束**时间(见 itemEndTimestamp)。用开始时间会让一个
  // 正常的长时段工具组/thinking 把紧随其后的 item 误判成空洞。取已见过的最大值而非无条件
  // 覆盖:并行的 Agent/Task 可能乱序完成,锚点回退会让后面的最终答复被误切、时长被低报。
  // 无时间戳的 item 不重置锚点,让间隔判定跨过它继续比对上一个有时间的动作。
  let prevEndMs: number | null = null;
  const noteEnd = (item: MessageRenderItem<TMessage>) => {
    const endMs = itemEndTimestamp(item);
    if (endMs === null) return;
    prevEndMs = prevEndMs === null ? endMs : Math.max(prevEndMs, endMs);
  };

  for (const item of items) {
    if (item.type === 'message' && item.message.kind === 'user') {
      flushTurn(false);
      out.push(item);
      noteEnd(item);
      continue;
    }
    // 窗口空洞:user 行是唯一的 turn 边界,窗口里缺了它,两段不相干的历史就会被折进同一个
    // 「已工作 Xs」并谎报时长(手机端实测一条组吞掉整场会话的 6 轮对话)。相邻动作间隔超过
    // 阈值时同样切断 —— 见 HISTORY_GAP_SPLIT_MS 的完整理由。
    const startMs = itemTimestamp(item);
    if (
      prevEndMs !== null
      && startMs !== null
      && startMs - prevEndMs > HISTORY_GAP_SPLIT_MS
    ) {
      flushTurn(false);
    }
    currentTurn.push(item);
    noteEnd(item);
  }
  flushTurn(true);
  return out;
}

function groupAnsweredTurnItems<
  TMessage extends MessageRenderNormalizedMessage,
>(items: readonly MessageRenderItem<TMessage>[]): {
  items: MessageRenderItem<TMessage>[];
  handled: boolean;
} {
  const sealedAnswers = new Set<number>();
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (isAssistantAnswerCandidate(item) && isCompletedAssistantMessage(item.message)) {
      sealedAnswers.add(index);
    }
  }

  let lastAnswerIndex = -1;
  for (let index = items.length - 1; index >= 0; index--) {
    if (isAssistantAnswerCandidate(items[index])) {
      lastAnswerIndex = index;
      break;
    }
  }
  if (lastAnswerIndex < 0) return { items: [...items], handled: false };

  // 新数据按 SDK done seal 分段；旧数据没有 seal 时保持原有 last-answer 兼容行为。
  if (sealedAnswers.size > 0) {
    let segmentStartIndex = 0;
    for (const sealedIndex of [...sealedAnswers]) {
      let lastWorkActivityIndex = -1;
      for (let index = sealedIndex - 1; index >= segmentStartIndex; index--) {
        if (isWorkActivityItem(items[index])) {
          lastWorkActivityIndex = index;
          break;
        }
      }
      let answerStartIndex = sealedIndex;
      while (
        answerStartIndex > lastWorkActivityIndex + 1
        && answerStartIndex > segmentStartIndex
        && isAssistantAnswerCandidate(items[answerStartIndex - 1])
      ) {
        answerStartIndex--;
      }
      for (let index = answerStartIndex; index <= sealedIndex; index++) {
        if (isAssistantAnswerCandidate(items[index])) sealedAnswers.add(index);
      }
      segmentStartIndex = sealedIndex + 1;
    }
  } else {
    const hasWorkAfterLastAnswer = items.some(
      (item, index) => index > lastAnswerIndex && isWorkActivityItem(item),
    );
    if (hasWorkAfterLastAnswer) return { items: [...items], handled: false };

    let lastWorkActivityIndex = -1;
    for (let index = lastAnswerIndex - 1; index >= 0; index--) {
      if (isWorkActivityItem(items[index])) {
        lastWorkActivityIndex = index;
        break;
      }
    }
    let finalAnswerStartIndex = lastAnswerIndex;
    if (lastWorkActivityIndex >= 0) {
      while (
        finalAnswerStartIndex > lastWorkActivityIndex + 1
        && isAssistantAnswerCandidate(items[finalAnswerStartIndex - 1])
      ) {
        finalAnswerStartIndex--;
      }
    }
    for (let index = finalAnswerStartIndex; index <= lastAnswerIndex; index++) {
      if (isAssistantAnswerCandidate(items[index])) sealedAnswers.add(index);
    }
  }

  const out: MessageRenderItem<TMessage>[] = [];
  let run: MessageRenderWorkChildItem<TMessage>[] = [];
  const flushRun = (nextItem?: MessageRenderItem<TMessage>) => {
    if (run.length === 0) return;
    out.push(createCompletedWorkGroup(run, nextItem));
    run = [];
  };

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (
      !sealedAnswers.has(index)
      && !isRunningAgentTaskItem(item)
      && !isDeliveryProseItem(item)
      && isWorkChild(item)
    ) {
      run.push(item);
    } else {
      flushRun(item);
      out.push(item);
    }
  }
  flushRun();
  return { items: out, handled: true };
}

function groupLegacyWorkRuns<TMessage extends MessageRenderNormalizedMessage>(
  items: readonly MessageRenderItem<TMessage>[],
): MessageRenderItem<TMessage>[] {
  const out: MessageRenderItem<TMessage>[] = [];
  let run: MessageRenderWorkChildItem<TMessage>[] = [];
  const flushRun = (nextItem?: MessageRenderItem<TMessage>) => {
    if (run.length === 0) return;
    out.push(createWorkGroup(run, nextItem));
    run = [];
  };
  for (const item of items) {
    if (isWorkActivityItem(item)) run.push(item);
    else {
      flushRun(item);
      out.push(item);
    }
  }
  flushRun();
  return out;
}

/** Active turn: assistant text and compact cards close the previous activity run. */
function groupActiveWorkRuns<TMessage extends MessageRenderNormalizedMessage>(
  items: readonly MessageRenderItem<TMessage>[],
): MessageRenderItem<TMessage>[] {
  let lastCompletedBoundaryIndex = -1;
  for (let index = 0; index < items.length; index++) {
    if (isAssistantAnswerCandidate(items[index]) || isCompactBoundaryItem(items[index])) {
      lastCompletedBoundaryIndex = index;
    }
  }

  const out: MessageRenderItem<TMessage>[] = [];
  let run: MessageRenderWorkChildItem<TMessage>[] = [];
  let runLastIndex = -1;
  const flushRun = (nextItem?: MessageRenderItem<TMessage>) => {
    if (run.length === 0) return;
    out.push(createWorkGroup(run, nextItem, runLastIndex > lastCompletedBoundaryIndex));
    run = [];
  };
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (isWorkActivityItem(item)) {
      run.push(item);
      runLastIndex = index;
    } else {
      flushRun(item);
      out.push(item.type === 'todo'
        ? { ...item, isStreaming: index > lastCompletedBoundaryIndex }
        : item);
    }
  }
  flushRun();
  return out;
}

/**
 * 运行中(未到终态)的子 Agent 卡是折叠时的"可见锚点",绝不折进「工作过程」组:
 * 任务没完成就归档会谎报终态(典型:后台子 agent 仍在跑,父 turn 已产出最终正文)。
 * status 派生口径与 buildAgentTaskCardModel / 桌面 MessageStream 的 isRunningAgentTask
 * 完全一致(update.status 优先;否则有配对工具结果 secondaryBody 视为 completed、
 * 无则 running),保证「卡片显示运行中」与「是否折叠」永远同步。
 * 终态 = completed/failed/stopped。
 */
function isRunningAgentTaskItem<
  TMessage extends MessageRenderNormalizedMessage,
>(item: MessageRenderItem<TMessage>): boolean {
  if (item.type !== 'agent_task') return false;
  const status = item.update?.status ?? (item.toolCall?.secondaryBody ? 'completed' : 'running');
  return status === 'running';
}

function isCompletedAssistantMessage(message: MessageRenderNormalizedMessage): boolean {
  return message.turnCompleted === true;
}

function isAssistantAnswerCandidate<
  TMessage extends MessageRenderNormalizedMessage,
>(item: MessageRenderItem<TMessage>): item is MessageRenderMessageItem<TMessage> {
  return item.type === 'message'
    && item.message.kind === 'assistant'
    && item.message.body.trim().length > 0;
}

function isCompactBoundaryItem<TMessage extends MessageRenderNormalizedMessage>(
  item: MessageRenderItem<TMessage>,
): item is MessageRenderMessageItem<TMessage> {
  return item.type === 'message'
    && item.message.kind === 'system'
    && item.message.label === 'system:compact';
}

/**
 * 「交付正文」长度阈值:超过它的 assistant 正文一律当本轮产出,不折进「工作过程」。
 * 取 600 字符 —— 进度旁白（「先运行脚本」「继续读剩余 diff」）都在几十字量级,
 * 而值得留在消息流里的简报、分析、总结普遍远超它。
 */
const DELIVERY_PROSE_MIN_LENGTH = 600;

/** 块级 markdown 标题:交付正文最强的结构信号,进度旁白不会给自己写标题。 */
const MARKDOWN_HEADING_RE = /^[ \t]{0,3}#{1,6}[ \t]+\S/m;

/**
 * 表格分隔行(`| --- | :-: |`)。刻意要求同一行里既有 `-{3,}` 又有 `|`:
 * 只有成型的表格会这样,单独的 `---` 水平线不算交付信号。
 */
const MARKDOWN_TABLE_DIVIDER_RE = /^[ \t]{0,3}\|?[ \t]*:?-{3,}:?[ \t]*\|[-:| \t]*$/m;

/** 块级列表项(无序 / 有序)。 */
const MARKDOWN_LIST_ITEM_RE = /^[ \t]{0,3}(?:[-*+][ \t]+|\d{1,3}[.)][ \t]+)\S/gm;

/** 列表要 ≥3 项才算交付结构:「我要做两件事」这类旁白也会顺手列两条。 */
const DELIVERY_PROSE_MIN_LIST_ITEMS = 3;

/**
 * 这段 assistant 正文是不是「交付内容」(而非进度旁白)。
 *
 * 判据刻意与位置无关:长度达阈值,或带块级 markdown 结构(标题 / 表格 /
 * ≥3 项列表)。两端共用这一份口径,不各自实现。
 */
export function isDeliveryProseText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length >= DELIVERY_PROSE_MIN_LENGTH) return true;
  if (MARKDOWN_HEADING_RE.test(trimmed)) return true;
  if (MARKDOWN_TABLE_DIVIDER_RE.test(trimmed)) return true;
  // /g 正则不用 test():lastIndex 会在调用之间残留。
  const listItems = trimmed.match(MARKDOWN_LIST_ITEM_RE);
  return (listItems?.length ?? 0) >= DELIVERY_PROSE_MIN_LIST_ITEMS;
}

/**
 * 交付正文 item —— 无论落在 turn 的哪个位置都不折进「工作过程」。
 *
 * 为什么只靠 seal 位置不够:「最终答复」只认最后一次动作之后的正文,而 agent
 * 常见「先输出正文 → 再执行一个收尾副作用(发通知 / 落库 / 提交) → 再说一句
 * 已完成」。这时真正的交付内容排在收尾动作之前,会被整段折起来,只剩收尾那句
 * 元数据留在消息流里(实例:2026-07-31 定时巡检的产品决策简报 3250 字被折,
 * 外面只剩 110 字的「已触发通知」)。
 */
function isDeliveryProseItem<TMessage extends MessageRenderNormalizedMessage>(
  item: MessageRenderItem<TMessage>,
): boolean {
  return item.type === 'message'
    && item.message.kind === 'assistant'
    && isDeliveryProseText(item.message.body);
}

function isWorkChild<
  TMessage extends MessageRenderNormalizedMessage,
>(item: MessageRenderItem<TMessage>): item is MessageRenderWorkChildItem<TMessage> {
  return (
    item.type === 'thinking'
    || item.type === 'tool_group'
    || item.type === 'agent_task'
    || (
      item.type === 'message'
      && item.message.kind === 'assistant'
      && item.message.body.trim().length > 0
    )
  );
}

/** Assistant progress text remains visible while running and never consumes the latest-five window. */
function isWorkActivityItem<TMessage extends MessageRenderNormalizedMessage>(
  item: MessageRenderItem<TMessage>,
): item is MessageRenderThinkingItem<TMessage> | MessageRenderToolGroupItem<TMessage> | MessageRenderAgentTaskItem<TMessage> {
  return !isRunningAgentTaskItem(item)
    && (item.type === 'thinking' || item.type === 'tool_group' || item.type === 'agent_task');
}

function createWorkGroup<
  TMessage extends MessageRenderNormalizedMessage,
>(
  children: MessageRenderWorkChildItem<TMessage>[],
  nextItem?: MessageRenderItem<TMessage>,
  isStreaming = false,
): MessageRenderWorkGroupItem<TMessage> {
  const firstActivity = children.find((item) => item.type !== 'message' || item.message.kind === 'thinking');
  const start = itemTimestamp(firstActivity ?? children[0]);
  const end = nextItem ? itemTimestamp(nextItem) : workRunFallbackEnd(children);
  const durationMs = start !== null && end !== null && end >= start ? end - start : undefined;
  return {
    type: 'work_group',
    key: `work-${workChildKey(firstActivity ?? children[0])}`,
    children,
    durationMs,
    isStreaming,
    ...(start !== null ? { startedAtMs: start } : {}),
  };
}

function createCompletedWorkGroup<TMessage extends MessageRenderNormalizedMessage>(
  run: MessageRenderWorkChildItem<TMessage>[],
  nextItem?: MessageRenderItem<TMessage>,
): MessageRenderWorkGroupItem<TMessage> {
  const hasAssistantText = run.some(
    (item) => item.type === 'message' && item.message.kind === 'assistant',
  );
  if (!hasAssistantText) return createWorkGroup(run, nextItem);

  const children: MessageRenderWorkChildItem<TMessage>[] = [];
  let activityRun: MessageRenderWorkChildItem<TMessage>[] = [];
  const flushActivityRun = (activityNextItem?: MessageRenderItem<TMessage>) => {
    if (activityRun.length === 0) return;
    children.push(createWorkGroup(activityRun, activityNextItem));
    activityRun = [];
  };
  for (const item of run) {
    if (item.type !== 'work_group' && isWorkActivityItem(item)) {
      activityRun.push(item);
    } else {
      flushActivityRun(item);
      children.push(item);
    }
  }
  flushActivityRun(nextItem);
  const outer = createWorkGroup(run, nextItem);
  const firstActivity = run.find((item) => item.type !== 'message' || item.message.kind === 'thinking');
  return {
    ...outer,
    key: `work-summary-${workChildKey(firstActivity ?? run[0])}`,
    children,
    isStreaming: false,
  };
}

/**
 * 没有下一项可作结算边界时(turn 尾部、或被空洞切开的那一段)的组结束时刻:取组内**全部**子项
 * 结束时刻的最大值。
 *
 * 两处都不能省:
 *  - 必须用 itemEndTimestamp 而不是开始时刻 —— 一段只含工具活动、20 分钟后才回结果的组,拿
 *    调用的开始时间当结束会把时长报成约 1 秒。空洞切分让这条回退路径变常见(空洞前那一段永远
 *    没有 nextItem),低报会取代原来的超大时长成为新的谎报(#1210 review)。
 *  - 必须遍历全部子项取 max 而不是"取最后一个" —— 子项按**发起**时刻排序,并行的 Agent/Task
 *    会乱序完成:A 先发起跑 40 分钟,B 后发起 2 分钟就结束,最后一个子项是 B,取它就把 A 的
 *    40 分钟丢了。桌面 `workRunEndTs` 同款遍历取 max(#676 review codex P1),本文件
 *    `groupMessageWorkRuns` 的锚点也是同一口径。
 */
function workRunFallbackEnd<TMessage extends MessageRenderNormalizedMessage>(
  run: readonly MessageRenderWorkChildItem<TMessage>[],
): number | null {
  let latest: number | null = null;
  for (const item of run) {
    latest = maxTimestamp(latest, itemEndTimestamp(item));
  }
  return latest;
}

export function formatDuration(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function itemTimestamp<
  TMessage extends MessageRenderNormalizedMessage,
>(item: MessageRenderItem<TMessage>): number | null {
  const createdAt = itemCreatedAt(item);
  const timestamp = new Date(createdAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function itemCreatedAt<
  TMessage extends MessageRenderNormalizedMessage,
>(item: MessageRenderItem<TMessage>): string {
  if (item.type === 'tool_group' || item.type === 'tool_media') return item.tools[0]?.createdAt ?? '';
  if (item.type === 'todo') return item.createdAt;
  if (item.type === 'agent_task') return item.createdAt;
  if (item.type === 'work_group') return item.children[0] ? itemCreatedAt(item.children[0]) : '';
  return item.message.createdAt;
}

/**
 * item 的**结束**时刻,空洞判定的锚点(口径与桌面 `renderItemEndMs` 一致):
 *
 *  - tool_group / tool_media:组内全部调用与结果时刻的最大值(结果时刻见 `settledAt`);
 *  - agent_task:live update 的 updatedAt → createdAt → 调用发起时刻,再与配对结果时刻取更晚
 *    (历史会话没有 live update,只有结果时刻才是这张卡真正的结束);
 *  - thinking:createdAt 是块**开始**的时刻,要加上时长 —— 一个想了半小时以上的 thinking 块
 *    后面紧跟工具或正文时,只看 createdAt 会把它误判成空洞、切开一个本来连续的 turn;
 *  - 其余:退回开始时刻。
 */
function itemEndTimestamp<
  TMessage extends MessageRenderNormalizedMessage,
>(item: MessageRenderItem<TMessage>): number | null {
  if (item.type === 'tool_group' || item.type === 'tool_media') {
    let end: number | null = null;
    for (const tool of item.tools) {
      end = maxTimestamp(end, parseTimestampMs(tool.createdAt));
      end = maxTimestamp(end, parseTimestampMs(tool.settledAt));
    }
    return end ?? itemTimestamp(item);
  }
  if (item.type === 'agent_task') {
    const liveEnd = parseTimestampMs(
      item.update?.updatedAt ?? item.update?.createdAt ?? item.toolCall?.createdAt,
    ) ?? itemTimestamp(item);
    return maxTimestamp(liveEnd, parseTimestampMs(item.toolCall?.settledAt));
  }
  if (item.type === 'work_group') {
    // 全量取 max,不是"最后一个 child":children 按**发起**时刻排列,并行动作乱序完成时真正的
    // 结束时刻可能落在更靠前的 child 上(先发起、更晚 settle)。取最后一个会低估组的结束时间,
    // 于是空洞判定的锚点变小、把本来连续的 turn 误判成空洞切开(#1210 review)。与
    // `workRunFallbackEnd` / `groupMessageWorkRuns` 的锚点同一口径。
    let latest: number | null = null;
    for (const child of item.children) {
      latest = maxTimestamp(latest, itemEndTimestamp(child));
    }
    return latest;
  }
  const start = itemTimestamp(item);
  if (item.type === 'thinking' && start !== null) {
    // durationMs 可能是负数 / 非有限值(上游同样做了夹断防御)。不夹断会得出 end < start,
    // 空洞判定与工作组时长都跟着错。
    const durationMs = item.durationMs;
    return start + (typeof durationMs === 'number' && Number.isFinite(durationMs)
      ? Math.max(0, durationMs)
      : 0);
  }
  return start;
}

function maxTimestamp(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function parseTimestampMs(createdAt: string | null | undefined): number | null {
  if (!createdAt) return null;
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function workChildKey<
  TMessage extends MessageRenderNormalizedMessage,
>(item: MessageRenderWorkChildItem<TMessage>): string {
  if (item.type === 'tool_group') return messageClientId(item.tools[0]);
  if (item.type === 'todo') return item.key.startsWith('todo-') ? item.key.slice('todo-'.length) : item.key;
  if (item.type === 'agent_task') return item.toolCall ? messageClientId(item.toolCall) : item.key;
  if (item.type === 'work_group') return item.key;
  return messageClientId(item.message);
}

function messageClientId(message: MessageRenderNormalizedMessage | undefined): string {
  if (!message) return 'unknown';
  return sourceClientId(message.source) || message.key;
}

function sourceClientId(message: MessageRenderSourceMessageLike | undefined): string {
  if (!message) return 'unknown';
  return message.clientId || message.id || 'unknown';
}

function toolNameOf(message: MessageRenderSourceMessageLike): string {
  if (typeof message.toolName === 'string') return message.toolName;
  const content = readRecord(message.content);
  if (typeof content?.toolName === 'string') return content.toolName;
  if (typeof content?.name === 'string') return content.name;
  return '';
}

function toolInputOf(message: MessageRenderSourceMessageLike): unknown {
  if (message.toolInput !== undefined) return message.toolInput;
  const content = readRecord(message.content);
  return content?.input;
}

function toolUseIdOf(message: MessageRenderSourceMessageLike): string | undefined {
  if (typeof message.toolUseId === 'string' && message.toolUseId.length > 0) return message.toolUseId;
  const content = readRecord(message.content);
  if (typeof content?.toolUseId === 'string' && content.toolUseId.length > 0) return content.toolUseId;
  if (typeof content?.id === 'string' && content.id.length > 0) return content.id;
  return undefined;
}

function isToolResultSource(message: MessageRenderSourceMessageLike): boolean {
  if (message.role === 'tool_result') return true;
  const content = readRecord(message.content);
  return content?.role === 'tool_result' || content?.type === 'tool_result' || content?.kind === 'tool_result';
}

function toolResultTextOf(message: MessageRenderSourceMessageLike): string | undefined {
  if (typeof message.content === 'string') return message.content;
  const content = readRecord(message.content);
  if (typeof content?.content === 'string') return content.content;
  if (typeof content?.result === 'string') return content.result;
  if (typeof content?.text === 'string') return content.text;
  return undefined;
}

function parseThinking(message: MessageRenderSourceMessageLike): { durationMs?: number; redacted: boolean } {
  const content = readRecord(message.content);
  const durationMs = typeof content?.durationMs === 'number' && Number.isFinite(content.durationMs)
    ? content.durationMs
    : undefined;
  return {
    durationMs,
    redacted: content?.isRedacted === true,
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * 从单条 source message 直接抽取 todo 列表(用于移动端从 `sessions:patched` 等单消息回流即时
 * 渲染 todo 卡,不经过 `buildMessageRenderItems` 的整段会话编排)。桌面侧走 `findMessageTodoInsertions`
 * 的多消息归并路径,移动端这条是按单消息就地解析的轻量入口,二者共用同一 `MessageRenderTodoItem` 形状。
 */
export function extractTodosFromSourceMessage(message: MessageRenderSourceMessageLike): MessageRenderTodoItem[] | null {
  const input = readRecord(readRecord(message.content)?.input);
  const todos = input?.todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;

  return todos.map((item) => {
    const record = readRecord(item);
    const rawStatus = typeof record?.status === 'string' ? record.status : '';
    const status = rawStatus === 'completed' || rawStatus === 'in_progress' || rawStatus === 'pending'
      ? rawStatus
      : 'pending';
    const content = typeof record?.content === 'string'
      ? record.content
      : String(record?.content ?? '');
    const activeForm = typeof record?.activeForm === 'string' ? record.activeForm : undefined;
    return { content, status, activeForm };
  });
}
