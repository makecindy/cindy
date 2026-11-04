import { createDirectRuntimeHost } from './directRuntimeBridge.js';
import { createDirectRtcRuntime } from './directRtcRuntime.js';
export function create(emit: Parameters<typeof createDirectRuntimeHost>[1]) {
  return createDirectRuntimeHost(createDirectRtcRuntime(), emit);
}
