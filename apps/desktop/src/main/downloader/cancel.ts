/**
 * unified-downloader — M7: Cancel & cleanup contracts.
 * ---------------------------------------------------------------------------
 * Cancellation cleanup and error semantics are maintained in this module.
 *
 * The cancel logic lives where it actually fires:
 *   - In-flight cancel  → transport.ts (AbortSignal handler aborts the native HTTP request)
 *   - Backoff cancel    → retry.ts (sleepInterruptible)
 *   - Queued cancel     → scheduler.ts (tryStart short-circuits aborted tasks)
 *
 * cleanup() lives on the scheduler; callers use the public facade in index.ts.
 */

export {}; // intentional empty namespace — see header
