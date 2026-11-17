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
  /** Capture the selection for this engine instance; undefined installs no hooks. */
  bind?(sessionId: string): ToolLifecycleControl | undefined;
  enabled(sessionId: string): boolean;
  run(sessionId: string, event: ToolLifecycleEvent, signal?: AbortSignal): Promise<ToolLifecycleVerdict>;
}

/** Stop before serializing oversized native results; traversal is depth/size bounded. */
export function assertToolLifecycleBudget(value: unknown, limit = 1_048_576): void {
  let remaining = limit;
  const visit = (item: unknown, depth: number): void => {
    if (remaining < 0 || depth > 64) throw new Error('Tool hook exceeds the transport budget');
    if (typeof item === 'string') {
      remaining -= item.length + 2;
      if (remaining < 0) throw new Error('Tool hook exceeds the transport budget');
      for (let i = 0; i < item.length; i++) {
        const code = item.charCodeAt(i);
        remaining -= code < 32 ? 5 : code === 34 || code === 92 ? 1 : 0;
      }
    } else if (item && typeof item === 'object') {
      remaining -= 2;
      for (const key in item) if (Object.prototype.hasOwnProperty.call(item, key)) {
        remaining -= 2;
        if (!Array.isArray(item)) visit(key, depth + 1);
        visit((item as Record<string, unknown>)[key], depth + 1);
      }
    } else remaining -= 32;
    if (remaining < 0) throw new Error('Tool hook exceeds the transport budget');
  };
  visit(value, 0);
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
