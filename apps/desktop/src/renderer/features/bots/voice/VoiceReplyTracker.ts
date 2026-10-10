import type { ChatMessage } from '@/lib/makerChatStore';

/** Only the completed, top-level answer to a voice input belongs to this call. */
export class VoiceReplyTracker {
  private waitingFor: string | null = null;
  private consumed = new Set<string>();

  expect(clientId: string): void {
    this.waitingFor = clientId;
  }
  interrupt(): void {
    this.waitingFor = null;
  }
  get hasPendingReply(): boolean {
    return this.waitingFor !== null;
  }

  take(messages: readonly ChatMessage[]): { id: string; text: string } | null {
    if (!this.waitingFor) return null;
    const index = messages.findIndex((message) => message.clientId === this.waitingFor);
    if (index < 0) return null; // A queued input has not entered the task yet.
    if (messages[index].blockedByGhost) {
      this.interrupt();
      return null;
    }
    for (const message of messages.slice(index + 1)) {
      // An input from another surface/automation owns the subsequent answer.
      if (message.role === 'user') {
        this.interrupt();
        return null;
      }
      if (
        message.role !== 'assistant' ||
        message.parentToolUseId ||
        message.explicitDelivery ||
        message.sourceGroup ||
        message.botPrivateReply ||
        message.assistantPhase === 'commentary' ||
        message.isStreaming ||
        message.ghostReplyPending ||
        message.turnCompleted !== true
      )
        continue;
      if (this.consumed.has(message.clientId)) continue;
      const text = speechText(message.content);
      this.consumed.add(message.clientId);
      this.interrupt();
      return { id: message.clientId, text };
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
    if (/^[\uDC00-\uDFFF]/.test(text.slice(end))) end--;
    chunks.push(text.slice(0, end).trim());
    text = text.slice(end).trim();
  }
  if (text) chunks.push(text);
  return chunks;
}
