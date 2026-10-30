/** Local main/renderer contract; never exposed through device-link. */
export interface BotGroupOutboxStoredEntry {
  input: { groupId: string; clientId: string; text: string };
  createdAt: number;
  status: 'sending' | 'sent' | 'failed';
  [key: string]: unknown;
}
export type BotGroupOutboxStorageRequest = {
  owner: { dataOwnerId: string | null; generation: number };
} & ({ action: 'list' } | { action: 'put'; entry: BotGroupOutboxStoredEntry }
  | { action: 'remove'; groupId: string; clientId: string });
