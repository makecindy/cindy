/// <reference lib="dom" />
import { createFilePeerRuntime, type FilePeerRuntimeBridge } from './filePeerRuntime.js';
import { createNodeRtcPeerConnection, type NodeRtcModule } from './nodeRtcPeerConnection.js';

/** Files-v1/v2 and attachment RPC use the existing wire implementation. Only
 * the native peer constructor differs from Electron/Mobile's browser host. */
export function createNodeFilePeerRuntime(bridge: FilePeerRuntimeBridge, native: NodeRtcModule) {
  return createFilePeerRuntime(bridge, configuration => createNodeRtcPeerConnection(native, configuration));
}
