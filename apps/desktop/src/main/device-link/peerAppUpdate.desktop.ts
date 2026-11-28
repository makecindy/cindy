/** Desktop wiring for peerAppUpdate — reuses updateService + relaunchBusyActivity directly. */
import { app } from 'electron';

import { isAppSessionBoundaryPending } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { readRelaunchBlockingActivity } from '../relaunchBusyActivityIpc.js';
import {
  applyConfirmedAppUpdateForAgent,
  checkAppUpdateForAgent,
} from '../updateService.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from './broadcast-tap.js';
import { createPeerAppUpdateHandler, type PeerAppUpdateHandler } from './peerAppUpdate.js';

const log = createLogger('peer-app-update');

let instance: PeerAppUpdateHandler | null = null;

export function getDesktopPeerAppUpdateHandler(): PeerAppUpdateHandler {
  instance ??= createPeerAppUpdateHandler({
    platform: process.platform,
    appVersion: () => app.getVersion(),
    check: checkAppUpdateForAgent,
    apply: applyConfirmedAppUpdateForAgent,
    isBusy: async () => (await readRelaunchBlockingActivity()).busy,
    captureScope: () => {
      if (isAppSessionBoundaryPending()) return () => false;
      const scope = captureDataOwnerBroadcastScope();
      return () => !isAppSessionBoundaryPending() && isDataOwnerBroadcastScopeCurrent(scope);
    },
    now: () => Date.now(),
    log: {
      info: (message, meta) => log.info(message, meta ?? {}),
      warn: (message, meta) => log.warn(message, meta ?? {}),
    },
  });
  return instance;
}
