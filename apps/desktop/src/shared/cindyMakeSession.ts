/**
 * Cindy Make code task identity shared by Main and Renderer.
 *
 * A code task created from the /cindy-make dialog is persisted as
 * `sessions.source = 'cindy-make'`; Main derives everything else from that row
 * (the `cindy_make` MCP server, the per-turn task note, the completion card).
 * Ordinary tasks never carry the marker, even inside the same source checkout.
 */
export const CINDY_MAKE_SESSION_SOURCE = 'cindy-make' as const;

/**
 * Session-scoped `vendorOptions` marker hydrated from the persisted source at
 * every start. Scalar on purpose: queued-item sanitisation keeps only scalars.
 */
export const CINDY_MAKE_VENDOR_OPTION_KEY = 'cindyMakeSession' as const;

export const CINDY_MAKE_MCP_SERVER_NAME = 'cindy_make' as const;
export const CINDY_MAKE_REPORT_COMPLETE_TOOL = 'report_complete' as const;

export function isCindyMakeVendorOptions(
  vendorOptions: Readonly<Record<string, unknown>> | undefined | null,
): boolean {
  return vendorOptions?.[CINDY_MAKE_VENDOR_OPTION_KEY] === true;
}

/**
 * Persisted on an empty assistant row once the turn that called
 * `report_complete` has ended; Renderer derives the completion card from it.
 * Only code-verified facts: the model no longer supplies a summary.
 */
export interface CindyMakeCompletionMeta {
  reportedAt: number;
  /** Files committed by this completion on the task branch; absent when Git could not answer. */
  changedFiles?: number;
  /** Task-branch commit created by this completion (or HEAD when nothing changed). */
  commit?: string;
  /** Task branch the changes were committed to. */
  branch?: string;
}
