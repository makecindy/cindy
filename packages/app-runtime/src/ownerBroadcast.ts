import type { DataOwnerPushStamp } from '@cindy/remote-agent/shared/dataOwnerPush';

/** The original data owner stamp survives asynchronous work and transport boundaries. */
export interface DataOwnerBroadcastScope {
  readonly ownerScopeKey?: string;
  readonly ownerStamp?: DataOwnerPushStamp;
}

export interface OwnerBroadcastTap {
  captureDataOwnerBroadcastScope(): DataOwnerBroadcastScope;
  isDataOwnerBroadcastScopeCurrent(scope: DataOwnerBroadcastScope): boolean;
  getSafeDataOwnerPushStamp(): DataOwnerPushStamp | undefined;
  tapWindowBroadcast(channel: string, payload: unknown, ownerStamp?: DataOwnerPushStamp): void;
}

/** Local surfaces are supplied by the host; remote delivery uses the same owner stamp. */
export type BroadcastLocal = (channel: string, payload: unknown, ...stamp: [DataOwnerPushStamp?] | []) => void;
