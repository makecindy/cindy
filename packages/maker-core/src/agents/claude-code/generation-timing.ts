const CLAUDE_GENERATION_HEARTBEAT_MS = 5_000;
const CLAUDE_GENERATION_SUSPEND_GAP_MS = 30_000;

export interface ClaudeGenerationState {
  startedAt: number | null;
  durationMs: number;
  pendingToolIds: Set<string>;
  /**
   * Pause ids that already resumed this generation. A later pause of the same
   * id must not close the current open interval or re-enter pending — the
   * matching tool_result will not arrive again.
   */
  settledPauseIds: Set<string>;
  reliable: boolean;
  /**
   * True after this turn observed a child assistant/stream (`parent_tool_use_id`).
   * Live tok/s then uses parent-only streamed output instead of the result
   * aggregate, which still includes subagent tokens.
   */
  sawSubagent: boolean;
  /**
   * True after a parent assistant closed without streamed output usage.
   * Subagent live tok/s cannot use that incomplete parent numerator.
   */
  parentStreamedOutputIncomplete: boolean;
  heartbeatAt: number | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

export function newClaudeGenerationState(): ClaudeGenerationState {
  return {
    startedAt: null,
    durationMs: 0,
    pendingToolIds: new Set(),
    settledPauseIds: new Set(),
    reliable: true,
    sawSubagent: false,
    parentStreamedOutputIncomplete: false,
    heartbeatAt: null,
    heartbeatTimer: null,
  };
}

function stopHeartbeat(state: ClaudeGenerationState): void {
  if (state.heartbeatTimer !== null) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
  state.heartbeatAt = null;
}

function sampleHeartbeat(state: ClaudeGenerationState, now = Date.now()): void {
  const previous = state.heartbeatAt;
  if (
    previous !== null &&
    now - previous > CLAUDE_GENERATION_HEARTBEAT_MS + CLAUDE_GENERATION_SUSPEND_GAP_MS
  ) {
    state.reliable = false;
  }
  state.heartbeatAt = now;
}

function startHeartbeat(state: ClaudeGenerationState): void {
  stopHeartbeat(state);
  state.heartbeatAt = Date.now();
  const timer = setInterval(() => sampleHeartbeat(state), CLAUDE_GENERATION_HEARTBEAT_MS);
  timer.unref?.();
  state.heartbeatTimer = timer;
}

function closeInterval(state: ClaudeGenerationState, endedAt: number): void {
  const startedAt = state.startedAt;
  state.startedAt = null;
  sampleHeartbeat(state);
  stopHeartbeat(state);
  if (startedAt === null) return;
  if (endedAt < startedAt) {
    state.reliable = false;
    return;
  }
  state.durationMs += endedAt - startedAt;
}

export function resetClaudeGenerationTiming(state: ClaudeGenerationState): void {
  stopHeartbeat(state);
  state.startedAt = null;
  state.pendingToolIds.clear();
  state.settledPauseIds.clear();
  state.durationMs = 0;
  state.reliable = true;
  state.sawSubagent = false;
  state.parentStreamedOutputIncomplete = false;
}

export function beginClaudeGeneration(state: ClaudeGenerationState, startedAt = Date.now()): void {
  if (state.startedAt === null && state.pendingToolIds.size === 0) {
    state.startedAt = startedAt;
    startHeartbeat(state);
  }
}

/**
 * A new parent request can only be dispatched after every tool_result of the
 * previous message reached the provider, so ids still pending here belong to
 * tools whose results the SDK resolved without echoing (e.g. ToolSearch).
 * Settle them instead of letting one phantom id freeze the clock for the rest
 * of the turn while output keeps accruing (runaway live tok/s).
 */
export function beginClaudeGenerationAtRequestStart(
  state: ClaudeGenerationState,
  startedAt = Date.now(),
): void {
  for (const pauseId of state.pendingToolIds) state.settledPauseIds.add(pauseId);
  state.pendingToolIds.clear();
  beginClaudeGeneration(state, startedAt);
}

export function pauseClaudeGeneration(
  state: ClaudeGenerationState,
  pauseId: string,
  pausedAt = Date.now(),
): void {
  if (!pauseId) {
    state.reliable = false;
    return;
  }
  if (state.pendingToolIds.has(pauseId)) return;
  if (state.settledPauseIds.has(pauseId)) return;
  if (state.pendingToolIds.size === 0) {
    // No open generation interval means we never saw message_start (or it was
    // already closed). Pausing here would resume the clock at tool_result and
    // still count earlier output tokens, so tok/s would be inflated.
    if (state.startedAt === null) state.reliable = false;
    else closeInterval(state, pausedAt);
  }
  state.pendingToolIds.add(pauseId);
}

export function resumeClaudeGeneration(
  state: ClaudeGenerationState,
  pauseId: string,
  resumedAt = Date.now(),
): void {
  // A late echo for an already-settled id (internally resolved at the next
  // request boundary, or a duplicate result) is a no-op, not an imbalance.
  if (state.settledPauseIds.has(pauseId)) return;
  if (!state.pendingToolIds.delete(pauseId)) {
    state.reliable = false;
    return;
  }
  state.settledPauseIds.add(pauseId);
  if (state.pendingToolIds.size === 0) {
    state.startedAt = resumedAt;
    startHeartbeat(state);
  }
}

export function finalizeClaudeGeneration(
  state: ClaudeGenerationState,
  completedAt = Date.now(),
): void {
  if (state.pendingToolIds.size > 0) {
    state.reliable = false;
    state.startedAt = null;
    stopHeartbeat(state);
    return;
  }
  closeInterval(state, completedAt);
}

export function markClaudeGenerationUnreliable(state: ClaudeGenerationState): void {
  state.reliable = false;
}

export function noteClaudeSubagent(state: ClaudeGenerationState): void {
  state.sawSubagent = true;
}

export function noteClaudeParentStreamedOutputIncomplete(state: ClaudeGenerationState): void {
  state.parentStreamedOutputIncomplete = true;
}
