// The vision bridge itself lives in visionBridgeCore.ts (shared with the Node Host). This module
// keeps the Desktop default: the settings of the Desktop store (vision-bridge-settings-store.ts),
// read when the bridge reads them, as before.
import { isTargetModelsCustomized, readVisionBridgeSettings } from './vision-bridge-settings-store.js';
import { createVisionBridge as createVisionBridgeCore, type VisionBridgeDeps } from './visionBridgeCore.js';

export type { VisionBridgeDeps } from './visionBridgeCore.js';

/** The Desktop vision bridge: the core with the Desktop settings store. */
export function createVisionBridge(deps: VisionBridgeDeps): ReturnType<typeof createVisionBridgeCore> {
  return createVisionBridgeCore(deps, {
    readVisionBridgeSettings: () => readVisionBridgeSettings(),
    isTargetModelsCustomized: () => isTargetModelsCustomized(),
  });
}
