import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from 'electron';
import { z } from 'zod';
import * as wire from '../../shared/pluginContributionContract.js';
import type {
  ContributionInstallationBinding,
  ContributionReleaseView,
  ContributionTransferView,
  MyPluginDetailView,
  MyPluginFilter,
  MyPluginLocalInstallation,
  MyPluginPageView,
  MyPluginReleasePageView,
  MyPluginView,
} from '../../shared/pluginContributions.js';
import {
  ghostInstallApprovalToken,
  ghostPermissionItems,
  validateGhostManifest,
  type InstalledGhost,
} from '../../shared/ghost.js';
import {
  installedGhostStoragePart,
} from '../../shared/pluginIdentity.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { isPassiveSharedUserDataInstance, onAuthStateChange } from '../authManager.js';
import { getGhostManager } from '../cindy-brain/index.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { onQuit } from '../lifecycle.js';
import { putLocalFile } from '../plugin-publisher/putObject.js';
import { PluginMarketLedger } from '../plugin-market/ledger.js';
import { ServerApiError } from '../serverApiClient.js';
import { isIpcError, isIpcErrorCode } from '../../shared/ipc-errors.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { ContributionApi } from './api.js';
import {
  type PreparedEntry,
  assertContributionOwner,
  assertPreparedInstallation,
  assertPreparedContent,
  contributionAccountKey,
  getPreparedContribution,
  prepareInstalledContribution,
  releasePreparedContribution,
  readContributionInstallation,
} from './prepared.js';

// Only a commit that may have reached the server needs to survive this process.
// Preparing a ticket and uploading bytes do not create a review submission.
const pendingCommitSchema = z.object({
  operationId: z.string(),
  request: wire.contributionRequest,
  instanceId: z.string(),
  installationDir: z.string(),
  approvalToken: z.string(),
  contentSha256: z.string(),
});
type PendingCommit = z.infer<typeof pendingCommitSchema>;
interface Submission {
  entry: PreparedEntry;
  request: wire.ContributionRequest;
  prepared: PreparedEntry['summary'];
  stage: ContributionTransferView['stage'];
  operation: wire.ContributionOperation | null;
  errorCode: string | null;
  controller: AbortController;
}
const submissions = new Map<string, Submission>();
let hooked = false;

function pendingCommitFile(owner: string): string {
  assertContributionOwner(owner);
  const account = crypto.createHash('sha256').update(contributionAccountKey()).digest('hex');
  return ownerScopedUserDataPath('plugin-contributions', `pending-${account}.v1.json`);
}
function pendingCommits(owner: string): PendingCommit[] {
  try {
    return z.array(pendingCommitSchema).parse(JSON.parse(fs.readFileSync(pendingCommitFile(owner), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throwIpcError('PRECONDITION_FAILED', 'Unable to read the unconfirmed submission');
  }
}
function writePendingCommits(owner: string, values: PendingCommit[]): void {
  assertWritableInstance();
  const file = pendingCommitFile(owner);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(values), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function clearPendingCommit(owner: string, operationId: string): void {
  const values = pendingCommits(owner);
  if (values.some(item => item.operationId === operationId))
    writePendingCommits(owner, values.filter(item => item.operationId !== operationId));
}
function view(value: Submission): ContributionTransferView {
  return { localId: value.entry.summary.preparedId, prepared: value.prepared,
    stage: value.stage, operation: value.operation, errorCode: value.errorCode };
}
function currentSubmission(id: string): Submission {
  const value = submissions.get(id);
  if (!value) throwIpcError('NOT_FOUND', 'Current submission not found');
  assertContributionOwner(value.entry.owner);
  return value;
}
function terminal(operation: wire.ContributionOperation): boolean {
  return ['succeeded', 'failed', 'expired'].includes(operation.status);
}
function verifyOperation(operation: wire.ContributionOperation, request: wire.ContributionRequest, operationId?: string): void {
  const receipt = operation.receipt;
  if ((operationId && operation.operationId !== operationId) || (receipt && (
    receipt.uploadedPackage.sha256 !== request.sha256 || receipt.uploadedPackage.sizeBytes !== request.sizeBytes ||
    receipt.ghostId !== request.target.ghostId || receipt.version !== request.target.version ||
    (request.target.pluginId !== null && receipt.pluginId !== request.target.pluginId)
  ))) throwIpcError('PRECONDITION_FAILED', 'Submission receipt does not match the package');
}


function safeCode(error: unknown): string {
  if (isIpcError(error)) return error.code;
  if (
    error instanceof ServerApiError &&
    (wire.CONTRIBUTION_ERROR_CODES as readonly string[]).includes(error.code)
  )
    return error.code;
  return 'INTERNAL';
}
export function mapContributionError(error: unknown): never {
  if (isIpcError(error)) throw error;
  const code = safeCode(error);
  throwIpcError(isIpcErrorCode(code) ? code : 'INTERNAL', 'Community contribution request failed');
}

function assertWritableInstance(): void {
  if (isPassiveSharedUserDataInstance())
    throwIpcError('PRECONDITION_FAILED', 'Use the active Cindy instance for publishing');
}

function assertClientPublishingTarget(plugin: Pick<wire.MyPluginSummary, 'publisherKind'>): void {
  if (plugin.publisherKind === 'official')
    throwIpcError('OFFICIAL_PLUGIN_GITHUB_REQUIRED', 'Submit official public plugins through GitHub to keep repository source complete and maintainable');
}

/** Resolve an existing public target only through a server-authorized identity, never package authorship. */
export async function prepareContribution(
  instanceId: string,
  source: 'manual' | 'ai',
  expected?: ContributionInstallationBinding,
) {
  assertWritableInstance();
  const api = new ContributionApi();
  const initial = readContributionInstallation(instanceId, expected);
  const binding = { directory: initial.ghost.dir, approvalToken: ghostInstallApprovalToken(initial.ghost.approval) };
  const targetId = initial.source.kind === 'public-market' ? initial.source.pluginId : null;
  // A downloaded package needs current publishing ACL BEFORE reading its bytes.
  if (targetId) {
    const target = await api.detail(targetId);
    assertClientPublishingTarget(target.plugin);
    if (!target.plugin.actions.canSubmit || target.plugin.pluginId !== targetId ||
      target.plugin.ghostId !== initial.ghost.manifest.id || target.plugin.namespace !== initial.ghost.namespace)
      throwIpcError('PERMISSION_DENIED', 'Publishing permission required');
    assertContributionOwner(api.owner);
    const current = readContributionInstallation(instanceId, binding);
    if (JSON.stringify(current.source) !== JSON.stringify(initial.source))
      throwIpcError('PRECONDITION_FAILED', 'Publishing source changed');
  }
  // Also bind callers without a Renderer-supplied binding across asynchronous pruning.
  const prepared = await prepareInstalledContribution(instanceId, source, binding);
  const entry = getPreparedContribution(prepared.preparedId);
  try {
    const preflight = await api.preflight({
      pluginId: targetId ?? prepared.pluginId,
      ghostId: prepared.ghostId,
      version: prepared.version,
      hasReleaseNotes: Boolean(prepared.releaseNotes?.trim()),
    });
    assertPreparedInstallation(entry);
    if (preflight.target.pluginId) {
      const target = await api.detail(preflight.target.pluginId);
      assertClientPublishingTarget(target.plugin);
      if (!target.plugin.actions.canSubmit) throwIpcError('PERMISSION_DENIED', 'Publishing permission required');
      assertPreparedInstallation(entry);
    }
    prepared.pluginId = preflight.target.pluginId;
    prepared.preflight = preflight;
    const request: wire.ContributionRequest = {
      sizeBytes: prepared.sizeBytes,
      sha256: prepared.sha256,
      source,
      target: preflight.target,
    };
    entry.request = request;
    return prepared;
  } catch (error) {
    await releasePreparedContribution(prepared.preparedId);
    throw error;
  }
}

export async function discardContribution(preparedId: string): Promise<void> {
  const entry = getPreparedContribution(preparedId);
  // A running submission owns its bytes until the current action finishes.
  if (entry.pinned) return;
  await releasePreparedContribution(preparedId);
}

export async function submitContribution(
  preparedId: string,
  assertCaller?: () => Promise<void>,
): Promise<ContributionTransferView> {
  assertWritableInstance();
  const entry = getPreparedContribution(preparedId);
  assertPreparedInstallation(entry);
  if (!entry.summary.preflight?.actions.canSubmit) {
    const blocker = entry.summary.preflight?.blockers[0];
    throwIpcError(blocker?.code && isIpcErrorCode(blocker.code) ? blocker.code : 'PRECONDITION_FAILED',
      blocker?.message ?? 'Refresh the publishing summary before submitting');
  }
  const request = entry.request;
  if (!request)
    throwIpcError('PRECONDITION_FAILED', 'Prepare this submission before submitting');
  if (entry.pinned) {
    await assertCaller?.();
    assertPreparedInstallation(entry);
    const active = submissions.get(preparedId);
    if (active) return view(active);
    throwIpcError('PRECONDITION_FAILED', 'This submission is already starting');
  }
  // Take ownership before validation yields, so closing the preview cannot
  // discard the bytes that this submission is about to send.
  entry.pinned = true;
  let active: Submission | undefined;
  try {
    await assertPreparedContent(entry);
    await assertCaller?.();
    assertPreparedInstallation(entry);
    active = [...submissions.values()].find(item => item.entry.owner === entry.owner &&
      item.request.target.ghostId === request.target.ghostId && item.stage !== 'complete');
    if (active && (active.entry.contentSha256 !== entry.contentSha256 || active.request.target.version !== entry.summary.version ||
      active.entry.installationDir !== entry.installationDir || active.entry.approvalToken !== entry.approvalToken ||
      active.entry.publishingSourceKey !== entry.publishingSourceKey))
      throwIpcError('PRECONDITION_FAILED', 'A submission for this plugin is already running');
  } catch (error) {
    await releasePreparedContribution(preparedId);
    throw error;
  }
  if (active) {
    if (active.entry !== entry) await releasePreparedContribution(preparedId);
    return view(active);
  }
  const value: Submission = { entry, prepared: entry.summary, request,
    stage: 'prepared', operation: null, errorCode: null, controller: new AbortController() };
  submissions.set(preparedId, value);
  if (!hooked) {
    hooked = true;
    onAuthStateChange(() => {
      for (const item of submissions.values()) {
        try { assertContributionOwner(item.entry.owner); }
        catch { item.controller.abort(); }
      }
    });
    onQuit('plugin-contributions', () => {
      for (const item of submissions.values()) item.controller.abort();
    }, 'sync');
  }
  void submit(value, assertCaller).catch(error => {
    value.errorCode = value.controller.signal.aborted ? 'MUTATION_CANCELLED' : safeCode(error);
  }).finally(() => {
    value.stage = 'complete';
    void releasePreparedContribution(preparedId);
    // A short-lived result lets the current UI/tool finish reading its progress.
    // Published versions and history are read from the server, never this map.
    const timer = setTimeout(() => {
      if (submissions.get(preparedId) === value) submissions.delete(preparedId);
    }, 30 * 60_000);
    timer.unref();
  });
  return view(value);
}

async function submit(value: Submission, assertCaller?: () => Promise<void>): Promise<void> {
  const { entry, controller } = value;
  const api = new ContributionApi();
  const assertCurrent = () => {
    assertContributionOwner(entry.owner);
    if (controller.signal.aborted) throwIpcError('MUTATION_CANCELLED', 'Submission stopped');
    assertWritableInstance();
    assertPreparedInstallation(entry);
  };
  const assertWrite = async () => {
    assertCurrent();
    if (value.request.target.pluginId) {
      const target = await api.detail(value.request.target.pluginId);
      assertClientPublishingTarget(target.plugin);
      if (!target.plugin.actions.canSubmit || target.plugin.pluginId !== value.request.target.pluginId)
        throwIpcError('PERMISSION_DENIED', 'Publishing permission or target changed');
    }
    await assertCaller?.();
    assertCurrent();
  };
  const writer = new ContributionApi(assertWrite);
  const accept = (operation: wire.ContributionOperation, operationId?: string) => {
    assertContributionOwner(entry.owner);
    verifyOperation(operation, value.request, operationId);
    value.operation = operation;
    value.errorCode = operation.failure?.code ?? null;
    if (terminal(operation)) clearPendingCommit(entry.owner, operation.operationId);
  };
  assertCurrent();
  const previous = pendingCommits(entry.owner).find(item => item.request.target.ghostId === value.request.target.ghostId);
  if (previous) {
    const operation = await api.operation(previous.operationId);
    assertCurrent();
    verifyOperation(operation, previous.request, previous.operationId);
    const samePackage = previous.instanceId === entry.summary.instanceId &&
      previous.installationDir === entry.installationDir && previous.approvalToken === entry.approvalToken &&
      previous.contentSha256 === entry.contentSha256 &&
      (previous.request.target.pluginId === value.request.target.pluginId ||
        previous.request.target.pluginId === null && operation.receipt?.pluginId === value.request.target.pluginId) &&
      previous.request.target.version === entry.summary.version;
    if (terminal(operation)) {
      clearPendingCommit(entry.owner, previous.operationId);
      if (operation.status === 'succeeded' && samePackage) {
        value.request = previous.request;
        value.prepared = { ...entry.summary, sha256: previous.request.sha256, sizeBytes: previous.request.sizeBytes };
        accept(operation, previous.operationId);
        return;
      }
    } else {
      if (!samePackage) throwIpcError('INTERNAL', 'Previous submission result is not confirmed');
      value.request = previous.request;
      value.prepared = { ...entry.summary, sha256: previous.request.sha256, sizeBytes: previous.request.sizeBytes };
      accept(operation, previous.operationId);
    }
  }
  if (!value.operation) {
    const response = await writer.prepare(value.request, entry.idempotencyKey);
    assertCurrent();
    const { upload, ...operation } = response;
    accept(wire.contributionOperation.parse(operation));
    if (terminal(operation)) return;
    if (response.status === 'awaiting_upload') {
      if (!upload || new Date(upload.expiresAt).getTime() <= Date.now())
        throwIpcError('PRECONDITION_FAILED', 'Upload ticket expired');
      const url = new URL(upload.putUrl);
      const endpoint = new URL(getClientEndpoint('pluginApiBaseUrl'));
      const localUpload = app.isPackaged === false && endpoint.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) && !endpoint.username && !endpoint.password &&
        url.protocol === 'http:' && url.origin === endpoint.origin && url.pathname === '/dev-local/member-upload' && !url.hash;
      if ((url.protocol !== 'https:' && !localUpload) || url.username || url.password ||
        Object.keys(upload.headers).some(key => /^(authorization|proxy-authorization|cookie)$/i.test(key)))
        throwIpcError('PRECONDITION_FAILED', 'Unsafe upload ticket');
      const handle = await fsp.open(entry.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== value.request.sizeBytes ||
          crypto.createHash('sha256').update(await handle.readFile()).digest('hex') !== value.request.sha256)
          throwIpcError('PRECONDITION_FAILED', 'Prepared package changed');
        await assertWrite();
        value.stage = 'uploading';
        await putLocalFile(handle, { putUrl: upload.putUrl, headers: upload.headers, sizeBytes: stat.size,
          signal: controller.signal,
          onBytes: () => { try { assertCurrent(); } catch { controller.abort(); } },
        });
      } catch (error) {
        // The uploader may have sent the bytes despite losing the response.
        // Commit this same operation; never upload the package a second time.
        if (!(error instanceof Error) || !('disposition' in error) || error.disposition !== 'commit_same_upload') throw error;
      } finally {
        await handle.close();
      }
    }
  }
  assertCurrent();
  const operationId = value.operation!.operationId;
  // No local package history is needed: after PUT, any ambiguous commit can be
  // reconciled using this server operation alone. Never re-upload on that path.
  const values = pendingCommits(entry.owner).filter(item => item.operationId !== operationId);
  values.push({ operationId, request: value.request, instanceId: entry.summary.instanceId,
    installationDir: entry.installationDir, approvalToken: entry.approvalToken, contentSha256: entry.contentSha256 });
  writePendingCommits(entry.owner, values);
  value.stage = 'processing';
  await writer.commit(operationId);
  for (let attempt = 0; attempt < 8; attempt++) {
    assertCurrent();
    accept(await api.operation(operationId), operationId);
    if (terminal(value.operation!)) return;
    await delay(Math.min(1000 * (attempt + 1), 5000), undefined, { signal: controller.signal });
  }
  throwIpcError('INTERNAL', 'Submission result is not confirmed');
}

export function contributionTransferStatus(id: string): ContributionTransferView {
  return view(currentSubmission(id));
}
export function cancelContribution(id: string): void {
  currentSubmission(id).controller.abort();
}

function releaseView(
  value: wire.SubmissionView,
  content: wire.SubmissionContent | null,
): ContributionReleaseView {
  const parsed = content ? validateGhostManifest(content.manifest) : null;
  return {
    submissionId: value.submissionId,
    releaseId: value.releaseId,
    version: value.version,
    sha256: value.revision.sha256,
    revision: value.revision.displayUpdatedAt,
    revisionState: value.revisionState,
    reviewStatus: value.reviewStatus,
    submittedAt: value.submittedAt,
    approvedAt: value.approvedAt,
    cancelledAt: value.cancelledAt,
    canCancelReview: value.actions?.canCancelReview ?? false,
    reviewedAt: value.decidedAt,
    reason: value.reason,
    source: value.source ?? value.publishSource,
    content: content
      ? {
          name: content.manifest.name,
          description: content.manifest.description ?? '',
          iconUrl: content.icon?.url ?? null,
          permissions: parsed?.ok ? ghostPermissionItems(parsed.manifest) : [],
          // Preserve the complete server projection, including capabilities unknown to
          // this client, without inventing current content for historical submissions.
          manifestView: content.manifestView,
        }
      : null,
  };
}
function localPluginInstallation(value: wire.MyPluginSummary): MyPluginLocalInstallation {
  try {
    const manager = getGhostManager();
    manager.assertContributionReadAvailable(value.ghostId);
    const related = manager.list().filter(ghost => ghost.manifest.id === value.ghostId &&
      (ghost.namespace === value.namespace || ghost.namespaceState !== 'confirmed'));
    if (related.length === 0) return { state: 'missing' };
    const matches = related.filter(ghost => {
      if (ghost.namespaceState !== 'confirmed' || ghost.namespace !== value.namespace ||
        ghost.approval.state !== 'approved' || !ghost.publishingSource ||
        ghost.publishingSource.kind === 'unavailable') return false;
      if (ghost.publishingSource.kind === 'local') return true;
      return publicInstallationMatches(value, ghost);
    });
    if (matches.length === 1) {
      const ghost = matches[0];
      return { state: 'installed', instanceId: installedGhostStoragePart(ghost),
        version: ghost.manifest.version, enabled: ghost.enabled,
        origin: ghost.publishingSource?.kind === 'public-market' ? 'public' : 'local' };
    }
    return { state: 'unavailable' };
  } catch {
    return { state: 'unavailable' };
  }
}

function publicInstallationMatches(value: wire.MyPluginSummary, ghost: InstalledGhost): boolean {
  const ledger = new PluginMarketLedger(ownerScopedUserDataPath('plugin-market', 'ledger.v1.json'));
  const lookup = ledger.lookupInstallationForAuthorization({ ghostId: ghost.manifest.id, namespace: ghost.namespace });
  if (lookup.kind !== 'found') return false;
  const record = lookup.record;
  const evidence = getGhostManager().approvedInstallEvidence(installedGhostStoragePart(ghost));
  return Boolean(record.scope === 'public' && record.organizationId === null &&
    (record.source === 'market' || record.source === 'legacy-adopted') &&
    ghost.publishingSource?.kind === 'public-market' && ghost.publishingSource.pluginId === value.pluginId &&
    record.installed && record.pluginId === value.pluginId &&
    record.version === ghost.manifest.version && evidence?.packageSha256 === record.sha256);
}

function pluginView(
  value: wire.MyPluginSummary,
  content: wire.SubmissionContent | null = null,
): MyPluginView {
  const local = localPluginInstallation(value);
  return {
    pluginId: value.pluginId,
    name: value.name,
    displayAuthor: value.displayAuthor ?? null,
    authorSettings: value.authorSettings ?? null,
    publisherKind: value.publisherKind ?? null,
    iconUrl: value.icon?.url ?? null,
    updatedAt: value.updatedAt,
    market: {
      state: value.market.available
        ? 'available'
        : (value.market.unavailableReason ?? 'release_unavailable'),
      version: value.market.currentRelease?.version ?? null,
      releaseId: value.market.currentRelease?.releaseId ?? null,
      reason: value.market.reason ?? null,
    },
    latestSubmission: value.latestSubmission ? releaseView(value.latestSubmission, content) : null,
    actions: { submitUpdate: value.publisherKind !== 'official' && value.actions.canSubmit, viewMarket: value.actions.canViewMarket },
    localInstallation: local,
    localInstanceId: local.state === 'installed' ? local.instanceId : null,
    localVersion: local.state === 'installed' ? local.version : null,
  };
}

export async function listMyPlugins(input: {
  query: string;
  filter: MyPluginFilter;
  cursor?: string;
}): Promise<MyPluginPageView> {
  const result = await new ContributionApi().list({
    ...input,
    filter:
      ({ needs_action: 'action_required', published: 'listed' } as Record<string, string>)[
        input.filter
      ] ?? input.filter,
  });
  return {
    queriedAt: result.queriedAt,
    plugins: result.plugins.map((item) => pluginView(item)),
    nextCursor: result.nextCursor,
  };
}
export async function myPluginDetail(
  pluginId: string,
  cursor?: string,
): Promise<MyPluginDetailView> {
  const api = new ContributionApi();
  const result = await api.detail(pluginId);
  // A later history page has its own read timestamp; never replace the detail
  // market/latest snapshot with fields reconstructed from that event stream.
  const history = cursor ? await api.history(pluginId, cursor) : null;
  return {
    plugin: pluginView(result.plugin, result.latestSubmissionContent),
    queriedAt: result.queriedAt,
    history: history?.events ?? result.history.events,
    nextCursor: history?.nextCursor ?? (history ? null : result.history.nextCursor),
  };
}

export async function setPluginAnonymity(pluginId: string, anonymous: boolean): Promise<MyPluginDetailView> {
  assertWritableInstance();
  const result = await new ContributionApi().setAnonymity(pluginId, anonymous);
  return { plugin: pluginView(result.plugin, result.latestSubmissionContent), queriedAt: result.queriedAt,
    history: result.history.events, nextCursor: result.history.nextCursor };
}

export async function myPluginSubmission(
  pluginId: string,
  submissionId: string,
): Promise<ContributionReleaseView> {
  const result = await new ContributionApi().submission(pluginId, submissionId);
  return {
    ...releaseView(result.submission, result.content),
    uploadedSha256: result.receipt.uploadedPackage.sha256,
    uploadedSizeBytes: result.receipt.uploadedPackage.sizeBytes,
  };
}

export async function myPluginReleases(
  pluginId: string,
  cursor?: string,
): Promise<MyPluginReleasePageView> {
  const result = await new ContributionApi().releases(pluginId, undefined, cursor);
  return {
    releases: result.releases.map((release) => releaseView(release, null)),
    queriedAt: result.queriedAt,
    nextCursor: result.nextCursor,
  };
}

export async function cancelPluginReview(
  pluginId: string,
  release: { releaseId: string; sha256: string; revision: string },
  assertCaller?: () => Promise<void>,
): Promise<ContributionReleaseView> {
  assertWritableInstance();
  const result = await new ContributionApi(assertCaller).cancelReview(pluginId, {
    releaseId: release.releaseId,
    sha256: release.sha256,
    displayUpdatedAt: release.revision,
  });
  return releaseView(result.submission, null);
}

export async function myPluginReviewTarget(pluginId: string, releaseId: string) {
  const api = new ContributionApi();
  const detail = await api.detail(pluginId);
  let cursor: string | undefined;
  do {
    const page = await api.releases(pluginId, undefined, cursor);
    const release = page.releases.find((entry) => entry.releaseId === releaseId);
    if (release) return { name: detail.plugin.name, release: releaseView(release, null) };
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  throwIpcError('NOT_FOUND', 'Plugin version not found');
}
