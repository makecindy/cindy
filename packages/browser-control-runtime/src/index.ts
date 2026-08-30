export type {
  BrowserActKind,
  BrowserActRequest,
  BrowserControlAction,
  BrowserControlErrorCode,
  BrowserControlRequest,
  BrowserControlResult,
  BrowserControlRuntime,
  BrowserControlRuntimeFactoryOptions,
  BrowserControlTarget,
  BrowserElementQuery,
  BrowserImageType,
  BrowserSnapshotFormat,
  BrowserSnapshotMode,
  BrowserSnapshotRefs,
} from './types.js';
export { createUnavailableBrowserRuntime } from './unavailable.js';
export {
  createBrowserControlRuntime,
  type CreateBrowserControlRuntimeOptions,
} from './runtime.js';
// Host-settable runtime config (profiles / driver / ssrf policy). Lets the
// desktop host swap the effective browser config at runtime (e.g. switch the
// default profile between managed and real-Chrome takeover) WITHOUT recreating
// the runtime — config reads hot-reload per request inside the dispatcher.
export { setBrowserRuntimeConfig as setBrowserControlRuntimeConfig } from './shim/runtime-config-snapshot.js';
export { refreshBrowserRuntimeConfigDir } from './shim/_local/text-utils.js';
export { isPublicHttpResourceUrl } from './resource-url-policy.js';
// Re-export the effective-config type under a neutral name so host code stays
// free of the vendored type's product-specific identifier.
export type {
  OpenClawConfig as BrowserRuntimeConfig,
  BrowserConfig,
  BrowserProfileConfig,
} from './shim/config-contracts.js';
