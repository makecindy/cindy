/** Host-owned native hook bridge. An empty answer defers to Agent permissions. */
export interface ToolLifecycleEvent {
  engine: 'claude-code' | 'codex' | 'pi';
  phase: 'call' | 'result';
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}

export interface ToolLifecycleVerdict {
  decision?: 'deny' | 'ask';
  reason?: string;
  input?: Record<string, unknown>;
  result?: unknown;
  additionalContext?: string;
}

export interface ToolLifecycleControl {
  enabled(sessionId: string): boolean;
  run(sessionId: string, event: ToolLifecycleEvent, signal?: AbortSignal): Promise<ToolLifecycleVerdict>;
}

/** Reject unsupported transformations instead of silently claiming they applied. */
export function assertToolLifecycleVerdict(event: ToolLifecycleEvent, verdict: ToolLifecycleVerdict): void {
  if (event.phase === 'call' && 'result' in verdict || event.phase === 'result' && ('input' in verdict || verdict.decision === 'ask')) {
    throw new Error('Tool hook action is unavailable in this phase');
  }
  if (event.engine === 'codex' && (verdict.decision === 'ask' || 'result' in verdict)) {
    throw new Error('Codex native hooks do not support ask or result replacement');
  }
  if (event.engine === 'pi' && (verdict.decision === 'ask' || verdict.additionalContext !== undefined)) {
    throw new Error('Pi tool hooks do not support ask or additionalContext');
  }
  if (event.engine === 'claude-code' && event.isError && 'result' in verdict) throw new Error('Claude PostToolUseFailure cannot replace a result');
  if (event.engine === 'pi' && 'result' in verdict) {
    const result = verdict.result as Record<string, unknown> | null;
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || result.content !== undefined && !Array.isArray(result.content)
      || result.isError !== undefined && typeof result.isError !== 'boolean') throw new Error('Invalid Pi tool_result replacement');
  }
}
