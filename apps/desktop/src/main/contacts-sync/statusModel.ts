import type { PersistedContactsSyncStatus } from './statusStore.js';

export type ContactsDeviceSyncPhase = 'off' | 'waiting' | 'syncing' | 'up-to-date' | 'error';

export type ContactsDeviceSyncErrorCode =
  'secure-storage-unavailable' | 'peer-identity-changed' | 'sync-failed';

export interface ContactsDeviceSyncStatus extends PersistedContactsSyncStatus {
  /** Device Link is account-scoped; local/signed-out sessions cannot participate. */
  available: boolean;
  enabled: boolean;
  phase: ContactsDeviceSyncPhase;
  onlineDeviceCount: number;
  errorCode: ContactsDeviceSyncErrorCode | null;
}

export function emptyContactsDeviceSyncStatus(): ContactsDeviceSyncStatus {
  return {
    available: false,
    enabled: false,
    phase: 'off',
    onlineDeviceCount: 0,
    errorCode: null,
    lastSyncAt: null,
    lastSyncDeviceId: null,
    lastSyncDeviceName: null,
    lastRoute: null,
  };
}

export function contactsDeviceSyncErrorCode(error: unknown): ContactsDeviceSyncErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (/secure storage/i.test(message)) return 'secure-storage-unavailable';
  if (/peer identity changed/i.test(message)) return 'peer-identity-changed';
  return 'sync-failed';
}
