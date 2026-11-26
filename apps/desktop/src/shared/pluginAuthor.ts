/**
 * Organization plugin author wire contract (plugin-server `/api/personal/plugins`, auth-server
 * `/api/me/colleagues*`, `/api/me/skill-audience-departments`) from cindy-server #1553 and #1593
 * (latest review event, publish context). A server without author routes answers the list with a
 * 404 and the page hides team sharing.
 *
 * Responses are parsed leniently: unknown fields are dropped and statistics stay decimal strings
 * (missing = unavailable, not zero).
 */
import { VISIBILITY_AUDIENCE_EMAIL_MAX_LENGTH, type ManagedReleaseReview } from '@cindy/plugin-protocol';
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

/**
 * A member's primary department, added by the server after the first release of these routes;
 * missing (older servers), null (left or no department) and malformed values read as absent, and
 * the client then shows the email next to the name instead.
 */
const memberDepartment = z.object({ id, name: z.string().min(1) }).nullable().optional().catch(undefined);

export const memberReferenceSchema = z.object({
  membershipId: id,
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  department: memberDepartment,
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

export /**
 * The most recent review event the author should be told about (#1593): an approval, a return,
 * or an administrator / Platform delisting. The author's own actions and cancelled reviews are not
 * events. `id` is opaque and changes with every new event, so it is the unread key as is.
 */
const reviewEventSchema = z.object({
  id,
  kind: z.enum(['approved', 'rejected', 'disabled']),
  at: date,
  /** Wire release ID for approvals and returns; null for delistings. */
  releaseId: z.string().nullable(),
  actorType: z.string(),
});
export type PersonalReviewEvent = z.infer<typeof reviewEventSchema>;

const personalPluginSummarySchema = z.object({
  id,
  ghostId: id,
  namespace: z.string().nullable().optional(),
  name: z.string(),
  description: z.string().nullable().optional(),
  myRole: z.enum(['creator', 'maintainer']),
  status: z.enum(['active', 'disabled', 'archived']),
  disabledBy: z.enum(['author', 'organization', 'platform']).nullable().optional(),
  disabledByAdmin: z.boolean().optional(),
  latestReviewEvent: reviewEventSchema.nullable().optional(),
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

/**
 * What a publish of this ghostId may do with the audience (#1593 publish-context): a new plugin, an
 * existing one the caller may not edit (no audience given), or one the caller may edit (creator,
 * maintainer or plugin manager) with its current audience.
 */
export const publishContextSchema = z.union([
  z.object({ exists: z.literal(false) }),
  z.object({ exists: z.literal(true), pluginId: id, status: z.string(), canEdit: z.literal(false) }),
  z.object({
    exists: z.literal(true),
    pluginId: id,
    status: z.string(),
    canEdit: z.literal(true),
    visibilityAudience: visibilityAudienceSchema,
    visibilityAudienceMembers: z.array(memberReferenceSchema),
  }),
]);
export type PersonalPublishContext = z.infer<typeof publishContextSchema>;

export const colleagueSchema = z.object({
  membershipId: id,
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  department: memberDepartment,
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
  department: memberDepartment,
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
/** `/api/me/colleagues?q=` accepts at most this many characters; longer text is never searched. */
export const COLLEAGUE_SEARCH_MAX_LENGTH = 254;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * Whether text can be added to an audience as an email: shaped like an email and within the
 * protocol's length limit. Decided on its own, never by whether a colleague search succeeded.
 */
export function isAudienceEmail(text: string): boolean {
  return text.length <= VISIBILITY_AUDIENCE_EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(text);
}
export const COLLEAGUE_LOOKUP_MAX = 100;

/**
 * Organization review results plus the change signal they were read at. `changeToken` moves on
 * any author-visible change (not only review results); null when the server has no signal.
 */
export interface OrganizationReviewSnapshot {
  updates: import('./pluginContributions').PluginReviewUpdate[];
  changeToken: string | null;
}

/** Renderer-facing author and picker API exposed through preload. */
export interface PluginAuthorRendererApi {
  /** Organization plugins the member creates or maintains; UNSUPPORTED_CAPABILITY without author routes. */
  listPlugins(cursor?: string): Promise<PersonalPluginPage>;
  /** Organization review results (`org:` ids), independent of the public ones. */
  reviewUpdates(): Promise<OrganizationReviewSnapshot>;
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
 * The review event of an organization plugin the author should see, shared by Main (unread dots)
 * and the detail page (which event it is showing). The server decides what counts as an event
 * (#1593); the key is its opaque id, so any new event — including delisting the same version
 * again — lights the dot, and the author's own submissions or cancellations never do.
 */
export function organizationReviewDecision(plugin: PersonalPluginSummary): {
  status: PersonalReviewEvent['kind'];
  key: string;
  at: string;
  releaseId: string | null;
  version: string | null;
} | null {
  const event = plugin.latestReviewEvent;
  if (!event) return null;
  // A delisting names no release; it concerns the listed version.
  const release = event.releaseId
    ? [plugin.latestRelease, plugin.pendingRelease, plugin.currentRelease].find((item) => item?.id === event.releaseId) ?? null
    : plugin.currentRelease ?? null;
  return {
    status: event.kind,
    key: event.id,
    at: event.at,
    releaseId: event.releaseId ?? release?.id ?? null,
    version: release?.version ?? null,
  };
}
