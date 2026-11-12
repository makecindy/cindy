import type { ChatMessage, SessionChatState } from '@/lib/makerChatStore';
import { completeSpeechPrefix, streamingSpeechText } from './SpeechTextBuffer';

export type VoiceReply = { id: string; text: string; complete: boolean; invalidated?: true };
export type VoiceTaskFailure = { clientId: string; reason: 'error' | 'cancelled' };

/** Use the host's terminal state; idle alone can mean queued or retrying. */
export function voiceTaskFailure(state: Pick<SessionChatState,
  'messages' | 'agentStatus' | 'isStreaming' | 'error' | 'inputRecovery'
  | 'usageLimitWait' | 'turnStoppedByUser' | 'lastStopWasSideTask'
>): VoiceTaskFailure | null {
  if (state.agentStatus.isRunning || state.isStreaming || state.usageLimitWait
    || state.lastStopWasSideTask) return null;
  // Failed input ownership comes from the canonical recovery projection, not
  // the latest bubble (which may belong to a different queued input).
  if (state.error && state.inputRecovery?.kind === 'active-turn')
    return { clientId: state.inputRecovery.item.clientId, reason: 'error' };
  if (state.turnStoppedByUser) {
    const input = state.messages.findLast((message) => message.role === 'user');
    if (input) return { clientId: input.clientId, reason: 'cancelled' };
  }
  return null;
}

/** Correlate one voice input with its final answer, emitting each stable prefix once. */
export class VoiceReplyTracker {
  private waitingFor: string | null = null;
  private replyId: string | null = null;
  private emitted = '';
  private deferred = false;

  expect(clientId: string): void {
    this.waitingFor = clientId;
    this.replyId = null;
    this.emitted = '';
    this.deferred = false;
  }
  interrupt(): void {
    this.waitingFor = null;
  }
  get hasPendingReply(): boolean {
    return this.waitingFor !== null;
  }

  /** Main can defer a reply before any audio starts, e.g. for an outgoing hook. */
  deferUntilComplete(): void {
    this.replyId = null;
    this.emitted = '';
    this.deferred = true;
  }

  take(messages: readonly ChatMessage[], sentencePlayback = false): VoiceReply | null {
    if (!this.waitingFor) return null;
    const index = messages.findIndex((message) => message.clientId === this.waitingFor);
    if (index < 0) return null; // A queued input has not entered the task yet.
    if (messages[index].blockedByGhost) {
      this.interrupt();
      return null;
    }
    const following = messages.slice(index + 1);
    // Supersession applies even when the previous answer precedes the new input.
    if (following.some((message) => message.role === 'user')) {
      this.interrupt();
      return null;
    }
    for (const message of following) {
      if (
        message.role !== 'assistant' ||
        message.parentToolUseId ||
        message.explicitDelivery ||
        message.sourceGroup ||
        message.botPrivateReply ||
        message.assistantPhase === 'commentary' ||
        message.ghostReplyPending
      )
        continue;
      const complete = !message.isStreaming && message.turnCompleted === true;
      if (
        !complete &&
        (!sentencePlayback || this.deferred || message.assistantPhase !== 'final_answer')
      )
        continue;
      const text = sentencePlayback
        ? streamingSpeechText(message.content, complete)
        : speechText(message.content);
      // Full-text reconciliation can replace a streamed prefix. Already spoken
      // words cannot be undone; cancel this reply instead of reading it twice.
      if ((this.replyId && this.replyId !== message.clientId) || !text.startsWith(this.emitted)) {
        this.interrupt();
        return { id: message.clientId, text: '', complete: true, invalidated: true };
      }
      const remaining = text.slice(this.emitted.length);
      const next = complete ? remaining : completeSpeechPrefix(remaining);
      if (!next.trim() && !complete) continue;
      this.replyId = message.clientId;
      this.emitted += next;
      if (complete) this.interrupt();
      // Closing quotes or ellipses may arrive after the spoken sentence. Consume
      // that suffix for reconciliation without paying for punctuation-only TTS.
      return {
        id: message.clientId,
        text: sentencePlayback && /^[\s\p{P}]*$/u.test(next) ? '' : next.trim(),
        complete,
      };
    }
    return null;
  }
}

/** Read prose, not code blocks, image URLs or Markdown punctuation. The visible reply is unchanged. */
export function speechText(markdown: string): string {
  return markdown
    .replace(/```[^]*?```|~~~[^]*?~~~/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, '')
    .replace(/[`*_~]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sequential requests preserve the entire final reply without exceeding the speech endpoint limit. */
export function speechChunks(text: string, limit = 3_500): string[] {
  const chunks: string[] = [];
  while (text.length > limit) {
    const prefix = text.slice(0, limit);
    const boundary = Math.max(
      prefix.lastIndexOf('。'),
      prefix.lastIndexOf('. '),
      prefix.lastIndexOf('！'),
      prefix.lastIndexOf('？'),
      prefix.lastIndexOf('\n'),
    );
    let end = boundary > limit / 2 ? boundary + 1 : limit;
    if (end === limit && prefix.lastIndexOf(' ') > limit / 2) end = prefix.lastIndexOf(' ');
    if (/^[\uDC00-\uDFFF]/.test(text.slice(end))) end--;
    chunks.push(text.slice(0, end).trim());
    text = text.slice(end).trim();
  }
  if (text) chunks.push(text);
  return chunks;
}
