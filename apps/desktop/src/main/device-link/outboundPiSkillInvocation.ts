import { leadingSlashInvocation } from '@cindy/maker-shared/composer-palette';

const QUEUED_INPUT_CHANNELS = new Set(['maker:input:enqueue', 'maker:input:steer']);
const PI_RUNTIME_SKILL_COMMAND_RE = /^skill:[^\s/]+$/i;

type Range = { start: number; end: number; [key: string]: unknown };

interface PiSkillInvocationCandidate {
  item: Record<string, unknown>;
  originalText: string;
  runtimeText: string;
  boundary: number;
  delta: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function rebaseRanges(value: unknown, boundary: number, delta: number): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (
      !isRecord(entry)
      || typeof entry.start !== 'number'
      || typeof entry.end !== 'number'
      || !Number.isFinite(entry.start)
      || !Number.isFinite(entry.end)
    ) return entry;
    const range = entry as Range;
    return {
      ...range,
      start: range.start >= boundary ? range.start + delta : range.start,
      end: range.end >= boundary ? range.end + delta : range.end,
    };
  });
}

function rewritePersistedContent(
  persistedContent: string,
  originalText: string,
  runtimeText: string,
  boundary: number,
  delta: number,
): string | null {
  try {
    const parsed = JSON.parse(persistedContent) as unknown;
    if (!isRecord(parsed) || parsed.text !== originalText) return null;
    return JSON.stringify({
      ...parsed,
      text: runtimeText,
      ...(Object.hasOwn(parsed, 'agentReferences')
        ? { agentReferences: rebaseRanges(parsed.agentReferences, boundary, delta) }
        : {}),
      ...(Object.hasOwn(parsed, 'pastedTextRanges')
        ? { pastedTextRanges: rebaseRanges(parsed.pastedTextRanges, boundary, delta) }
        : {}),
      ...(Object.hasOwn(parsed, 'slashCommandRanges')
        ? { slashCommandRanges: rebaseRanges(parsed.slashCommandRanges, boundary, delta) }
        : {}),
    });
  } catch {
    return persistedContent === originalText ? runtimeText : null;
  }
}

function readCandidate(channel: string, args: readonly unknown[]): PiSkillInvocationCandidate | null {
  if (!QUEUED_INPUT_CHANNELS.has(channel)) return null;
  const item = args[1];
  if (!isRecord(item) || typeof item.text !== 'string') return null;
  if (!isRecord(item.createOpts) || item.createOpts.agentKind !== 'pi') return null;
  if (!isRecord(item.agentSkillInvocation)) return null;

  const name = item.agentSkillInvocation.name;
  const runtimeCommandName = item.agentSkillInvocation.runtimeCommandName;
  if (
    typeof name !== 'string'
    || !name.trim()
    || typeof runtimeCommandName !== 'string'
    || !PI_RUNTIME_SKILL_COMMAND_RE.test(runtimeCommandName)
  ) return null;

  const leading = leadingSlashInvocation(item.text);
  if (!leading || leading.name.toLowerCase() !== name.toLowerCase()) return null;

  const runtimeText = `${item.text.slice(0, leading.start)}/${runtimeCommandName}${item.text.slice(leading.end)}`;
  return {
    item,
    originalText: item.text,
    runtimeText,
    boundary: leading.end,
    delta: runtimeText.length - item.text.length,
  };
}

/** Any queued Skill receipt needs target capability negotiation before crossing the wire. */
export function outboundPiSkillInvocationRequested(
  channel: string,
  args: readonly unknown[],
): boolean {
  if (!QUEUED_INPUT_CHANNELS.has(channel)) return false;
  const item = args[1];
  return isRecord(item) && item.agentSkillInvocation !== undefined;
}

/**
 * Build the legacy text form while retaining `agentSkillInvocation`: an old
 * target ignores it, while a target upgraded after the probe still validates
 * provenance. The controller's queue/UI state remains untouched.
 */
export function rewriteOutboundPiSkillInvocationForLegacyTarget(
  channel: string,
  args: readonly unknown[],
): unknown[] | null {
  const candidate = readCandidate(channel, args);
  if (!candidate) return null;

  const { item, originalText, runtimeText, boundary, delta } = candidate;
  if (
    typeof item.persistedContent !== 'string'
    || !isRecord(item.chatMessage)
    || item.chatMessage.content !== originalText
  ) return null;

  const persistedContent = rewritePersistedContent(
    item.persistedContent,
    originalText,
    runtimeText,
    boundary,
    delta,
  );
  if (persistedContent === null) return null;

  const nextChatMessage = {
    ...item.chatMessage,
    content: runtimeText,
    ...(Object.hasOwn(item.chatMessage, 'agentReferences')
      ? { agentReferences: rebaseRanges(item.chatMessage.agentReferences, boundary, delta) }
      : {}),
    ...(Object.hasOwn(item.chatMessage, 'pastedTextRanges')
      ? { pastedTextRanges: rebaseRanges(item.chatMessage.pastedTextRanges, boundary, delta) }
      : {}),
    ...(Object.hasOwn(item.chatMessage, 'slashCommandRanges')
      ? { slashCommandRanges: rebaseRanges(item.chatMessage.slashCommandRanges, boundary, delta) }
      : {}),
  };
  const nextItem: Record<string, unknown> = {
    ...item,
    text: runtimeText,
    persistedContent,
    chatMessage: nextChatMessage,
    ...(Object.hasOwn(item, 'agentReferences')
      ? { agentReferences: rebaseRanges(item.agentReferences, boundary, delta) }
      : {}),
  };

  return [args[0], nextItem, ...args.slice(2)];
}
