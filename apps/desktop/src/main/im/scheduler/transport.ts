import type { SchedulerDesktopDeviceSnapshot } from './deviceSnapshot';
import type { ImSchedulerFrame } from './protocol';

export type SchedulerRelayStatus = 'online' | 'offline';

export type SchedulerTransportEvent =
  | { type: 'relay-status'; status: SchedulerRelayStatus }
  | { type: 'ownership'; owner: boolean }
  /** null invalidates the previously accepted authoritative view. */
  | { type: 'snapshot'; snapshot: SchedulerDesktopDeviceSnapshot | null }
  | { type: 'peer-presence'; deviceId: string; platform: string; online: boolean }
  | { type: 'push'; sourceDeviceId: string; payload: unknown };

/**
 * Device Link adapter boundary. PR-A only defines this contract; PR-B is the
 * first PR allowed to connect it to the existing host/client implementation.
 */
export interface SchedulerTransport {
  readonly selfDeviceId: string;
  readonly platform: string;
  getStatus(): SchedulerRelayStatus;
  isOwner(): boolean;
  subscribe(listener: (event: SchedulerTransportEvent) => void): () => void;
  sendPush(peerDeviceId: string, payload: ImSchedulerFrame): void;
  /** Optional REST/presence refresh hook used by bounded discovery retries. */
  requestSnapshot?: () => void;
}
