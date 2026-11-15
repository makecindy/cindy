import type { BotGroupSendInput } from './botGroupChat';

/** Local main/renderer contract; never exposed through device-link. */
export interface BotGroupOutboxOwner { dataOwnerId: string | null; generation: number }
export interface BotGroupOutboxEditSource { groupId: string; clientId: string; revision: number }
export interface BotGroupOutboxStoredEntry {
  input: { groupId: string; clientId: string; text: string; [key: string]: unknown };
  createdAt: number;
  status: 'sending' | 'sent' | 'failed';
  /** Main-issued local execution generation, independent of the network clientId. */
  entryRevision?: number;
  queueOrdinal?: number;
  coordinated?: boolean;
  enqueueOperationId?: string;
  businessSignature?: string;
  editHold?: { operationId: string; revision: number };
  /** Retained until the source tombstone and reference release have completed. */
  editSource?: BotGroupOutboxEditSource;
  /** Immutable operation identity, retained even after editSource cleanup. */
  enqueueSource?: BotGroupOutboxEditSource;
  [key: string]: unknown;
}
export type BotGroupOutboxStorageRequest = {
  owner: BotGroupOutboxOwner;
} & ({ action: 'list' } | { action: 'put'; entry: BotGroupOutboxStoredEntry }
  | { action: 'remove'; groupId: string; clientId: string });

export interface BotGroupOutboxExecution {
  owner: BotGroupOutboxOwner;
  instanceId: string;
  groupId: string;
  clientId: string;
  entryRevision: number;
  claimToken: string;
}
export interface BotGroupOutboxChanged {
  owner: BotGroupOutboxOwner;
  instanceId: string;
  revision: number;
}
export type BotGroupOutboxCommandRequest = { owner: BotGroupOutboxOwner } & (
  | { action: 'snapshot'; known?: { instanceId: string; revision: number } }
  | { action: 'enqueue'; entry: BotGroupOutboxStoredEntry; enqueueOperationId: string; editSource?: BotGroupOutboxEditSource }
  | { action: 'claim'; groupId: string; clientId: string; entryRevision?: number }
  | { action: 'prepared'; execution: BotGroupOutboxExecution; prepared: readonly unknown[]; attachments: readonly unknown[] }
  | { action: 'fail'; execution: BotGroupOutboxExecution; errorKey: string; retryable: boolean }
  | { action: 'retry'; groupId: string; clientId: string; entryRevision: number }
  | { action: 'edit'; groupId: string; clientId: string; entryRevision: number; operationId: string }
  | { action: 'remove'; groupId: string; clientId: string; entryRevision: number }
  | { action: 'release' }
);
export interface BotGroupOutboxCommandResult extends BotGroupOutboxChanged {
  ok: true;
  /** Snapshot reads never claim. All entries are committed Main facts. */
  entries: BotGroupOutboxStoredEntry[];
  entry?: BotGroupOutboxStoredEntry;
  execution?: BotGroupOutboxExecution;
  accepted?: true;
  unchanged?: boolean;
  removed?: Array<{ groupId: string; clientId: string }>;
}

/** Main reconstructs this from its saved original input and prepared attachments. */
export type BotGroupOutboxServiceInput = BotGroupSendInput;
