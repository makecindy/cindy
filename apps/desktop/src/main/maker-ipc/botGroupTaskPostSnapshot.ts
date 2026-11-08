import type { ChatContentBlock } from './chatServerMigration.js';

/** The wire payload of a teammate's task message to its group, frozen before its first POST. */
export interface BotGroupTaskPostSnapshot {
  actorId: string;
  /** `threadRootId` puts every part in the Thread the task was started from. */
  messages: Array<{ operationId: string; content: ChatContentBlock[]; mentions: string[]; threadRootId?: string }>;
}
