import type { DataOwnerPushStamp } from './dataOwnerPush';

export interface PassportDictation {
  token: string;
  sessionId: string;
  text: string;
  ownerStamp: DataOwnerPushStamp;
}
export interface PassportState {
  enabled: boolean;
  supported: boolean;
  connected: boolean;
  devices: string[];
  bluetooth: number;
  voice: 'idle' | 'recording' | 'transcribing' | 'draft' | 'sending' | 'error';
}
export interface PassportApi {
  getState(): Promise<PassportState>;
  setEnabled(enabled: boolean | null): Promise<void>;
  connect(id: string): Promise<void>;
  disconnect(): Promise<void>;
  /** Atomically claims hardware-confirmed text for delivery; not a read-only query. */
  getDictation(sessionId: string): Promise<PassportDictation | null>;
  acknowledgeDictation(token: string, sent: boolean): Promise<void>;
}
