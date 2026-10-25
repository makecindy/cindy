import { createFeishuTransportRouting } from '@cindy/app-runtime/feishuTransportRouting';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
export const {createFeishuTransportResolver}=createFeishuTransportRouting({activeOwnerScopeKey,isAppSessionBoundaryPending,getCurrentDbClientSnapshot});
