/**
 * @cindy/maker-pi-manager — public API.
 *
 * Bundled for remote deployment via `pnpm --filter @cindy/maker-pi-manager
 * bundle` → dist/pi-manager.mjs (esbuild, single self-contained ESM file).
 * Desktop consumes the protocol/client/codec from source via workspace
 * exports; the bundled artifact is what runs on remote SSH machines.
 */

export {
  PROTOCOL_VERSION,
  PI_MANAGER_BUNDLE_VERSION,
  METHODS,
  NOTIFICATIONS,
  makeRpcError,
  isRpcMessage,
  isRpcRequest,
  isRpcResponse,
  isRpcNotification,
  type RpcId,
  type RpcError,
  type RpcErrorCode,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
  type RpcNotification,
  type HelloParams,
  type HelloResult,
  type PiEnsureParams,
  type PiEnsureResult,
  type PiKillParams,
  type PiListEntry,
  type PiListResult,
  type SessionClosedNotification,
  type MethodName,
  type NotificationName,
} from './protocol.js';

export { NDJSONDecoder, encodeMessage, type NDJSONDecoderOptions } from './codec.js';

export {
  ManagerServer,
  makeServerError,
  type ManagerServerOptions,
  type ManagerLogger,
  type ClientCtx,
  type MethodHandler,
} from './server.js';

export {
  PiSessionRegistry,
  type PiSessionState,
  type PiSessionRegistryOptions,
} from './session-registry.js';

export { RpcClient, RpcClientError, type RpcClientOptions } from './client.js';
