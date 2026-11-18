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
  enabled(sessionId: string, phase?: ToolLifecycleEvent['phase']): boolean;
  run(sessionId: string, event: ToolLifecycleEvent, signal?: AbortSignal): Promise<ToolLifecycleVerdict>;
}

/** Stop before copying oversized native JSON; use JSON's own scalar encoding. */
export function assertToolLifecycleBudget(value: unknown, limit = 1_048_576): void {
  let remaining = limit;
  const visit = (item: unknown): void => {
    if (remaining < 0) throw new Error('Tool hook exceeds the transport budget');
    if (typeof item === 'string') {
      if (item.length > remaining) throw new Error('Tool hook exceeds the transport budget');
      remaining -= JSON.stringify(item).length;
    } else if (Array.isArray(item)) {
      remaining -= 2 + Math.max(0, item.length - 1);
      for (const child of item) visit(child ?? null);
    } else if (item && typeof item === 'object') {
      remaining -= 2;
      let first = true;
      for (const key in item) if (Object.prototype.hasOwnProperty.call(item, key)) {
        const child = (item as Record<string, unknown>)[key];
        if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
        remaining -= (first ? 0 : 1) + JSON.stringify(key).length + 1;
        first = false;
        visit(child);
      }
    } else remaining -= JSON.stringify(item)?.length ?? 4;
    if (remaining < 0) throw new Error('Tool hook exceeds the transport budget');
  };
  visit(value);
}

/** Reject unsupported transformations instead of silently claiming they applied. */
export function assertToolLifecycleVerdict(event: ToolLifecycleEvent, verdict: ToolLifecycleVerdict): void {
  if (event.phase === 'call' && 'result' in verdict || event.phase === 'result' && ('input' in verdict || verdict.decision === 'ask')) {
    throw new Error('Tool hook action is unavailable in this phase');
  }
  if (event.engine === 'claude-code' && 'input' in verdict) throw new Error('Claude plugin hooks do not rewrite tool input');
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
