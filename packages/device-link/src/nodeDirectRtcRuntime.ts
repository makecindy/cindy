/// <reference lib="dom" />
import { createDirectRtcRuntime } from './directRtcRuntime.js';
import type { DirectRuntime } from './directNegotiation.js';
import { createNodeRtcPeerConnection, type NodeRtcModule } from './nodeRtcPeerConnection.js';

/** Native WebRTC is supplied by the Node host; this package does not bundle a
 * native binary, alter globals, or require Electron. Browser and Node hosts use
 * exactly the same authenticated signaling, framing and backpressure rules. */
export function createNodeDirectRtcRuntime(native: NodeRtcModule): DirectRuntime {
  return createDirectRtcRuntime((configuration) => createNodeRtcPeerConnection(native, configuration));
}
