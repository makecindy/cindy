const CLAUDE_GENERATION_HEARTBEAT_MS = 5_000;
const CLAUDE_GENERATION_SUSPEND_GAP_MS = 30_000;

export interface ClaudeGenerationState {
  startedAt: number | null;
  durationMs: number;
  pendingToolIds: Set<string>;
  reliable: boolean;
  heartbeatAt: number | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

export function newClaudeGenerationState(): ClaudeGenerationState {
  return {
    startedAt: null,
    durationMs: 0,
    pendingToolIds: new Set(),
    reliable: true,
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
  state.durationMs = 0;
  state.reliable = true;
}

export function beginClaudeGeneration(state: ClaudeGenerationState, startedAt = Date.now()): void {
  if (state.startedAt === null && state.pendingToolIds.size === 0) {
    state.startedAt = startedAt;
    startHeartbeat(state);
  }
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
  if (!state.pendingToolIds.delete(pauseId)) {
    state.reliable = false;
    return;
  }
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
