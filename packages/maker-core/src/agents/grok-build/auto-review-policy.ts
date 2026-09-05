/**
 * Grok Build Auto-review adapter — ACP tool_call.kind → ReviewableAction.
 *
 * Mapping (ACP kind → Cindy review kind):
 *   execute            → exec
 *   edit / delete / move → file-write
 *   read / search      → read
 *   fetch              → network
 *   think              → session-state
 *   other / unknown    → other
 */

import type { ReviewableAction } from '../shared/auto-review.js';
import type { AcpToolCall, AcpToolKind } from './types.js';
import { isRecord } from './types.js';

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function firstPath(toolCall: AcpToolCall, input: Record<string, unknown>): string | undefined {
  const loc = toolCall.locations?.[0]?.path;
  if (typeof loc === 'string' && loc.length > 0) return loc;
  return (
    readString(input.path)
    ?? readString(input.file)
    ?? readString(input.file_path)
    ?? readString(input.filename)
    ?? readString(input.target)
    ?? readString(input.dest)
    ?? readString(input.destination)
  );
}

function firstCommand(input: Record<string, unknown>): string {
  return (
    readString(input.command)
    ?? readString(input.cmd)
    ?? readString(input.shell)
    ?? JSON.stringify(input)
  );
}

export function grokBuildToolToReviewableAction(toolCall: AcpToolCall): ReviewableAction {
  const input = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
  const kind: AcpToolKind | undefined = toolCall.kind;
  switch (kind) {
    case 'execute':
      return {
        kind: 'exec',
        command: firstCommand(input),
        cwd: readString(input.cwd),
        cwdUnknown: 'cwd' in input && !readString(input.cwd),
      };
    case 'edit':
    case 'delete':
    case 'move':
      return { kind: 'file-write', path: firstPath(toolCall, input) };
    case 'read':
    case 'search':
      return {
        kind: 'read',
        path: firstPath(toolCall, input),
        scope: kind === 'search' ? 'tree' : 'file',
      };
    case 'fetch':
      return {
        kind: 'network',
        target: readString(input.url) ?? readString(input.uri) ?? firstPath(toolCall, input),
        operation: readString(input.method) ?? toolCall.title,
      };
    case 'think':
      return { kind: 'session-state' };
    default:
      return {
        kind: 'other',
        description: toolCall.title ?? kind ?? 'tool',
      };
  }
}

export function pickPermissionOptionId(
  options: ReadonlyArray<{ optionId: string; kind: string }>,
  behavior: 'allow' | 'deny',
  always = false,
): string | null {
  const preferred = behavior === 'allow'
    ? (always ? ['allow_always', 'allow_once'] : ['allow_once', 'allow_always'])
    : (always ? ['reject_always', 'reject_once'] : ['reject_once', 'reject_always']);
  for (const kind of preferred) {
    const match = options.find((option) => option.kind === kind);
    if (match) return match.optionId;
  }
  return behavior === 'allow' ? options[0]?.optionId ?? null : null;
}
