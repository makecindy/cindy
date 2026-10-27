import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ContributionRequest } from '../../shared/pluginContributionContract.js';
import type {
  PreparedPluginContribution,
  ContributionInstallationBinding,
} from '../../shared/pluginContributions.js';
import { ghostInstallApprovalToken, isUserInstallReservedGhostId } from '../../shared/ghost.js';
import { findInstalledGhostByInstanceId } from '../../shared/pluginIdentity.js';
import { app } from 'electron';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { getAuthState, getActiveAuthRealm } from '../authManager.js';
import { getGhostManager } from '../cindy-brain/index.js';
import { snapshotInstalledGhostPackage } from '../cindy-brain/exportGhostPackage.js';
import { PluginMarketLedger } from '../plugin-market/ledger.js';
import { onQuit } from '../lifecycle.js';
import { throwIpcError } from '../utils/ipcValidate.js';

export function contributionAccountKey(): string {
  const state = getAuthState();
  const session = getActiveAppSession();
  return JSON.stringify([session.mode, session.dataOwnerId, getActiveAuthRealm(), state.user?.id]);
}

export function contributionOwnerKey(): string {
  const state = getAuthState();
  if (
    isAppSessionBoundaryPending() ||
    !state.isAuthenticated ||
    !state.user ||
    (state.user.membershipKind !== 'personal' && state.user.membershipKind !== 'org')
  ) {
    throwIpcError('PERMISSION_DENIED', 'Signed-in account required for community contributions');
  }
  return JSON.stringify([activeOwnerScopeKey(), getActiveAuthRealm(), state.user.id]);
}

export function assertContributionOwner(owner: string): void {
  if (contributionOwnerKey() !== owner)
    throwIpcError('OWNER_CHANGED', 'Contribution account changed');
}

export interface PreparedEntry {
  request?: ContributionRequest;
  owner: string;
  approvalToken: string;
  contentSha256: string;
  installationDir: string;
  publishingSourceKey: string;
  pinned: boolean;
  directory: string;
  filePath: string;
  summary: PreparedPluginContribution;
  /** An idempotency key for this fixed package submission. */
  idempotencyKey: string;
  expiresAt: number;
}

const entries = new Map<string, PreparedEntry>();
const TTL_MS = 30 * 60_000;

/** Source and approval are independent gates. Neither proves code authorship. */
export function readContributionInstallation(instanceId: string, expected?: ContributionInstallationBinding) {
  const ghost = findInstalledGhostByInstanceId(getGhostManager().list(), instanceId);
  if (!ghost) throwIpcError('NOT_FOUND', 'Installed plugin not found');
  if (expected && (ghost.dir !== expected.directory || ghostInstallApprovalToken(ghost.approval) !== expected.approvalToken))
    throwIpcError('PRECONDITION_FAILED', 'Original installed plugin no longer matches this account');
  if (ghost.namespace === null && ghost.publishingSource?.kind === 'public-market' && ghost.trust?.level === 'cindy-official')
    throwIpcError('OFFICIAL_PLUGIN_GITHUB_REQUIRED', 'Submit official public plugins through GitHub to keep repository source complete and maintainable');
  if (ghost.approval.state !== 'approved' || ghost.namespaceState !== 'confirmed' || ghost.namespace !== null ||
    ghost.builtin || isUserInstallReservedGhostId(ghost.manifest.id))
    throwIpcError('PERMISSION_DENIED', 'Only an approved, non-reserved root installation can be published');
  const record = new PluginMarketLedger(ownerScopedUserDataPath('plugin-market', 'ledger.v1.json'))
    .installationForAuthorization({ ghostId: ghost.manifest.id, namespace: null });
  if (record && (record.scope !== 'public' || record.organizationId !== null))
    throwIpcError('PERMISSION_DENIED', 'Private plugin resources cannot be converted to public');
  if (record?.installed && record.source !== 'market' && record.source !== 'legacy-adopted')
    throwIpcError('PERMISSION_DENIED', 'Custom market installation does not grant publishing permission');
  const source = ghost.publishingSource;
  if (!source || source.kind === 'unavailable')
    throwIpcError('PERMISSION_DENIED', 'Publishing source could not be verified');
  return { ghost, source };
}

async function prune(): Promise<void> {
  const owner = contributionOwnerKey();
  for (const [id, entry] of entries) {
    if (entry.pinned || (entry.owner === owner && entry.expiresAt > Date.now())) continue;
    entries.delete(id);
    await fs.rm(entry.directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Never accepts a source path. Main resolves the exact approved installation. */
export async function prepareInstalledContribution(
  instanceId: string,
  _source: 'manual' | 'ai' = 'manual',
  expected?: ContributionInstallationBinding,
): Promise<PreparedPluginContribution> {
  // Host records the source on its request; the byte snapshot is source independent.
  void _source;
  const owner = contributionOwnerKey();
  // Every caller owns its own preview. A disposed StrictMode render must not
  // discard another caller's identical package or idempotency key.
  return prepare(owner, instanceId, expected);
}

async function prepare(
  owner: string,
  instanceId: string,
  expected?: ContributionInstallationBinding,
): Promise<PreparedPluginContribution> {
  await prune();
  assertContributionOwner(owner);
  if ([...entries.values()].filter((entry) => entry.owner === owner && !entry.pinned).length >= 8)
    throwIpcError('PRECONDITION_FAILED', 'Too many prepared contributions');
  const manager = getGhostManager();
  const { ghost, source } = readContributionInstallation(instanceId, expected);
  const approval = ghostInstallApprovalToken(ghost.approval);
  const snapshot = await snapshotInstalledGhostPackage(instanceId, {
    listInstalled: () => [ghost],
  });
  assertContributionOwner(owner);
  if (snapshot.status !== 'prepared')
    throwIpcError('PRECONDITION_FAILED', 'Plugin package could not be prepared');
  const directory = await fs.mkdtemp(path.join(app.getPath('temp'), 'cindy-contribution-'));
  const filePath = path.join(directory, 'plugin.cindy');
  try {
    await fs.writeFile(filePath, snapshot.bytes, { flag: 'wx', mode: 0o600 });
    const inspected = await manager.inspect(filePath);
    assertContributionOwner(owner);
    if ('rejection' in inspected)
      throwIpcError('PRECONDITION_FAILED', 'Plugin package validation failed');
    const current = readContributionInstallation(instanceId).ghost;
    if (
      !current ||
      current.dir !== ghost.dir ||
      ghostInstallApprovalToken(current.approval) !== approval ||
      current.namespaceState !== 'confirmed' ||
      current.namespace !== null ||
      JSON.stringify(current.publishingSource) !== JSON.stringify(source) ||
      inspected.canonicalManifest.id !== ghost.manifest.id ||
      inspected.canonicalManifest.version !== ghost.manifest.version
    ) {
      throwIpcError('PRECONDITION_FAILED', 'Installed plugin changed while preparing');
    }
    const sha256 = crypto.createHash('sha256').update(snapshot.bytes).digest('hex');
    if (sha256 !== inspected.packageSha256)
      throwIpcError('PRECONDITION_FAILED', 'Package checksum changed');
    const preparedId = crypto.randomUUID();
    const expiresAt = Date.now() + TTL_MS;
    const manifest = inspected.canonicalManifest;
    const summary: PreparedPluginContribution = {
      preparedId,
      instanceId,
      pluginId: source.kind === 'public-market' ? source.pluginId : null,
      ghostId: manifest.id,
      name: manifest.name,
      description: manifest.description ?? '',
      version: manifest.version,
      releaseNotes: manifest.releaseNotes,
      sha256,
      sizeBytes: snapshot.bytes.byteLength,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    // Another caller may have filled the last slot during the asynchronous work.
    if ([...entries.values()].filter((entry) => entry.owner === owner && !entry.pinned).length >= 8)
      throwIpcError('PRECONDITION_FAILED', 'Too many prepared contributions');
    entries.set(preparedId, {
      owner,
      approvalToken: approval,
      contentSha256: snapshot.contentSha256,
      installationDir: ghost.dir,
      publishingSourceKey: JSON.stringify(source),
      pinned: false,
      directory,
      filePath,
      summary,
      idempotencyKey: crypto.randomUUID(),
      expiresAt,
    });
    const timer = setTimeout(() => {
      const entry = entries.get(preparedId);
      if (!entry || entry.pinned) return;
      entries.delete(preparedId);
      void fs.rm(entry.directory, { recursive: true, force: true }).catch(() => undefined);
    }, TTL_MS);
    timer.unref();
    return summary;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function getPreparedContribution(preparedId: string): PreparedEntry {
  const entry = entries.get(preparedId);
  if (!entry || entry.expiresAt <= Date.now())
    throwIpcError('PRECONDITION_FAILED', 'Prepared contribution expired');
  assertContributionOwner(entry.owner);
  return entry;
}

export function assertPreparedInstallation(entry: PreparedEntry): void {
  assertContributionOwner(entry.owner);
  const current = readContributionInstallation(entry.summary.instanceId).ghost;
  if (
    !current ||
    current.dir !== entry.installationDir ||
    current.namespace !== null ||
    current.namespaceState !== 'confirmed' ||
    ghostInstallApprovalToken(current.approval) !== entry.approvalToken ||
    JSON.stringify(current.publishingSource) !== entry.publishingSourceKey
  ) {
    throwIpcError('PRECONDITION_FAILED', 'Installed plugin changed; prepare again explicitly');
  }
}

export async function assertPreparedContent(entry: PreparedEntry): Promise<void> {
  assertPreparedInstallation(entry);
  const snapshot = await snapshotInstalledGhostPackage(entry.summary.instanceId, {
    listInstalled: () => getGhostManager().list(),
  });
  assertPreparedInstallation(entry);
  if (
    snapshot.status !== 'prepared' ||
    !entry.contentSha256 ||
    snapshot.contentSha256 !== entry.contentSha256
  ) {
    throwIpcError(
      'CONTRIBUTION_PACKAGE_CHANGED',
      'Installed plugin changed after the publishing summary was shown; refresh before submitting',
    );
  }
}

export async function releasePreparedContribution(preparedId: string): Promise<void> {
  const entry = entries.get(preparedId);
  if (!entry) return;
  entries.delete(preparedId);
  await fs.rm(entry.directory, { recursive: true, force: true }).catch(() => undefined);
}

onQuit('plugin-contribution-previews', async () => {
  await Promise.all([...entries.keys()].map(releasePreparedContribution));
}, 'async');
