/**
 * Organization plugin author wire contract (plugin-server `/api/personal/plugins`, auth-server
 * `/api/me/colleagues*`, `/api/me/skill-audience-departments`). Added by cindy-server #1553;
 * older servers return 404 and the client hides author features.
 *
 * Responses are parsed leniently: unknown fields are dropped, optional fields may be missing on
 * older builds, and statistics stay decimal strings (missing = unavailable, not zero).
 */
import type { ManagedReleaseReview } from '@cindy/plugin-protocol';
import { z } from 'zod';

const id = z.string().min(1).max(256);
const date = z.string().min(1).max(64);

export const visibilityAudienceSchema = z.union([
  z.object({ type: z.literal('all') }),
  z.object({
    type: z.literal('matchAny'),
    membershipIds: z.array(z.string()).optional(),
    departmentIds: z.array(z.string()).optional(),
    emails: z.array(z.string()).optional(),
    roles: z.array(z.string()).optional(),
  }),
]);
export type AuthorVisibilityAudience = z.infer<typeof visibilityAudienceSchema>;

export const memberReferenceSchema = z.object({
  membershipId: id,
  displayName: z.string().nullable(),
  email: z.string().nullable(),
});
export type AuthorMemberReference = z.infer<typeof memberReferenceSchema>;

const reviewStatus = z.enum(['pending', 'approved', 'rejected', 'cancelled']);
const releaseRef = z.object({
  id,
  version: z.string(),
  reviewStatus: reviewStatus.nullable().optional(),
  sha256: z.string().optional(),
  sizeBytes: z.number().optional(),
  publishedAt: date.nullable().optional(),
  displayUpdatedAt: date.nullable().optional(),
  /** Short-lived HTTPS icon download (PluginIconMetadata); only the URL is used. */
  icon: z.object({ url: z.string().url().startsWith('https://') }).nullable().optional().catch(null),
});

export const personalPluginSummarySchema = z.object({
  id,
  ghostId: id,
  namespace: z.string().nullable().optional(),
  name: z.string(),
  description: z.string().nullable().optional(),
  myRole: z.enum(['creator', 'maintainer']),
  status: z.enum(['active', 'disabled', 'archived']),
  disabledBy: z.enum(['author', 'organization', 'platform']).nullable().optional(),
  disabledByAdmin: z.boolean().optional(),
  currentRelease: releaseRef.nullable().optional(),
  latestRelease: releaseRef.nullable().optional(),
  pendingRelease: releaseRef.nullable().optional(),
  downloadStatistics: z
    .object({ requestCount: z.string(), last7DaysRequestCount: z.string().optional() })
    .optional(),
  usageStatistics: z
    .object({ usageCount: z.string(), usageCountLast7Days: z.string().optional() })
    .optional(),
  createdAt: date.optional(),
  updatedAt: date.optional(),
});
export type PersonalPluginSummary = z.infer<typeof personalPluginSummarySchema>;

export const personalPluginListSchema = z.object({
  plugins: z.array(personalPluginSummarySchema),
  nextCursor: z.string().nullable(),
});
/** Up to a bounded number of server pages; a non-null cursor means more remain. */
export type PersonalPluginPage = z.infer<typeof personalPluginListSchema>;

export const personalPluginDetailSchema = z.object({
  plugin: personalPluginSummarySchema.extend({
    visibilityAudience: visibilityAudienceSchema.optional(),
    visibilityAudienceMembers: z.array(memberReferenceSchema).optional(),
    lastRejection: z
      .object({ createdAt: date, detail: z.object({ reason: z.string().nullable().optional() }).passthrough().optional() })
      .nullable()
      .optional(),
  }),
});
export type PersonalPluginDetail = z.infer<typeof personalPluginDetailSchema>['plugin'];

export const colleagueSchema = z.object({
  membershipId: id,
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  active: z.boolean(),
});
export type Colleague = z.infer<typeof colleagueSchema>;

export const departmentMembersSchema = z.object({
  members: z.array(colleagueSchema),
  total: z.number().int().nonnegative(),
});
export const colleagueSearchSchema = z.object({ members: z.array(colleagueSchema) });

export const departmentSchema = z.object({
  id,
  name: z.string(),
  parentId: z.string().nullable(),
  sortOrder: z.number(),
});
export type AuthorDepartment = z.infer<typeof departmentSchema>;
export const departmentListSchema = z.object({ departments: z.array(departmentSchema) });

/**
 * Per-version review result (cindy-server #1553, ManagedReleaseReview). Null while undecided or
 * without a review record; older servers omit the field, which reads the same as null.
 */
export const releaseReviewSchema = z.object({
  outcome: z.enum(['approved', 'rejected', 'cancelled']),
  decidedAt: date,
  /** Only set when the version was returned. */
  reason: z.string().nullable(),
  actorType: z.string(),
});
export type PluginReleaseReview = z.infer<typeof releaseReviewSchema>;
// The parser and the protocol package type must describe the same wire shape.
type SameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const RELEASE_REVIEW_MATCHES_PROTOCOL: SameShape<PluginReleaseReview, ManagedReleaseReview> = true;

export const personalReleaseSchema = z.object({
  id,
  version: z.string(),
  reviewStatus: reviewStatus.nullable().optional(),
  status: z.string().optional(),
  /** For member uploads this is the submission time. */
  publishedAt: date.nullable().optional(),
  createdAt: date.optional(),
  review: releaseReviewSchema.nullable().optional().catch(null),
});
export type PersonalRelease = z.infer<typeof personalReleaseSchema>;
export const personalReleaseListSchema = z.object({
  releases: z.array(personalReleaseSchema),
  nextCursor: z.string().nullable(),
});
export type PersonalReleasePage = z.infer<typeof personalReleaseListSchema>;

/** Author change signal: either value moving means review results may have changed. */
export const personalPluginChangesSchema = z.object({
  changedAt: z.string().nullable(),
  eventCount: z.number().int().nonnegative(),
});
export type PersonalPluginChanges = z.infer<typeof personalPluginChangesSchema>;

/** Review results of organization plugins share the public read markers under this prefix. */
export const ORGANIZATION_REVIEW_ID_PREFIX = 'org:';

export const maintainerSchema = z.object({
  id,
  membershipId: id,
  authorizationRole: z.enum(['creator', 'maintainer']),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  authorizedAt: date.optional(),
});
export type PluginMaintainer = z.infer<typeof maintainerSchema>;
export const maintainerListSchema = z.object({ maintainers: z.array(maintainerSchema) });
export const maintainerAddedSchema = z.object({ maintainer: maintainerSchema });
export const cancelledReleaseSchema = z.object({
  release: z.object({ id, version: z.string(), reviewStatus: reviewStatus.nullable().optional() }),
});

/** Author changes the server allows (#1504 permission table). */
export type PersonalPluginUpdate =
  | { visibilityAudience: AuthorVisibilityAudience }
  | { status: 'active' | 'disabled' };

/** Author-facing failures that need their own wording; registered as IPC error codes. */
export const PLUGIN_AUTHOR_IPC_ERROR_CODES = [
  'PLUGIN_DISABLED_BY_ADMIN',
  'PLUGIN_REVIEW_REQUIRED',
  'PLUGIN_REVIEW_FINAL',
  'PLUGIN_REVIEW_STATE_CHANGED',
  'PLUGIN_AUDIENCE_VALIDATION_UNAVAILABLE',
  'PLUGIN_MEMBER_LOOKUP_UNAVAILABLE',
  'PLUGIN_MAINTAINER_EXISTS',
  'COMMON_PLUGIN_MANAGED',
] as const;

/** Server page sizes; used to tell whether another page exists. */
export const COLLEAGUES_PAGE_SIZE = 50;
export const COLLEAGUE_SEARCH_LIMIT = 20;
export const COLLEAGUE_LOOKUP_MAX = 100;

/** Renderer-facing author and picker API exposed through preload. */
export interface PluginAuthorRendererApi {
  /** Organization plugins the member creates or maintains; UNSUPPORTED_CAPABILITY on old servers. */
  listPlugins(cursor?: string): Promise<PersonalPluginPage>;
  /** Organization review results (`org:` ids), independent of the public ones. */
  reviewUpdates(): Promise<import('./pluginContributions').PluginReviewUpdate[]>;
  plugin(pluginId: string): Promise<PersonalPluginDetail>;
  updatePlugin(pluginId: string, update: PersonalPluginUpdate): Promise<PersonalPluginDetail>;
  cancelReview(pluginId: string, releaseId: string): Promise<void>;
  releases(pluginId: string, cursor?: string): Promise<PersonalReleasePage>;
  maintainers(pluginId: string): Promise<PluginMaintainer[]>;
  addMaintainer(pluginId: string, membershipId: string): Promise<PluginMaintainer>;
  removeMaintainer(pluginId: string, authorizationId: string): Promise<void>;
  departments(): Promise<AuthorDepartment[]>;
  departmentMembers(departmentId: string, page: number): Promise<{ members: Colleague[]; total: number }>;
  searchColleagues(query: string): Promise<Colleague[]>;
  lookupColleagues(membershipIds: string[]): Promise<Colleague[]>;
}

/**
 * Newest author-facing review result of an organization plugin, shared by Main (unread dots) and
 * the detail page (which result it is showing). Pending, cancelled and the author's own delisting
 * are not review results.
 *
 * An administrator delisting folds in the latest submission, so a version approved or returned
 * while delisted still changes the key; a version decided after the listed one reports its own
 * outcome.
 */
export function organizationReviewDecision(plugin: PersonalPluginSummary): {
  status: 'approved' | 'rejected' | 'disabled';
  key: string;
  releaseId: string | null;
  version: string | null;
} | null {
  const latest = plugin.latestRelease;
  const latestDecided = latest && (latest.reviewStatus === 'approved' || latest.reviewStatus === 'rejected')
    ? latest : null;
  if (plugin.status === 'disabled' && plugin.disabledByAdmin === true) {
    const newer = latestDecided && latestDecided.id !== plugin.currentRelease?.id ? latestDecided : null;
    // While the latest submission is pending or cancelled the summary no longer shows the most
    // recent decided version (it may be a returned version that was never listed), so the key
    // leaves it unknown; a read marker of the same delisting covers it (see
    // organizationReviewAlreadyRead) instead of the key falling back to the listed version.
    const folded = latestDecided ? { id: latestDecided.id, reviewStatus: latestDecided.reviewStatus } : null;
    return {
      status: newer ? (newer.reviewStatus as 'approved' | 'rejected') : 'disabled',
      // Only real approvals / returns fold in: the author's own submissions and cancellations
      // during the delisting must not light the dot again.
      key: JSON.stringify(['disabled', plugin.disabledBy ?? null, plugin.currentRelease?.id ?? null,
        folded?.id ?? null, folded?.reviewStatus ?? null]),
      releaseId: newer?.id ?? plugin.currentRelease?.id ?? null,
      version: newer?.version ?? plugin.currentRelease?.version ?? null,
    };
  }
  if (!latestDecided) return null;
  return {
    status: latestDecided.reviewStatus as 'approved' | 'rejected',
    key: JSON.stringify([latestDecided.id, latestDecided.reviewStatus]),
    releaseId: latestDecided.id,
    version: latestDecided.version,
  };
}

/**
 * Whether a stored read marker already covers `key`. Reading an administrator delisting also read
 * the submission result folded into it, so listing again does not light the same result twice, and
 * the author's own submission or cancellation during that delisting does not light it again.
 */
export function organizationReviewAlreadyRead(marker: string | undefined, key: string): boolean {
  if (marker === undefined) return false;
  if (marker === key) return true;
  try {
    const read = JSON.parse(marker) as unknown[];
    const current = JSON.parse(key) as unknown[];
    if (read[0] !== 'disabled') return false;
    if (current.length === 2) return read[3] === current[0] && read[4] === current[1];
    // Same delisting, and only the author's own submission or cancellation since: whatever decision
    // was folded into the read marker is still the most recent one.
    return current[0] === 'disabled' && current[3] === null && current[4] === null &&
      read[1] === current[1] && read[2] === current[2];
  } catch {
    return false;
  }
}
