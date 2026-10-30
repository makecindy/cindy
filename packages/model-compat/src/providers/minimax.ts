import { isPlainObject } from '../object';

/** Cindy's existing MiniMax Responses contract; selected only by the host's actual route. */
export function normalizeMiniMaxResponsesReasoning(body: Record<string, unknown>): Record<string, unknown> | null {
  const reasoning = body.reasoning;
  if (!isPlainObject(reasoning)) return null;
  const next = { ...reasoning };
  if (next.effort === 'xhigh') next.effort = 'high';
  delete next.summary;
  return next.effort !== reasoning.effort || 'summary' in reasoning ? { ...body, reasoning: next } : null;
}
