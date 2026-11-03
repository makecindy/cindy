import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from 'electron';
import {
  isLocalPluginSnapshotId, parseLocalPluginShareCheck, parseLocalPluginShareDownload, parseLocalPluginShareSnapshot, parseLocalPluginShareUpload, type LocalPluginShareSnapshot,
} from '@cindy/plugin-protocol';
import { ghostInstallApprovalToken, isGhostInstallApprovalToken, isUserInstallReservedGhostId } from '../../shared/ghost.js';
import { findInstalledGhostByInstanceId } from '../../shared/pluginIdentity.js';
import type { LocalPluginShareBinding, SharePreparation, ShareOptions } from '../../shared/share.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import * as auth from '../authManager.js';
import { getGhostManager, installLocalPluginSharePackage } from '../cindy-brain/index.js';
import type { GhostInstallConsentPrompt } from '../cindy-brain/ghostInstallConsent.js';
import { inspectInstalledGhostPackageContent, snapshotInstalledGhostPackage } from '../cindy-brain/exportGhostPackage.js';
import { getBuildClientEndpoint } from '../clientEndpointsService.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { onQuit } from '../lifecycle.js';
import { PluginPublisherPutError, putLocalFile } from '../plugin-publisher/putObject.js';
import { serverApiFetch, ServerApiError } from '../serverApiClient.js';
import { rememberIssuedClipboardText } from '../textClipboard.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { pluginObjectUrlOptions } from './objectUrlPolicy.js';
import { downloadVerifiedPlugin } from './download.js';

const TTL_MS = 30 * 60_000;
class LocalShareContentChangedError extends Error {}
function ownerKey(): string {
  const state = auth.getAuthState();
  if (isAppSessionBoundaryPending() || !state.isAuthenticated || !state.user)
    throwIpcError('ACCOUNT_REAUTH_REQUIRED', 'Sign in to share a local plugin');
  return JSON.stringify([activeOwnerScopeKey(), state.ownerGeneration, auth.getActiveAuthRealm(), state.user.id]);
}
function accessForOwner() {
  const owner = ownerKey();
  const realm = auth.getActiveAuthRealm();
  const endpoints = { plugin: getBuildClientEndpoint('pluginApiBaseUrl'), share: getBuildClientEndpoint('shareBaseUrl') };
  if (!endpoints.plugin) throwIpcError('SHARE_NOT_CONFIGURED', 'Local plugin sharing is not configured');
  const assertCurrent = () => {
    if (ownerKey() !== owner) throwIpcError('OWNER_CHANGED', 'Local share account changed');
  };
  return {
    owner, realm, assertCurrent, shareBaseUrl: endpoints.share,
    async request(service: 'plugin' | 'share', route: string, method = 'GET', body?: unknown) {
      if (!endpoints[service]) throwIpcError('SHARE_NOT_CONFIGURED', 'Sharing is not configured');
      const run = async () => {
        assertCurrent();
        const token = auth.getAccessToken();
        if (!token) throwIpcError('ACCOUNT_REAUTH_REQUIRED', 'Sign in to access a local share');
        const value = await serverApiFetch<unknown>(route, {
          baseUrl: endpoints[service], token, method, body, cache: 'no-store', timeoutMs: 20_000,
          headers: { 'x-cindy-version': app.getVersion(), 'X-Cindy-Auth-Realm': realm },
          skipAutoRefresh: true, skipSessionInvalidation: true, redactErrorDetails: true,
          allowedRedactedErrorCodes: ['TOKEN_EXPIRED', 'LOCAL_SHARE_UPLOAD_INCOMPLETE'],
          logLabel: service === 'plugin' ? '/api/local-plugin-shares' : '/api/shares',
        });
        assertCurrent(); return value;
      };
      try { return await run(); }
      catch (error) {
        assertCurrent();
        if (error instanceof ServerApiError && error.statusCode === 401 && error.code === 'TOKEN_EXPIRED') {
          if (!(await auth.refresh())) throw error;
          assertCurrent(); return run();
        }
        throw error;
      }
    },
  };
}

function localInstallation(instanceId: string) {
  const ghost = findInstalledGhostByInstanceId(getGhostManager().list(), instanceId);
  if (!ghost) throwIpcError('NOT_FOUND', 'Local plugin not found');
  if (ghost.builtin || isUserInstallReservedGhostId(ghost.manifest.id) || ghost.namespaceState !== 'confirmed' ||
      ghost.namespace !== null || ghost.approval.state !== 'approved' || ghost.publishingSource?.kind !== 'local')
    throwIpcError('PERMISSION_DENIED', 'Only a verified local plugin can use local sharing');
  return ghost;
}

interface Bundle { directory: string; filePath: string; sha256: string; sizeBytes: number; ghostId: string; version: string }
function clickedInstallation(instanceId: string, expected: LocalPluginShareBinding) {
  const ghost = localInstallation(instanceId);
  if (ghostInstallApprovalToken(ghost.approval) !== expected.approvalToken || ghost.manifest.version !== expected.version)
    throw new LocalShareContentChangedError();
  return ghost;
}
async function freezePackage(instanceId: string, expected: LocalPluginShareBinding, contentSha256: string, assertCurrent: () => void): Promise<Bundle> {
  assertCurrent();
  const ghost = clickedInstallation(instanceId, expected);
  const approval = ghostInstallApprovalToken(ghost.approval);
  const snapshot = await snapshotInstalledGhostPackage(instanceId, { listInstalled: () => [ghost] });
  assertCurrent();
  if (snapshot.status !== 'prepared') throwIpcError('PRECONDITION_FAILED', 'Local plugin could not be packaged');
  if (snapshot.shareContentSha256 !== contentSha256) throw new LocalShareContentChangedError();
  const directory = await fs.mkdtemp(path.join(app.getPath('temp'), 'cindy-local-share-'));
  const filePath = path.join(directory, 'plugin.cindy');
  try {
    await fs.writeFile(filePath, snapshot.bytes, { flag: 'wx', mode: 0o600 });
    const inspected = await getGhostManager().inspect(filePath, 'stored-release');
    assertCurrent();
    const current = localInstallation(instanceId);
    const sha256 = createHash('sha256').update(snapshot.bytes).digest('hex');
    if (current.dir !== ghost.dir || ghostInstallApprovalToken(current.approval) !== approval)
      throw new LocalShareContentChangedError();
    if ('rejection' in inspected ||
        inspected.packageSha256 !== sha256 || inspected.canonicalManifest.id !== ghost.manifest.id ||
        inspected.canonicalManifest.version !== ghost.manifest.version)
      throwIpcError('PRECONDITION_FAILED', 'Local plugin changed while packaging');
    return { directory, filePath, sha256, sizeBytes: snapshot.bytes.length, ghostId: ghost.manifest.id, version: ghost.manifest.version };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

interface Operation {
  caller: number; id: string; instanceId: string; access: ReturnType<typeof accessForOwner>;
  expected: LocalPluginShareBinding;
  invalidated?: boolean;
  content?: { sha256: string; ghostId: string };
  checked?: boolean; checking?: Promise<LocalPluginShareSnapshot | undefined>;
  bundle?: Bundle; preparing?: Promise<Bundle>; uploading?: Promise<LocalPluginShareSnapshot>;
  snapshot?: LocalPluginShareSnapshot; timer: ReturnType<typeof setTimeout>;
}
const operations = new Map<string, Operation>();
const keyFor = (caller: number, id: string) => `${caller}:${id}`;

async function cleanup(operation: Operation) {
  if (operation.bundle) await fs.rm(operation.bundle.directory, { recursive: true, force: true }).catch(() => undefined);
}
export async function releaseLocalPluginShare(caller: number, id: string): Promise<void> {
  const key = keyFor(caller, id);
  const operation = operations.get(key);
  if (!operation) return;
  operations.delete(key); clearTimeout(operation.timer);
  await operation.checking?.catch(() => undefined);
  await operation.uploading?.catch(() => undefined);
  await operation.preparing?.catch(() => undefined);
  await cleanup(operation);
}
export async function releaseLocalPluginSharesForCaller(caller: number): Promise<void> {
  await Promise.all([...operations.values()].filter(value => value.caller === caller).map(value => releaseLocalPluginShare(caller, value.id)));
}

function bindOperationSnapshot(snapshot: LocalPluginShareSnapshot, operation: Operation, id?: string) {
  if (snapshot.contentSha256 !== operation.content?.sha256 || snapshot.ghostId !== operation.content?.ghostId ||
      snapshot.version !== operation.expected.version || (id && snapshot.snapshotId !== id))
    throwIpcError('PRECONDITION_FAILED', 'Local share does not match the checked content');
  // The server may retain another ZIP encoding of the same verified content.
  // Once selected, that exact ZIP remains fixed for this operation's material.
  if (operation.snapshot && (snapshot.sha256 !== operation.snapshot.sha256 || snapshot.sizeBytes !== operation.snapshot.sizeBytes))
    throwIpcError('PRECONDITION_FAILED', 'Local share does not match the selected package');
  return snapshot;
}

async function checkContent(operation: Operation): Promise<LocalPluginShareSnapshot | undefined> {
  operation.access.assertCurrent();
  const ghost = clickedInstallation(operation.instanceId, operation.expected);
  const content = await inspectInstalledGhostPackageContent(operation.instanceId, { listInstalled: () => [ghost] });
  operation.access.assertCurrent();
  if (content.status !== 'prepared' || clickedInstallation(operation.instanceId, operation.expected).dir !== ghost.dir)
    throwIpcError('PRECONDITION_FAILED', 'Local plugin changed while checking');
  if (operation.content && operation.content.sha256 !== content.contentSha256) throw new LocalShareContentChangedError();
  operation.content = { sha256: content.contentSha256, ghostId: ghost.manifest.id };
  const checked = parseLocalPluginShareCheck(await operation.access.request('plugin', '/api/local-plugin-shares/check', 'POST', {
    operationId: operation.id, contentSha256: content.contentSha256,
  }));
  if (checked.contentSha256 !== content.contentSha256)
    throwIpcError('PRECONDITION_FAILED', 'Local share content identity changed');
  return checked.status === 'ready' ? bindOperationSnapshot(checked.snapshot, operation) : undefined;
}

async function upload(operation: Operation): Promise<LocalPluginShareSnapshot> {
  if (!operation.preparing) operation.preparing = freezePackage(operation.instanceId, operation.expected, operation.content!.sha256, operation.access.assertCurrent)
    .then(bundle => { operation.bundle = bundle; return bundle; });
  const bundle = await operation.preparing;
  const request = operation.access.request;
  const options = pluginObjectUrlOptions();
  const prepared = parseLocalPluginShareUpload(await request('plugin', '/api/local-plugin-shares/uploads', 'POST', {
    operationId: operation.id, sha256: bundle.sha256, sizeBytes: bundle.sizeBytes, contentSha256: operation.content!.sha256,
  }), options);
  if (prepared.status === 'ready') return bindOperationSnapshot(prepared.snapshot!, operation);
  if (prepared.status === 'uploading') {
    if (!prepared.putUrl || !prepared.headers || new Date(prepared.expiresAt).getTime() <= Date.now())
      throwIpcError('PRECONDITION_FAILED', 'Local share upload expired');
    const handle = await fs.open(bundle.filePath, 'r');
    try {
      operation.access.assertCurrent();
      await putLocalFile(handle, { putUrl: prepared.putUrl, headers: prepared.headers, sizeBytes: bundle.sizeBytes });
    } catch (error) {
      if (!(error instanceof PluginPublisherPutError) || error.disposition !== 'commit_same_upload') throw error;
      // The PUT may have completed: commit this operation before deciding to resend.
    } finally { await handle.close(); }
  } else if (prepared.status !== 'validating') throwIpcError('PRECONDITION_FAILED', 'Local share upload is unavailable');
  let progress = parseLocalPluginShareUpload(await request('plugin', `/api/local-plugin-shares/uploads/${prepared.snapshotId}/commit`, 'POST'));
  for (let attempt = 0; progress.status === 'validating' && attempt < 30; attempt++) {
    await delay(1000);
    operation.access.assertCurrent();
    progress = parseLocalPluginShareUpload(await request('plugin', `/api/local-plugin-shares/uploads/${prepared.snapshotId}`));
  }
  if (progress.status !== 'ready' || progress.snapshotId !== prepared.snapshotId)
    throwIpcError('PRECONDITION_FAILED', 'Local share has not completed');
  return bindOperationSnapshot(progress.snapshot!, operation, prepared.snapshotId);
}

/** Exact instance + per-dialog operation; never accepts filesystem paths or publish targets. */
export async function prepareLocalPluginShare(caller: number, instanceId: string, id: string, options: ShareOptions, expected: LocalPluginShareBinding, uploadConfirmed: boolean): Promise<SharePreparation> {
  if (!Number.isSafeInteger(caller) || caller <= 0 || typeof instanceId !== 'string' || instanceId.length > 256 ||
      typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(id) || !options || typeof options !== 'object' ||
      Array.isArray(options) || typeof options.includeAttribution !== 'boolean' || Object.keys(options).some(key => key !== 'includeAttribution') ||
      !expected || typeof expected !== 'object' || Array.isArray(expected) || typeof expected.version !== 'string' ||
      expected.version.length === 0 || expected.version.length > 128 || !isGhostInstallApprovalToken(expected.approvalToken) ||
      Object.keys(expected).some(key => !['version', 'approvalToken'].includes(key)) || typeof uploadConfirmed !== 'boolean')
    throwIpcError('INVALID_PARAMS', 'Invalid local share request');
  const access = accessForOwner();
  if (!access.shareBaseUrl) throwIpcError('SHARE_NOT_CONFIGURED', 'Local plugin sharing is not configured');
  const key = keyFor(caller, id);
  let operation = operations.get(key);
  if (operation && (operation.access.owner !== access.owner || operation.instanceId !== instanceId))
    throwIpcError('OWNER_CHANGED', 'Local share belongs to another owner or instance');
  if (!operation) {
    if (uploadConfirmed)
      throwIpcError('PRECONDITION_FAILED', 'Local share confirmation expired; reopen sharing to check it again');
    if ([...operations.values()].filter(value => value.caller === caller).length >= 8)
      throwIpcError('PRECONDITION_FAILED', 'Too many local share operations');
    const timer = setTimeout(() => { void releaseLocalPluginShare(caller, id); }, TTL_MS);
    timer.unref();
    operation = { caller, id, instanceId, access, expected: { ...expected }, timer };
    operations.set(key, operation);
  }
  try {
    if (operation.invalidated || operation.expected.version !== expected.version || operation.expected.approvalToken !== expected.approvalToken)
      throw new LocalShareContentChangedError();
    if (!operation.checked) {
      operation.checking ??= checkContent(operation);
      try {
        operation.snapshot = await operation.checking;
        operation.checked = true;
      } catch (error) { operation.checking = undefined; throw error; }
    }
    if (!operation.snapshot && !uploadConfirmed) return { confirmationRequired: true };
    if (!operation.snapshot) {
      operation.uploading ??= upload(operation);
      try { operation.snapshot = await operation.uploading; }
      catch (error) { operation.uploading = undefined; if (!operation.bundle) operation.preparing = undefined; throw error; }
      await cleanup(operation);
    }
    operation.access.assertCurrent();
    const region = CURRENT_CINDY_REGION === 'global' ? 'global' : 'cn';
    const raw = await operation.access.request('share', '/api/shares', 'POST', {
      kind: 'local-plugin', reference: operation.snapshot.snapshotId, includeAttribution: options.includeAttribution,
      authRealm: operation.access.realm, region, lang: region === 'cn' ? 'zh-CN' : 'en',
    });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid share material');
    const row = raw as Record<string, unknown>;
    const snapshot = parseLocalPluginShareSnapshot(row.snapshot);
    bindOperationSnapshot(snapshot, operation, operation.snapshot.snapshotId);
    if (row.schemaVersion !== 1 || row.kind !== 'local-plugin' || row.includeAttribution !== options.includeAttribution ||
        typeof row.shareId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(row.shareId) ||
        row.url !== `${operation.access.shareBaseUrl}/s/${row.shareId}` || typeof row.imageSvg !== 'string' ||
        !row.imageSvg.startsWith('<svg ') || row.imageSvg.length > 1024 * 1024)
      throw new Error('Invalid local share binding');
    operation.access.assertCurrent();
    rememberIssuedClipboardText(row.url as string);
    const attribution = row.attribution && typeof row.attribution === 'object' ? (row.attribution as Record<string, unknown>).displayName : null;
    return { title: snapshot.name, url: row.url as string, imageSvg: row.imageSvg,
      ...(options.includeAttribution && typeof attribution === 'string' && attribution.trim() && attribution.length <= 256
        ? { attribution: { displayName: attribution.trim() } } : {}) };
  } catch (error) {
    operation.access.assertCurrent();
    if (error instanceof LocalShareContentChangedError) {
      operation.invalidated = true;
      throwIpcError('PRECONDITION_FAILED', 'Local plugin content changed; reopen sharing to check it again');
    }
    throwIpcError('SHARE_READ_FAILED', 'Could not prepare this local plugin share');
  }
}

export async function readLocalPluginShare(snapshotId: string): Promise<LocalPluginShareSnapshot> {
  if (!isLocalPluginSnapshotId(snapshotId)) throwIpcError('INVALID_PARAMS', 'Invalid local share ID');
  const access = accessForOwner();
  const snapshot = parseLocalPluginShareSnapshot(await access.request('plugin', `/api/local-plugin-shares/${snapshotId}`));
  if (snapshot.snapshotId !== snapshotId) throwIpcError('PRECONDITION_FAILED', 'Local share identity changed');
  return snapshot;
}

/** Download only the clicked snapshot; the original manual transaction owns consent and placement. */
export async function installLocalPluginShare(snapshotId: string, expected: unknown, prompt: GhostInstallConsentPrompt, assertScope?: () => void) {
  if (!isLocalPluginSnapshotId(snapshotId)) throwIpcError('INVALID_PARAMS', 'Invalid local share ID');
  const snapshot = parseLocalPluginShareSnapshot(expected);
  if (snapshot.snapshotId !== snapshotId) throwIpcError('INVALID_PARAMS', 'Invalid local share binding');
  const access = accessForOwner();
  const assertCurrent = () => { access.assertCurrent(); assertScope?.(); };
  assertCurrent();
  const ticket = parseLocalPluginShareDownload(await access.request('plugin', `/api/local-plugin-shares/${snapshotId}/download`), pluginObjectUrlOptions());
  assertCurrent();
  if (ticket.snapshot.snapshotId !== snapshotId || ticket.snapshot.sha256 !== snapshot.sha256 ||
      ticket.snapshot.sizeBytes !== snapshot.sizeBytes || ticket.snapshot.ghostId !== snapshot.ghostId ||
      ticket.snapshot.version !== snapshot.version || new Date(ticket.expiresAt).getTime() <= Date.now())
    throwIpcError('PRECONDITION_FAILED', 'The shared package changed');
  const directory = await fs.mkdtemp(path.join(app.getPath('temp'), 'cindy-shared-plugin-install-'));
  const filePath = path.join(directory, 'package.cindy');
  try {
    assertCurrent();
    await downloadVerifiedPlugin(ticket.url, { sha256: snapshot.sha256, sizeBytes: snapshot.sizeBytes }, filePath);
    assertCurrent();
    return await installLocalPluginSharePackage(filePath, {
      ghostId: snapshot.ghostId, version: snapshot.version, sha256: snapshot.sha256,
      prompt, assertCurrent,
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

onQuit('local-plugin-share-snapshots', async () => {
  await Promise.all([...operations.values()].map(operation => releaseLocalPluginShare(operation.caller, operation.id)));
}, 'async');
