/** Opaque same-account Desktop plugin exchange. Relay carries grant/key metadata and ciphertext.
 * Older clients ignore this channel; absence of a reply never implies execution failure.
 */
export const PLUGIN_SYNC_CHANNEL = "device-link:plugin-sync:v1";
export const PLUGIN_SYNC_MAX_BYTES = 64 * 1024;
export type PluginSyncWireFrame =
  | { version: 1; kind: "authorize" | "authorized"; nonce: string }
  | { version: 1; kind: "key"; publicKey: string }
  | {
      version: 1;
      kind: "data";
      transferId: string;
      iv: string;
      tag: string;
      data: string;
    };
