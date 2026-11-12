// The Pi vision-bridge env itself lives in piVisionBridgeEnvCore.ts (shared with the Node Host).
// This module keeps the Desktop default: the settings of the Desktop store
// (vision-bridge-settings-store.ts), read when the env is built, as before.
import { readVisionBridgeSettings } from './vision-bridge-settings-store.js';
import { buildPiVisionBridgeEnv as buildPiVisionBridgeEnvCore } from './piVisionBridgeEnvCore.js';
import type { VisionChannelDeps } from './vision-channel.js';

export {
  PI_VISION_BRIDGE_ENV,
  type PiVisionBackendSpec,
  type PiVisionBridgeEnvPayload,
} from './piVisionBridgeEnvCore.js';

/** The Desktop Pi vision-bridge env: the core with the Desktop settings store. */
export function buildPiVisionBridgeEnv(
  deps: VisionChannelDeps,
  model: string,
  sessionId?: string,
): Record<string, string> | null {
  return buildPiVisionBridgeEnvCore(deps, model, sessionId, {
    readVisionBridgeSettings: () => readVisionBridgeSettings(),
  });
}
