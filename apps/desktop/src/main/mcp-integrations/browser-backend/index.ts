// Browser backend abstraction — barrel.
//
// Phase 1 introduces this module to wrap the vendored runtime behind a backend
// contract. Phase 3 lands the RSB-webview backend; Phase 5 wires the
// Settings-driven toggle. See `types.ts` for the full architecture rationale.

export type {
  BackendKind,
  BackendRequest,
  BackendResult,
  BackendRuntimeShape,
  BrowserBackend,
} from './types.js';
export { ExternalChromeBackend } from './external-chrome-backend.js';
export { BackendRouter } from './router.js';
export { RsbWebviewBackend, type RsbWebviewBackendOptions } from './rsb-webview-backend.js';
