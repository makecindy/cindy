
import {
  activeOwnerScopeKey,
  getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';
import { createBroadcastTap } from "./broadcastTapCore.js";
export type * from "./broadcastTapCore.js";
export const { getSafeDataOwnerPushStamp, captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent, tapWindowBroadcast, setBroadcastTapListener, hasBroadcastTapListener, tapRemoteModelCatalogChange } = createBroadcastTap({
  activeOwnerScopeKey: () => activeOwnerScopeKey(),
  getActiveDataOwnerPushStamp: () => getActiveDataOwnerPushStamp(),
  isAppSessionBoundaryPending: () => isAppSessionBoundaryPending(),
});
