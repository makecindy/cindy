/** Narrow, version-pinned subset of the TrueForge 0.1.x event contract. */

export interface TrueForgeToolCall {
  id: string;
  function?: { name?: string; arguments?: string };
  toolInfo?: { name?: string; type?: string };
}

export interface TrueForgeEvent {
  type: string;
  id?: string;
  threadId?: string | null;
  turnId?: string;
  content?: string | null;
  toolCallId?: string;
  toolCalls?: TrueForgeToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  sourceEventId?: string;
  state?: {
    status?: 'running' | 'done' | 'cancelled' | 'error';
    reason?: string;
    message?: string;
    output?: unknown;
    requiredActions?: TrueForgeEvent[];
    metrics?: {
      totalInputTokens?: number;
      totalOutputTokens?: number;
      totalTokens?: number;
      totalCacheReadTokens?: number;
      totalCacheWriteTokens?: number;
      totalCostInUsd?: number;
    };
  };
  mcpServers?: Array<{ name?: string; authUrl?: string }>;
}

export function asTrueForgeEvent(value: unknown): TrueForgeEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as TrueForgeEvent;
  return typeof event.type === 'string' ? event : null;
}

export function parseToolArguments(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { raw: value };
  }
}

export function toolNameOf(call: TrueForgeToolCall): string {
  return call.toolInfo?.name?.trim() || call.function?.name?.trim() || 'tool';
}
