import { getDeviceId } from '../authManager.js';
import { isAppSessionBoundaryPending } from '../appSessionState.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import type { SessionControllerDeps } from './controller.js';

/** Record/history ports are usable without creating a Maker runtime. */
export const localSessionHost: SessionControllerDeps = {
  deviceId: getDeviceId,
  owner: () => isAppSessionBoundaryPending() ? null : getCurrentDbClientSnapshot(),
  execution: () => null,
};
