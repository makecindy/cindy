/** An account-owned group projection. Reads and notification eligibility remain owned by Chat Server. */
export interface AgentIslandGroupChatInput {
  groupId: string;
  name: string;
  messageId: string;
  threadRootId?: string;
  mentioned: boolean;
  preview: string;
  lastMessageAt: number;
  members: Array<{ name: string; avatar: string; avatarColor: string }>;
}

/** A UI identity only: it must never be relayed or treated as a maker Session. */
export function groupChatIslandId(groupId: string): string {
  return `chat-group:${groupId}`;
}
