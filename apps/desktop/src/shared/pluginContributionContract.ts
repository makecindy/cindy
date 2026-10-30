/** Personal contribution wire contract. Keep equivalent to docs/plugin-community-contribution-contract.md. */
import { z } from 'zod';

const id = z.string().min(1).max(256);
const date = z.string().datetime();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const contributionSubject = z.object({ authority: z.string().url(), membershipId: id });
export const releaseRevision = z.object({ releaseId: id, sha256: sha, displayUpdatedAt: date });
export const contributionRequest = z
  .object({
    sizeBytes: z.number().int().positive().max(134217728),
    sha256: sha,
    source: z.enum(['manual', 'ai']),
    target: z
      .object({
        pluginId: id.nullable(),
        ghostId: id,
        version: z.string().min(1).max(32),
        expectedRelease: releaseRevision.nullable(),
      })
      .strict(),
  })
  .strict();
const review = z.enum(['pending', 'approved', 'rejected', 'cancelled']);
const icon = z
  .object({
    mimeType: z.string(),
    sha256: sha,
    sizeBytes: z.number(),
    url: z.string().url(),
    expiresAt: date,
  })
  .nullable();
export const submissionView = z.object({
  submissionId: id.nullable(),
  releaseId: id,
  version: z.string(),
  submittedAt: date.nullable(),
  approvedAt: date.nullable().optional(),
  cancelledAt: date.nullable().optional(),
  actions: z.object({ canCancelReview: z.boolean() }).optional(),
  publishSource: z.enum([
    'community_upload',
    'github_oidc',
    'console_upload',
    'member_upload',
    'server_template',
  ]),
  source: z.enum(['manual', 'ai']).nullable(),
  revision: releaseRevision,
  revisionState: z.enum(['current', 'superseded', 'legacy_unverified']),
  reviewStatus: review.nullable(),
  decidedAt: date.nullable(),
  reason: z.string().nullable(),
});
export const contributionReceipt = z.object({
  submissionId: id,
  operationId: id,
  pluginId: id,
  releaseId: id,
  ghostId: id,
  version: z.string(),
  source: z.enum(['manual', 'ai']),
  submittedAt: date,
  uploadedPackage: z.object({ sha256: sha, sizeBytes: z.number().int().positive() }),
  releaseRevision,
  outcome: z.enum(['submitted_for_review', 'metadata_updated', 'unchanged']),
});
export const operationStatus = z.enum([
  'awaiting_upload',
  'validating',
  'publishing',
  'succeeded',
  'failed',
  'expired',
]);
export const contributionOperation = z
  .object({
    subject: contributionSubject,
    operationId: id,
    status: operationStatus,
    createdAt: date,
    updatedAt: date,
    expiresAt: date,
    receipt: contributionReceipt.nullable(),
    submission: submissionView.nullable(),
    failure: z.object({ code: z.string(), message: z.string() }).nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.status === 'succeeded' && (!value.receipt || !value.submission)) ||
      (value.status === 'failed' && !value.failure) ||
      (value.status !== 'failed' && value.failure !== null) ||
      (value.receipt && value.receipt.operationId !== value.operationId)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent contribution operation' });
    }
  });
export const preparedResponse = z.object({
  subject: contributionSubject,
  operationId: id,
  status: operationStatus,
  createdAt: date,
  updatedAt: date,
  expiresAt: date,
  receipt: contributionReceipt.nullable(),
  submission: submissionView.nullable(),
  failure: z.object({ code: z.string(), message: z.string() }).nullable(),
  upload: z
    .object({
      putUrl: z.string().url(),
      headers: z.record(z.string(), z.string()),
      expiresAt: date,
    })
    .nullable(),
});
export const commitResponse = z.object({
  subject: contributionSubject,
  operationId: id,
  status: operationStatus,
});
const content = z.object({
  manifest: z
    .object({ id, name: z.string(), description: z.string().optional(), version: z.string() })
    .passthrough(),
  manifestView: z.record(z.string(), z.unknown()),
  icon,
});
export const myPluginSummary = z.object({
  pluginId: id,
  ghostId: id,
  scope: z.literal('public'),
  namespace: z.string().nullable(),
  name: z.string(),
  displayAuthor: z.string().max(100).nullable().optional(),
  authorSettings: z.object({ anonymous: z.boolean(), canEdit: z.boolean() }).nullable().optional(),
  publisherKind: z.enum(['official', 'personal']).nullable().optional(),
  description: z.string().nullable(),
  icon,
  market: z.object({
    pluginStatus: z.enum(['active', 'disabled', 'archived']),
    currentRelease: z
      .object({
        releaseId: id,
        version: z.string(),
        sha256: sha,
        reviewStatus: review,
        revokedAt: date.nullable(),
      })
      .nullable(),
    available: z.boolean(),
    unavailableReason: z
      .enum(['not_listed', 'disabled', 'archived', 'release_unavailable'])
      .nullable(),
  }),
  latestSubmission: submissionView.nullable(),
  updatedAt: date,
  actions: z.object({ canSubmit: z.boolean(), canViewMarket: z.boolean() }),
});
export const authorHistoryEvent = z.object({
  eventId: id,
  type: z.enum([
    'submitted',
    'metadata_updated',
    'approved',
    'rejected',
    'cancelled',
    'enabled',
    'disabled',
    'current_changed',
    'revoked',
  ]),
  at: date,
  releaseId: id.nullable(),
  version: z.string().nullable(),
  submissionId: id.nullable(),
  revision: releaseRevision.nullable(),
  reason: z.string().nullable(),
});
const envelope = z.object({ subject: contributionSubject, queriedAt: date });
export const contributionPreflight = envelope.extend({
  policyVersion: z.literal(2),
  target: z.object({
    pluginId: id.nullable(),
    ghostId: id,
    version: z.string(),
    expectedRelease: releaseRevision.nullable(),
  }),
  pendingRelease: z.object({ releaseId: id, version: z.string() }).nullable(),
  blockers: z.array(z.object({ code: z.string(), message: z.string() })),
  actions: z.object({ canSubmit: z.boolean() }),
});
export const cancelledReview = envelope.extend({ pluginId: id, submission: submissionView });
export type ContributionPreflight = z.infer<typeof contributionPreflight>;
export const myPluginList = envelope.extend({
  plugins: z.array(myPluginSummary),
  nextCursor: z.string().nullable(),
});
export const myPluginDetail = envelope.extend({
  plugin: myPluginSummary,
  latestSubmissionContent: content.nullable(),
  history: z.object({ events: z.array(authorHistoryEvent), nextCursor: z.string().nullable() }),
});
export const myPluginHistory = envelope.extend({
  events: z.array(authorHistoryEvent),
  nextCursor: z.string().nullable(),
});
export const myPluginReleases = envelope.extend({
  releases: z.array(submissionView),
  nextCursor: z.string().nullable(),
});
export const mySubmissionDetail = envelope.extend({
  receipt: contributionReceipt,
  submission: submissionView,
  content: content.nullable(),
});
export type ContributionSubject = z.infer<typeof contributionSubject>;
export type ContributionRequest = z.infer<typeof contributionRequest>;
export type ContributionOperation = z.infer<typeof contributionOperation>;
export type SubmissionView = z.infer<typeof submissionView>;
export type SubmissionContent = z.infer<typeof content>;
export type AuthorHistoryEvent = z.infer<typeof authorHistoryEvent>;
export type MyPluginSummary = z.infer<typeof myPluginSummary>;

export const CONTRIBUTION_ERROR_CODES = [
  'RELEASE_NOTES_REQUIRED',
  'VERSION_ALREADY_SUBMITTED',
  'PLUGIN_PENDING_RELEASE_EXISTS',
  'CONTRIBUTION_PACKAGE_CHANGED',

  'PERSONAL_CONTEXT_REQUIRED',
  'CONTRIBUTION_NOT_AUTHORIZED',
  'CONTRIBUTION_OPERATION_NOT_FOUND',
  'PLUGIN_NOT_FOUND',
  'CONTRIBUTION_SUBMISSION_NOT_FOUND',
  'CONTRIBUTION_IDEMPOTENCY_CONFLICT',
  'CONTRIBUTION_REVISION_STALE',
  'PLUGIN_GHOST_ID_CONFLICT',
  'RELEASE_VERSION_CONFLICT',
  'PLUGIN_ARCHIVED',
  'RELEASE_REVOKED',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'JWKS_UNAVAILABLE',
  'STORAGE_UNAVAILABLE',
  'PLUGIN_REPLICAS_NOT_READY',
  'UPLOAD_OBJECT_MISSING',
  'UPLOAD_SIZE_MISMATCH',
  'UPLOAD_SHA256_MISMATCH',
  'PLUGIN_PACKAGE_INVALID',
  'CONTRIBUTION_TARGET_MISMATCH',
  'PUBLISH_STORAGE_UNAVAILABLE',
  'PUBLISH_INTERNAL_ERROR',
] as const;
