/**
 * Organization plugin release review result, as returned by the author version list
 * (`GET /api/personal/plugins/:pluginId/releases`). Mirrors cindy-server plugin-protocol
 * `management/types.ts` `ManagedReleaseReview` / `ManagedReleaseSummary.review` (#1553).
 *
 * `review` is optional on the wire: null while undecided or without a review record, and absent
 * on older servers — both read as "no recorded result".
 */
export interface ManagedReleaseReview {
  outcome: 'approved' | 'rejected' | 'cancelled';
  decidedAt: string;
  /** Rejection reason; null for approvals and cancellations. */
  reason: string | null;
  /** Server audit actor type, kept as an open string so newer values do not break parsing. */
  actorType: string;
}
