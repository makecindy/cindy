/**
 * Codex subagent transcript accumulator.
 *
 * Sits alongside `SubagentLiveCardTracker` — while that module aggregates live card
 * state (tokens, tools, status), this one accumulates the full transcript content
 * from descendant thread notifications for later persistence to disk.
 *
 * The desktop host writes `{userData}/subagent-transcripts/{runId}.json` on termination;
 * this module is pure accumulation with no IO.
 *
 * Bounds:
 *  - Max 500 entries per task (oldest dropped on overflow).
 *  - Max 64 KB per entry content (truncated with ellipsis on overflow).
 */

import type { SubagentTranscriptEntry, SubagentTranscriptRole } from '@cindy/maker-shared/subagent-workspace';

/** Maximum entries retained per task before oldest are dropped. */
const MAX_ENTRIES_PER_TASK = 500;
/** Maximum bytes for a single entry's content field (64 KB). */
const MAX_CONTENT_BYTES = 64 * 1024;
/** Maximum tracked tasks to prevent unbounded growth. */
const MAX_TRACKED_TASKS = 64;

interface PendingEntry {
  id: string;
  role: SubagentTranscriptRole;
  content: string;
  startedAt: number;
  toolName?: string;
}

interface TaskState {
  entries: SubagentTranscriptEntry[];
  /** Monotonic sequence counter for this task. */
  nextSequence: number;
  /** The in-progress agent_message entry being streamed via deltas. */
  pendingMessage: PendingEntry | null;
}

function clampContent(content: string): string {
  if (content.length <= MAX_CONTENT_BYTES) return content;
  return content.slice(0, MAX_CONTENT_BYTES - 1) + '…';
}

function pushEntry(state: TaskState, entry: SubagentTranscriptEntry): void {
  if (state.entries.length >= MAX_ENTRIES_PER_TASK) {
    state.entries.shift();
  }
  state.entries.push(entry);
}

export class SubagentTranscriptAccumulator {
  private readonly tasks = new Map<string, TaskState>();
  private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now());
  }

  /**
   * Called from the descendant notification handler for each notification on a
   * tracked child thread. The caller is responsible for mapping childThreadId to
   * taskId before calling this method.
   */
  noteNotification(taskId: string, method: string, params: unknown): void {
    if (!taskId || !method) return;

    switch (method) {
      case 'item/started':
        this.handleItemStarted(taskId, params);
        break;
      case 'item/agentMessage/delta':
        this.handleAgentMessageDelta(taskId, params);
        break;
      case 'item/completed':
        this.handleItemCompleted(taskId, params);
        break;
      case 'turn/completed':
        this.handleTurnCompleted(taskId);
        break;
    }
  }

  /** Get accumulated entries (read-only snapshot). */
  getEntries(taskId: string): SubagentTranscriptEntry[] {
    const state = this.tasks.get(taskId);
    if (!state) return [];
    // Flush any pending message before returning.
    return [...state.entries];
  }

  /**
   * Get entries for file write, then clear the task's buffer.
   * Returns null if no entries exist for this task.
   */
  serialize(taskId: string): SubagentTranscriptEntry[] | null {
    const state = this.tasks.get(taskId);
    if (!state) return null;
    // Finalize any pending message before serialization.
    this.finalizePending(state);
    if (state.entries.length === 0) return null;
    const result = state.entries.slice();
    this.tasks.delete(taskId);
    return result;
  }

  /** Cleanup one or all tracked tasks. */
  clear(taskId?: string): void {
    if (taskId !== undefined) {
      this.tasks.delete(taskId);
    } else {
      this.tasks.clear();
    }
  }

  /** Number of currently tracked tasks (diagnostic). */
  get size(): number {
    return this.tasks.size;
  }

  // -- Private implementation --

  private getOrCreateState(taskId: string): TaskState {
    let state = this.tasks.get(taskId);
    if (!state) {
      // Evict oldest task if at capacity.
      if (this.tasks.size >= MAX_TRACKED_TASKS) {
        const oldest = this.tasks.keys().next();
        if (!oldest.done) this.tasks.delete(oldest.value);
      }
      state = { entries: [], nextSequence: 0, pendingMessage: null };
      this.tasks.set(taskId, state);
    }
    return state;
  }

  private handleItemStarted(taskId: string, params: unknown): void {
    const record = params as { item?: { type?: string; id?: string } } | null;
    const item = record?.item;
    if (!item || typeof item !== 'object') return;

    const itemType = typeof item.type === 'string' ? item.type : '';
    const itemId = typeof item.id === 'string' ? item.id : '';

    if (itemType === 'agentMessage') {
      const state = this.getOrCreateState(taskId);
      // Finalize any previous pending message before starting a new one.
      this.finalizePending(state);
      state.pendingMessage = {
        id: itemId || `msg-${state.nextSequence}`,
        role: 'subagent',
        content: '',
        startedAt: this.now(),
      };
    }
  }

  private handleAgentMessageDelta(taskId: string, params: unknown): void {
    const state = this.tasks.get(taskId);
    if (!state?.pendingMessage) return;

    const record = params as { delta?: string } | null;
    const delta = typeof record?.delta === 'string' ? record.delta : '';
    if (!delta) return;

    // Enforce content size bound during accumulation.
    if (state.pendingMessage.content.length < MAX_CONTENT_BYTES) {
      const remaining = MAX_CONTENT_BYTES - state.pendingMessage.content.length;
      state.pendingMessage.content += delta.length <= remaining
        ? delta
        : delta.slice(0, remaining);
    }
  }

  private handleItemCompleted(taskId: string, params: unknown): void {
    const record = params as {
      item?: { type?: string; id?: string; name?: string; input?: unknown };
    } | null;
    const item = record?.item;
    if (!item || typeof item !== 'object') return;

    const itemType = typeof item.type === 'string' ? item.type : '';
    const itemId = typeof item.id === 'string' ? item.id : '';

    if (itemType === 'agentMessage') {
      // Finalize the pending agent message.
      const state = this.tasks.get(taskId);
      if (state?.pendingMessage) {
        this.finalizePending(state);
      }
      return;
    }

    // Tool-type items: record as a tool entry.
    if (this.isToolItem(itemType)) {
      const state = this.getOrCreateState(taskId);
      const toolName = typeof item.name === 'string' ? item.name : itemType;
      const inputSummary = this.summarizeToolInput(item.input);
      const content = inputSummary
        ? `${toolName}: ${inputSummary}`
        : toolName;

      const entry: SubagentTranscriptEntry = {
        id: itemId || `tool-${state.nextSequence}`,
        sequence: state.nextSequence++,
        role: 'tool',
        content: clampContent(content),
        occurredAt: this.now(),
        toolName,
      };
      pushEntry(state, entry);
    }
  }

  private handleTurnCompleted(taskId: string): void {
    const state = this.tasks.get(taskId);
    if (!state) return;
    this.finalizePending(state);
  }

  private finalizePending(state: TaskState): void {
    const pending = state.pendingMessage;
    if (!pending) return;
    state.pendingMessage = null;

    // Skip empty messages (no content accumulated).
    if (!pending.content.trim()) return;

    const entry: SubagentTranscriptEntry = {
      id: pending.id,
      sequence: state.nextSequence++,
      role: pending.role,
      content: clampContent(pending.content),
      occurredAt: pending.startedAt,
      ...(pending.toolName ? { toolName: pending.toolName } : {}),
    };
    pushEntry(state, entry);
  }

  private isToolItem(itemType: string): boolean {
    return itemType === 'commandExecution'
      || itemType === 'mcpToolCall'
      || itemType === 'dynamicToolCall'
      || itemType === 'webSearch'
      || itemType === 'fileChange'
      || itemType === 'imageView'
      || itemType === 'imageGeneration'
      || itemType === 'collabAgentToolCall'
      || itemType === 'sleep';
  }

  private summarizeToolInput(input: unknown): string {
    if (input === null || input === undefined) return '';
    if (typeof input === 'string') {
      return input.length > 200 ? input.slice(0, 200) + '…' : input;
    }
    if (typeof input === 'object') {
      try {
        const json = JSON.stringify(input);
        return json.length > 200 ? json.slice(0, 200) + '…' : json;
      } catch {
        return '';
      }
    }
    return String(input);
  }
}
