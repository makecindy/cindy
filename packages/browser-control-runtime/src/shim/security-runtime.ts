/**
 * Shim: openclaw/plugin-sdk/security-runtime.
 *
 * Composes the real security primitives from three vendored sources — NO hand
 * re-implementation of path/SSRF security logic:
 *   - filesystem containment (pathScope, root, symlink/hardlink, sanitize) → vendored @openclaw/fs-safe dist
 *   - SSRF / hostname policy → vendored leaf src/infra/net/ssrf.ts + proxy-env
 *   - external-content wrapping, secret-equal → vendored leaf src/security/*
 *   - error/redact/port helpers → faithful local ports (see _local/*) that avoid
 *     dragging in the upstream logger/config monolith.
 */

// ── filesystem containment (real upstream fs-safe) ───────────────────────────
export {
  pathScope,
  findExistingAncestor,
  sanitizeUntrustedFileName,
  writeViaSiblingTempPath,
  resolveExistingPathsWithinRoot,
  resolvePathWithinRoot,
  resolvePathsWithinRoot,
  resolveStrictExistingPathsWithinRoot,
  resolveWritablePathWithinRoot,
} from '../_generated/vendor/fs-safe/dist/advanced.js';
export { isPathInside, isNotFoundPathError } from '../_generated/vendor/fs-safe/dist/path.js';
export { root } from '../_generated/vendor/fs-safe/dist/root.js';
export { writeExternalFileWithinRoot } from '../_generated/vendor/fs-safe/dist/output.js';
export { FsSafeError } from '../_generated/vendor/fs-safe/dist/errors.js';

// ── SSRF / hostname policy (real upstream ssrf.ts) ───────────────────────────
export {
  SsrFBlockedError,
  isPrivateNetworkAllowedByPolicy,
  matchesHostnameAllowlist,
  resolvePinnedHostnameWithPolicy,
  resolveSsrFPolicyForUrl,
  type LookupFn,
  type SsrFPolicy,
} from '../_generated/leaf/src/infra/net/ssrf.js';
export { normalizeHostname } from '../_generated/leaf/src/infra/net/hostname.js';
export { hasProxyEnvConfigured } from '../_generated/leaf/src/infra/net/proxy-env.js';

// ── external content + secret compare (real upstream leaves) ─────────────────
export { wrapExternalContent } from '../_generated/leaf/src/security/external-content.js';
export { safeEqualSecret } from '../_generated/leaf/src/security/secret-equal.js';

// ── error/redact/port helpers (faithful local ports, no logger/config graph) ─
export { extractErrorCode, formatErrorMessage } from './_local/errors.js';
export { redactSensitiveText } from './_local/redact.js';
export { ensurePortAvailable } from './_local/ports.js';
