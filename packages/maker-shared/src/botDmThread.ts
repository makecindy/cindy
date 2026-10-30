/** One private-chat topic as the chat timeline shows it under its root message. */
export interface BotDmThreadSummary {
  /** The topic's hidden Session. */
  sessionId: string;
  rootSessionId: string;
  rootClientId: string;
  /** Visible user and companion messages in the topic. */
  replyCount: number;
  /** Latest visible message in the topic (ms), or null while it has none. */
  lastReplyAt: number | null;
  /** Latest companion reply in the topic (ms); the timeline compares it with the read position. */
  lastAssistantAt: number | null;
  createdAt: number;
}
