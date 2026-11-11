/**
 * @cindy/device-link-relay
 * ---------------------------------------------------------------------------
 * 自建中转服务内核。方案见 docs/self-hosted-relay-plan.md。
 */
export { createDeviceCredential, hashSecret, RELAY_AUTH_SCHEME } from './credentials';
export { RelayError, type RelayErrorCode } from './errors';
export type { RelayLogger } from './logger';
export { initializeRelay, type InitializeRelayInput } from './store';
export { readTlsFiles, startRelayServer, type RelayServerHandle, type RelayServerOptions } from './server';
export { RELAY_VERSION } from './version';
