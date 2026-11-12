/** Stable, renderer-safe details for a tool-loop guard terminal error. */
export type ToolLoopErrorKind = 'consecutive' | 'pingpong' | 'rotation' | 'contract';

export interface ToolLoopErrorDetails {
  kind: ToolLoopErrorKind;
  count: number;
}

/**
 * Accept only the bounded, enum-shaped details emitted by maker-core. This is
 * shared by main persistence and renderer hydration so untrusted event data
 * cannot become arbitrary UI interpolation or durable content.
 */
export function parseToolLoopErrorDetails(value: unknown): ToolLoopErrorDetails | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { kind?: unknown; count?: unknown };
  const kind = raw.kind;
  const count = raw.count;
  if (
    kind !== 'consecutive' &&
    kind !== 'pingpong' &&
    kind !== 'rotation' &&
    kind !== 'contract'
  ) {
    return undefined;
  }
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 100_000) {
    return undefined;
  }
  return { kind, count };
}
