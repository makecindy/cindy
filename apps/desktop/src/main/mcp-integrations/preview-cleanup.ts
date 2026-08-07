/**
 * Preview cleanup indirection for the updater's force-quit path.
 *
 * updateService must NOT statically import browser.ts: the module loads the
 * whole browser runtime, which ends in `sharp` (via media-runtime), and on
 * Windows CI that chain breaks every updateService unit test (round 22, new
 * Codex reviewer). The fix must also obey architecture-invariants.md §2:
 * Electron main forbids runtime dynamic `import()` — the round-22 dynamic
 * import was itself a rule violation.
 *
 * So the updater statically imports THIS module (no runtime dependency, no
 * sharp), and browser.ts registers its real implementation at load time. A
 * missing registration is a no-op: if the browser integration never loaded,
 * there is no preview server and nothing to revoke.
 */

let cleanupImpl: (() => Promise<void>) | undefined;

/** Register the real revoke implementation (browser.ts, at module load). */
export function setPreviewCleanupImpl(impl: () => Promise<void>): void {
  cleanupImpl = impl;
}

/**
 * Revoke the preview origin, dispose the preview server, and start closing
 * preview tabs. Safe to call when the browser integration never loaded.
 */
export function revokePreviewState(): Promise<void> {
  if (!cleanupImpl) return Promise.resolve();
  return cleanupImpl();
}
