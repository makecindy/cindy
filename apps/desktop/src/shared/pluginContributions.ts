import type { GhostPermissionItem } from './ghost';
import type { AuthorHistoryEvent, ContributionOperation } from './pluginContributionContract';
/** Personal contribution operations share the exact installed-package snapshot across UI and AI. */
/** Compared against Main's installation; never used to resolve a filesystem path. */
export interface ContributionInstallationBinding {
  directory: string;
  approvalToken: string;
}
export interface PreparedPluginContribution {
  preparedId: string;
  instanceId: string;
  pluginId: string | null;
  ghostId: string;
  name: string;
  description: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  releaseNotes?: string;
  preflight?: import('./pluginContributionContract').ContributionPreflight;
  expiresAt: string;
}

/** UI projection only. Review and market facts always come from one server read. */
export type MyPluginFilter = 'all' | 'pending' | 'needs_action' | 'published';
export interface ContributionReleaseView {
  releaseId: string;
  version: string;
  sha256: string;
  revision: string;
  uploadedSha256?: string;
  uploadedSizeBytes?: number;
  reviewStatus: 'pending' | 'approved' | 'rejected' | 'cancelled' | null;
  revisionState: 'current' | 'superseded' | 'legacy_unverified';
  submissionId: string | null;
  submittedAt: string | null;
  approvedAt?: string | null;
  cancelledAt?: string | null;
  canCancelReview?: boolean;
  reviewedAt: string | null;
  reason: string | null;
  source: string | null;
  /** Absent historical bytes must never be filled from today's Release metadata. */
  content: {
    name: string;
    description: string;
    iconUrl: string | null;
    permissions: GhostPermissionItem[];
    manifestView: Record<string, unknown>;
  } | null;
}
export type MyPluginLocalInstallation =
  | { state: 'installed'; instanceId: string; version: string; origin: 'local' | 'public'; enabled: boolean }
  | { state: 'missing' | 'unavailable' };
export interface MyPluginView {
  pluginId: string;
  name: string;
  displayAuthor?: string | null;
  authorSettings?: { anonymous: boolean; canEdit: boolean } | null;
  publisherKind?: 'official' | 'personal' | null;
  iconUrl: string | null;
  updatedAt: string;
  market: {
    state: 'available' | 'not_listed' | 'disabled' | 'archived' | 'release_unavailable';
    version: string | null;
    releaseId: string | null;
    reason: string | null;
  };
  latestSubmission: ContributionReleaseView | null;
  actions: { submitUpdate: boolean; viewMarket: boolean };
  /** Main-owned installation match by namespace and plugin ID. */
  localInstanceId: string | null;
  localVersion?: string | null;
  /** Missing on older readers; absence must not be interpreted as not installed. */
  localInstallation?: MyPluginLocalInstallation;
}
export interface MyPluginPageView {
  plugins: MyPluginView[];
  nextCursor: string | null;
  queriedAt: string;
}
export interface MyPluginDetailView {
  plugin: MyPluginView;
  history: AuthorHistoryEvent[];
  nextCursor: string | null;
  queriedAt: string;
}

export interface MyPluginReleasePageView {
  releases: ContributionReleaseView[];
  nextCursor: string | null;
  queriedAt: string;
}

export interface ContributionTransferView {
  localId: string;
  prepared: PreparedPluginContribution;
  stage: 'prepared' | 'uploading' | 'processing' | 'complete';
  operation: ContributionOperation | null;
  errorCode: string | null;
}
/** A server-recorded decision; unread is only this account's local reading state. */
export interface PluginReviewUpdate {
  pluginId: string;
  key: string;
  releaseId: string;
  version: string;
  sha256: string;
  revision: string;
  status: 'approved' | 'rejected';
  decidedAt: string;
  unread: boolean;
}
export interface PluginContributionsApi {
  reviewUpdates(): Promise<PluginReviewUpdate[]>;
  markReviewRead(pluginId: string, key: string): Promise<void>;
  prepare(
    instanceId: string,
    expected?: ContributionInstallationBinding,
  ): Promise<PreparedPluginContribution>;
  submit(preparedId: string): Promise<ContributionTransferView>;
  status(localId: string): Promise<ContributionTransferView>;
  cancel(localId: string): Promise<void>;
  cancelReview(
    pluginId: string,
    release: { releaseId: string; sha256: string; revision: string },
  ): Promise<ContributionReleaseView>;
  discard(preparedId: string): Promise<void>;
  list(input: {
    query: string;
    filter: MyPluginFilter;
    cursor?: string;
  }): Promise<MyPluginPageView>;
  submission(pluginId: string, submissionId: string): Promise<ContributionReleaseView>;
  releases(pluginId: string, cursor?: string): Promise<MyPluginReleasePageView>;
  detail(pluginId: string, cursor?: string): Promise<MyPluginDetailView>;
  setAnonymity(pluginId: string, anonymous: boolean): Promise<MyPluginDetailView>;
}
