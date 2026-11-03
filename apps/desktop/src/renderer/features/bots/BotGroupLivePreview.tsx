import { BotGroupProcessEntries } from './BotGroupProcess';
import type { BotGroupProcessMessage } from '../../../shared/botGroupChat';
import { useRemoteSessionSync } from '@/features/cc-agent/hooks/useRemoteSessionSync';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
/** Latest public progress in the current turn, including the note before a tool call.
 * Remote work uses the authenticated activity summary and opens the original task. */
import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react';

import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';
import { cn } from '@/lib/utils';
import { isBotGroupNoReplyPrefix } from '../../../shared/botGroupChat';

/** The last `lines` non-empty lines of the streaming reply, or ''. */
export function botGroupLiveTail(text: string, lines: number): string {
  if (isBotGroupNoReplyPrefix(text)) return '';
  return text.split('\n').map((line) => line.trim()).filter(Boolean).slice(-lines).join('\n');
}

/** Keep the latest progress note visible while tools run; never revive an older turn,
 * private reply or reasoning block when streamingText is cleared between messages. */
export function botGroupWorkPreview(state: {
  streamingText: string;
  messages: readonly ChatMessage[];
  agentStatus: { startedAt: number | null };
}, lines: number): string {
  if (state.streamingText.trim()) return botGroupLiveTail(state.streamingText, lines);
  const since = state.agentStatus.startedAt;
  if (since === null) return '';
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const message = state.messages[i]!;
    const createdAt = message.createdAt ? Date.parse(message.createdAt) : NaN;
    if (message.role !== 'assistant' || message.assistantPhase !== 'commentary'
      || message.botPrivateReply || message.failedSamplingAttempt || !Number.isFinite(createdAt) || createdAt < since) continue;
    return botGroupLiveTail(message.content, lines);
  }
  return '';
}

export function BotGroupLivePreview({ sessionId, lines = 2, className }: { sessionId: string; lines?: number; className?: string }) {
  const subscribe = useCallback((listener: () => void) => makerChatStore.subscribe(sessionId, listener), [sessionId]);
  // A string snapshot: unrelated store updates of this Session do not re-render.
  const read = useCallback(() => botGroupWorkPreview(makerChatStore.getSnapshot(sessionId), lines), [sessionId, lines]);
  const tail = useSyncExternalStore(subscribe, read, read);
  if (!tail) return null;
  return (
    <div data-testid="bot-group-live-preview" className={cn('flex min-w-0 flex-col text-13 leading-5 text-[var(--text-secondary)]', className)}>
      {tail.split('\n').map((line, index) => (
        <span key={index} className="min-w-0 truncate">{line}</span>
      ))}
    </div>
  );
}

/** All public stage notes from this execution, kept in original order between tool calls. */
export function BotGroupProcessNotes({ sessionId, since }: { sessionId: string; since: number }) {
  const subscribe = useCallback((listener: () => void) => makerChatStore.subscribe(sessionId, listener), [sessionId]);
  const read = useCallback(() => JSON.stringify(makerChatStore.getSnapshot(sessionId).messages
    .filter(message => !message.botPrivateReply && !message.failedSamplingAttempt
      && !!message.createdAt && Date.parse(message.createdAt) >= since)
    .map(message => ({ clientId: message.clientId, role: message.role, createdAt: message.createdAt, toolUseId: message.toolUseId,
      content: message.role === 'tool_use' ? { toolName: message.toolName, input: message.toolInput } : message.role === 'thinking' ? '' : message.content,
      agentMeta: { assistantPhase: message.assistantPhase, turnCompleted: message.turnCompleted } }))), [sessionId, since]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  const messages = JSON.parse(snapshot) as BotGroupProcessMessage[];
  return <BotGroupProcessEntries messages={messages} id={`group-live:${sessionId}`} running />;
}

export function BotGroupRemoteProcessNotes({ sessionId, deviceId, since }: { sessionId: string; deviceId: string; since: number }) {
  useLayoutEffect(() => { remoteProjectsStore.pinSessionOrigin(deviceId, sessionId); }, [deviceId, sessionId]);
  useRemoteSessionSync(sessionId, deviceId);
  return <BotGroupProcessNotes sessionId={sessionId} since={since} />;
}
