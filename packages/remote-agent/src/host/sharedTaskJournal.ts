import type {SharedTaskIdentity,SharedTaskSnapshot} from '@cindy/device-link';
export interface SharedTaskJournalEntry {
  sharedTaskId: string;
  sessionId: string;
  terminal: boolean;
  snapshot: SharedTaskSnapshot | null;
}

export interface SharedTaskJournal {
 recordAuthority(value:SharedTaskSnapshot):Promise<boolean>;
 close(identity:SharedTaskIdentity):Promise<void>;
 latest():Promise<SharedTaskJournalEntry[]>;
}
